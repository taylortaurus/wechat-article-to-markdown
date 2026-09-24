/**
 * 通用博客来源：基于「站点配置 + 静态 HTTP 抓取」的博客爬取。
 *
 * 设计目标（与 Python 版一致）：作为可扩展的「博客类」来源。
 * - 每个博客站点用一条 `BlogSiteConfig` 描述（域名、站点地图、正文/标题/作者/日期
 *   选择器、去噪规则等）；
 * - `BlogSource` 按域名路由到对应配置，走统一的抓取流程（抓取 → 提取 → 图片本地化
 *   → Markdown 转换）；
 * - 新增博客站点**只需在 `BLOG_SITES` 注册表里加一条配置**，无需改动抓取流程；
 * - 未注册的域名若显式 `--source blog`，会回退到 `DEFAULT_BLOG_CONFIG`（用
 *   readability 做正文提取），可作为通用的「网页文章」兜底。
 *
 * 与微信源的区别：博客多为静态 HTML，不需要 Camoufox 反检测浏览器，直接用 HTTP 抓取。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { JSDOM } from 'jsdom';

import { HttpClient, type ProxyConfig } from '../core/http.js';
import { downloadAllImages } from '../core/images.js';
import { logger } from '../core/logger.js';
import {
  buildMarkdown,
  convertToMarkdown,
  replaceImageUrls,
  type ArticleMeta,
} from '../core/markdown.js';
import { collapseWhitespace, toSafeTitle, unescapeHtmlEntities } from '../core/text.js';
import { Source, type FetchOptions } from './base.js';

/** 静态站点抓取使用的 UA。 */
export const BLOG_USER_AGENT =
  'Mozilla/5.0 (compatible; spider-claw/3.0; +https://github.com/jackwener/wechat-article-to-markdown)';

function defaultOutputDir(): string {
  return path.join(process.cwd(), 'output');
}

// --------------------------------------------------------------------------- #
// 站点配置
// --------------------------------------------------------------------------- #

/** 单个博客站点的抓取规则。新增站点只需补充一条。 */
export interface BlogSiteConfig {
  /** 用于 match / 路由，如 `addyosmani.com`（支持子域）。 */
  domain: string;
  /** 站点地图地址。 */
  sitemapUrl: string;
  /** 正文 CSS 选择器；缺省时优先 `<article>`，否则 readability 兜底。 */
  contentSelector?: string;
  /** 标题选择器（缺省用 og:title / `<title>` / `<h1>`）。 */
  titleSelector?: string;
  /** 作者选择器（缺省用 meta author / JSON-LD）。 */
  authorSelector?: string;
  /** 日期选择器（缺省用 meta / JSON-LD / 首个日期 h2）。 */
  dateSelector?: string;
  /** 部分站点（如 addyosmani）把日期写成正文首个 `<h2>`。 */
  dateIsFirstH2?: boolean;
  /** 站点地图过滤：仅保留 path 以此开头的 URL。 */
  listPathFilter?: string;
  /** 正文中的噪声节点选择器。 */
  removeSelectors?: string[];
}

/** 已配置的博客站点。新增站点在此注册即可。 */
export const BLOG_SITES: Record<string, BlogSiteConfig> = {
  'addyosmani.com': {
    domain: 'addyosmani.com',
    sitemapUrl: 'https://addyosmani.com/sitemap.xml',
    contentSelector: 'article.post',
    dateIsFirstH2: true, // 日期以正文首个 h2 呈现（如 "July 6, 2026"）
    listPathFilter: '/blog/', // 站点地图同时含 /notes/ 等，仅爬 /blog/
    removeSelectors: ['script', 'style'],
  },
};

/** 未注册域名的兜底配置（显式 `--source blog` 时使用，走 readability 通用提取）。 */
export const DEFAULT_BLOG_CONFIG: BlogSiteConfig = { domain: '*', sitemapUrl: '' };

// --------------------------------------------------------------------------- #
// 日期解析
// --------------------------------------------------------------------------- #

const DATE_RE =
  /\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}|[A-Za-z]{3,}\s+\d{1,2},?\s+\d{4})\b/;

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function monthNumber(name: string): number | null {
  const key = name.toLowerCase();
  if (key in MONTHS) return MONTHS[key] ?? null;
  // 月份缩写：Jul / Aug / Sep / Sept …
  for (const [full, value] of Object.entries(MONTHS)) {
    if (full.startsWith(key.slice(0, 3)) && key.length >= 3) return value;
  }
  return null;
}

function formatDateParts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${year}-${pad(month)}-${pad(day)} ` + `${pad(hour)}:${pad(minute)}:${pad(second)}`
  );
}

/** 尽量解析为 `YYYY-MM-DD HH:mm:ss`；无法解析则原样返回。 */
export function parseDate(input: string): string {
  const s = (input ?? '').trim();
  if (!s) return '';

  // 2026-07-06 / 2026/07/06 / 2026-07-06T12:00:00Z / 2026-07-06 12:00:00
  const iso =
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (iso) {
    return formatDateParts(
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
      iso[4] ? Number(iso[4]) : 0,
      iso[5] ? Number(iso[5]) : 0,
      iso[6] ? Number(iso[6]) : 0,
    );
  }

  // July 6, 2026 / Jul 6, 2026
  const monthFirst = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (monthFirst) {
    const month = monthNumber(monthFirst[1]!);
    if (month !== null) return formatDateParts(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }

  // 6 July 2026 / 6 Jul 2026
  const dayFirst = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(s);
  if (dayFirst) {
    const month = monthNumber(dayFirst[2]!);
    if (month !== null) return formatDateParts(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  return s;
}

/** 文本是否「看起来像日期」。 */
export function looksLikeDate(text: string): boolean {
  return DATE_RE.test(text ?? '');
}

// --------------------------------------------------------------------------- #
// HTTP / 站点地图
// --------------------------------------------------------------------------- #

export interface BlogRequestOptions {
  referer?: string;
  proxy?: ProxyConfig;
  timeoutMs?: number;
}

/** 抓取静态 HTML 文本。 */
export async function fetchHtml(url: string, options: BlogRequestOptions = {}): Promise<string> {
  const client = new HttpClient(options.proxy ?? 'direct');
  return client.getText(url, {
    referer: options.referer,
    timeoutMs: options.timeoutMs ?? 20_000,
    headers: { 'User-Agent': BLOG_USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*' },
  });
}

/** 解码站点地图 XML 中的常见实体与 CDATA 包装。 */
export function unescapeSitemap(text: string): string {
  let value = text.trim();
  if (value.startsWith('<![CDATA[') && value.endsWith(']]>')) {
    value = value.slice(9, -3);
  }
  return unescapeHtmlEntities(value);
}

export interface ParseSitemapOptions {
  pathPrefix?: string | null;
  depth?: number;
  proxy?: ProxyConfig;
  /**
   * 抓取函数注入点（默认 `fetchHtml`）。
   *
   * 之所以留这个缝，是因为递归解析子站点地图时需要用「同一个」抓取实现，
   * 单元测试也据此在完全不联网的前提下覆盖嵌套 sitemap。
   */
  fetchText?: (url: string, options: BlogRequestOptions) => Promise<string>;
}

const MAX_SITEMAP_DEPTH = 3;

/** 递归解析站点地图（支持嵌套 sitemap 索引），返回已去重、已过滤的文章 URL。 */
export async function parseSitemap(
  xml: string,
  options: ParseSitemapOptions = {},
): Promise<string[]> {
  const depth = options.depth ?? 0;
  if (depth > MAX_SITEMAP_DEPTH) return [];

  const sitemapLocs = [...xml.matchAll(/<sitemap>\s*<loc>(.*?)<\/loc>/gs)].map((m) =>
    unescapeSitemap(m[1]!),
  );
  const urlLocs = [...xml.matchAll(/<url>\s*<loc>(.*?)<\/loc>/gs)].map((m) =>
    unescapeSitemap(m[1]!),
  );

  const urls: string[] = [];
  for (const candidate of urlLocs) {
    if (!/^https?:/i.test(candidate)) continue;
    if (options.pathPrefix) {
      try {
        if (!new URL(candidate).pathname.startsWith(options.pathPrefix)) continue;
      } catch {
        continue;
      }
    }
    urls.push(candidate);
  }

  const fetchText = options.fetchText ?? fetchHtml;
  for (const subUrl of sitemapLocs) {
    if (!/^https?:/i.test(subUrl)) continue;
    try {
      const subXml = await fetchText(subUrl, { proxy: options.proxy });
      urls.push(...(await parseSitemap(subXml, { ...options, depth: depth + 1 })));
    } catch (e) {
      logger.warn(`  ⚠ 跳过子站点地图 ${subUrl}: ${(e as Error).message}`);
    }
  }

  return [...new Set(urls)].sort();
}

/** 解析站点地图入口，返回文章 URL 列表（可按 path 前缀过滤）。 */
export async function discoverFromSitemap(
  sitemapUrl: string,
  options: ParseSitemapOptions = {},
): Promise<string[]> {
  const fetchText = options.fetchText ?? fetchHtml;
  const xml = await fetchText(sitemapUrl, { proxy: options.proxy });
  return parseSitemap(xml, options);
}

// --------------------------------------------------------------------------- #
// readability 兜底
// --------------------------------------------------------------------------- #

/**
 * 用 Mozilla Readability 抽取正文（未注册站点的兜底路径）。
 *
 * 只在没有 `contentSelector` / `<article>` 时才会被调用，因此 jsdom 的解析开销
 * 不会出现在常规站点上。
 */
export function extractWithReadability(html: string): string | null {
  try {
    const dom = new JSDOM(html);
    const document = dom.window.document as unknown as Document;
    const article = new Readability(document).parse();
    return article?.content ?? null;
  } catch (e) {
    logger.warn(`  ⚠ readability 兜底提取失败: ${(e as Error).message}`);
    return null;
  }
}

// --------------------------------------------------------------------------- #
// 博客来源
// --------------------------------------------------------------------------- #

type JsonObject = Record<string, unknown>;

const ARTICLE_TYPES = new Set([
  'blogposting',
  'article',
  'newsarticle',
  'techarticle',
  'scholarlyarticle',
]);

function isArticleNode(node: unknown): node is JsonObject {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const type = (node as JsonObject)['@type'];
  return typeof type === 'string' && ARTICLE_TYPES.has(type.toLowerCase());
}

export interface ExtractedArticle {
  html: string;
  meta: ArticleMeta;
  imgUrls: string[];
}

export class BlogSource extends Source {
  readonly name: string = 'blog';

  // ---- 路由 / 归一化 ---- #

  /** 按域名取站点配置（未命中返回兜底配置）。 */
  configFor(url: string): BlogSiteConfig {
    let host = '';
    try {
      host = new URL(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    } catch {
      host = '';
    }
    for (const cfg of Object.values(BLOG_SITES)) {
      if (host === cfg.domain || host.endsWith(`.${cfg.domain}`)) return cfg;
    }
    return DEFAULT_BLOG_CONFIG;
  }

  override match(url: string): boolean {
    // 仅对「已注册域名」自动识别，避免抢占未知 URL（未知 URL 需显式 --source blog）
    return this.configFor(url).domain !== '*';
  }

  override normalize(url: string): string {
    const raw = (url ?? '').trim();
    if (!raw) return raw;
    try {
      const parsed = new URL(/^[a-z][\w+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      const pathname = parsed.pathname.replace(/\/+$/, '');
      // 保留 query：WordPress ?p=123、Medium ?source= 等依赖 query 的站点需要
      return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
    } catch {
      return raw;
    }
  }

  override articleId(url: string): string {
    // 以「域名无关的核心路径」作为去重键
    try {
      const parsed = new URL(this.normalize(url));
      return (parsed.pathname || '/').replace(/\/+$/, '') || '/';
    } catch {
      return url;
    }
  }

  // ---- 提取 ---- #

  /** 从 JSON-LD 中找文章节点（含 @graph / 数组形式）。 */
  jsonLd($: CheerioAPI): JsonObject | null {
    for (const el of $('script[type="application/ld+json"]').toArray()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse($(el).text());
      } catch {
        continue;
      }
      if (isArticleNode(parsed)) return parsed;
      if (Array.isArray(parsed)) {
        const hit = parsed.find(isArticleNode);
        if (hit) return hit;
      } else if (parsed && typeof parsed === 'object') {
        const graph = (parsed as JsonObject)['@graph'];
        if (Array.isArray(graph)) {
          const hit = graph.find(isArticleNode);
          if (hit) return hit;
        }
      }
    }
    return null;
  }

  /** 定位正文容器：contentSelector → `<article>` → readability → `<body>`。 */
  selectContentHtml($: CheerioAPI, cfg: BlogSiteConfig): string {
    if (cfg.contentSelector) {
      const el = $(cfg.contentSelector).first();
      if (el.length > 0) return $.html(el) ?? '';
    }
    const article = $('article').first();
    if (article.length > 0) return $.html(article) ?? '';
    const readable = extractWithReadability($.html());
    if (readable) return readable;
    const body = $('body').first();
    return (body.length > 0 ? $.html(body) : $.html()) ?? '';
  }

  title($: CheerioAPI, cfg: BlogSiteConfig): string {
    const og = $('meta[property="og:title"]').first().attr('content');
    if (og?.trim()) return og.trim();
    if (cfg.titleSelector) {
      const el = $(cfg.titleSelector).first();
      if (el.length > 0) return collapseWhitespace(el.text());
    }
    const h1 = $('h1').first();
    if (h1.length > 0) return collapseWhitespace(h1.text());
    const titleEl = $('title').first();
    return titleEl.length > 0 ? collapseWhitespace(titleEl.text()) : '';
  }

  author($: CheerioAPI, cfg: BlogSiteConfig): string {
    const metaAuthor = $('meta[name="author"]').first().attr('content');
    if (metaAuthor?.trim()) return metaAuthor.trim();
    if (cfg.authorSelector) {
      const el = $(cfg.authorSelector).first();
      if (el.length > 0) return collapseWhitespace(el.text());
    }
    const author = this.jsonLd($)?.['author'];
    if (typeof author === 'string') return author.trim();
    if (author && typeof author === 'object') {
      const name = (author as JsonObject)['name'];
      if (typeof name === 'string') return name.trim();
    }
    return '';
  }

  date($: CheerioAPI, cfg: BlogSiteConfig, $content: CheerioAPI): string {
    let value = '';

    const metaDate =
      $('meta[property="article:published_time"]').first().attr('content') ??
      $('meta[property="article:modified_time"]').first().attr('content');
    if (metaDate) value = parseDate(metaDate);

    if (!value && cfg.dateSelector) {
      const inContent = $content(cfg.dateSelector).first();
      const el = inContent.length > 0 ? inContent : $(cfg.dateSelector).first();
      if (el.length > 0) value = parseDate(collapseWhitespace(el.text()));
    }

    if (!value) {
      const published = this.jsonLd($)?.['datePublished'];
      if (typeof published === 'string') value = parseDate(published);
    }

    if (cfg.dateIsFirstH2) {
      // 站点把日期写成正文首个 h2。这里**先剔除这条重复的日期标题**，再决定取值：
      // 无论日期最终来自 meta / JSON-LD / h2，正文顶部都不应再重复出现日期。
      const h2 = $content('h2').first();
      if (h2.length > 0) {
        const text = collapseWhitespace(h2.text());
        if (looksLikeDate(text)) {
          h2.remove();
          if (!value) value = parseDate(text);
        }
      }
    }

    return value;
  }

  /** 抽取正文 HTML、元数据与图片 URL。 */
  extract($: CheerioAPI, cfg: BlogSiteConfig, url: string): ExtractedArticle {
    const selected = this.selectContentHtml($, cfg);
    if (!selected.trim()) throw new Error('未能定位正文内容');

    // 在独立的 cheerio 实例里做「去噪 / 去重标题 / 抽图片」，避免污染原始文档选择器
    const $content = cheerio.load(selected);
    for (const selector of cfg.removeSelectors ?? []) $content(selector).remove();

    const title = this.title($, cfg);
    if (title) {
      const h1 = $content('h1').first();
      if (h1.length > 0 && collapseWhitespace(h1.text()) === title) h1.remove();
    }

    const author = this.author($, cfg);
    const date = this.date($, cfg, $content);

    const imgUrls: string[] = [];
    const seen = new Set<string>();
    $content('img').each((_i, el) => {
      const src = $content(el).attr('src') ?? $content(el).attr('data-src');
      if (!src || src.startsWith('data:') || seen.has(src)) return;
      seen.add(src);
      imgUrls.push(src);
    });

    const meta: ArticleMeta = {
      title,
      author,
      publish_time: date,
      source_url: url,
    };
    return { html: $content('body').html() ?? '', meta, imgUrls };
  }

  // ---- 抓取 ---- #

  override async fetch(url: string, options: FetchOptions = {}): Promise<string> {
    const outputDir = options.outputDir ?? defaultOutputDir();
    const cfg = this.configFor(url);
    const norm = this.normalize(url);
    logger.info(`🔄 正在抓取博客: ${norm}`);

    const html = await fetchHtml(norm, { proxy: options.proxy });
    const $ = cheerio.load(html);
    const { html: contentHtml, meta, imgUrls } = this.extract($, cfg, norm);
    if (!contentHtml.trim()) throw new Error('未能提取到正文内容');

    let md = convertToMarkdown(contentHtml);

    const safeTitle = toSafeTitle(meta.title || norm);
    const articleDir = path.join(outputDir, safeTitle);
    const imgDir = path.join(articleDir, 'images');
    await mkdir(imgDir, { recursive: true });

    const parsed = new URL(norm);
    const referer = `${parsed.protocol}//${parsed.host}`;
    const urlMap = await downloadAllImages(imgUrls, imgDir, {
      proxy: options.proxy ?? 'direct',
      referer,
      articleUrl: norm,
    });
    md = replaceImageUrls(md, urlMap);

    const mdPath = path.join(articleDir, `${safeTitle}.md`);
    await writeFile(mdPath, buildMarkdown(meta, md), 'utf8');
    logger.info(`✅ 已保存: ${mdPath}`);
    logger.info(`📊 Markdown 约 ${md.length} 字符`);
    return mdPath;
  }
}

// 供测试 / 脚本直接调用的模块级函数（自动归一化 URL）
const SOURCE = new BlogSource();

export async function fetchArticle(url: string, options: FetchOptions = {}): Promise<string> {
  return SOURCE.fetch(SOURCE.normalize(url), options);
}
