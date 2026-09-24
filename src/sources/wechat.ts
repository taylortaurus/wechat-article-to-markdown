/**
 * 微信公众号来源：反检测抓取 + 元数据提取 + 图片本地化 + Markdown 转换。
 *
 * 流程（对应 Python 版 `spider_claw/sources/wechat.py`）：
 *  1. Camoufox（Firefox 反指纹浏览器）渲染页面，等待 `#js_content` 后取完整 HTML；
 *  2. 提取标题 / 公众号名 / 发布时间（发布时间藏在页面脚本的 `create_time` 里）；
 *  3. 预处理正文：懒加载图片、代码块 → 占位符、噪声节点移除、图片 URL 收集；
 *  4. HTML → Markdown（共享核心层），还原代码块；
 *  5. 图片本地化（带 `mp.weixin.qq.com` Referer 过防盗链）；
 *  6. 拼接头信息并写入 `<output>/<title>/<title>.md`；
 *  7. 标题缺失视为疑似验证码：保存 `debug.html` 并抛出明确错误。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

import { downloadAllImages } from '../core/images.js';
import { logger } from '../core/logger.js';
import {
  CODE_BLOCK_PLACEHOLDER,
  buildMarkdown,
  convertToMarkdown,
  replaceImageUrls,
  type ArticleMeta,
  type CodeBlock,
} from '../core/markdown.js';
import { collapseWhitespace, toSafeTitle, unescapeHtmlEntities } from '../core/text.js';
import { Source, type FetchOptions } from './base.js';

/** 正文容器等待超时（毫秒）。 */
const CONTENT_WAIT_TIMEOUT_MS = 10_000;
/** 正文出现后再等待一段时间，确保页面内联脚本执行完毕。 */
const POST_LOAD_SETTLE_MS = 2_000;

const WECHAT_HOST = 'mp.weixin.qq.com';

function defaultOutputDir(): string {
  return path.join(process.cwd(), 'output');
}

// --------------------------------------------------------------------------- #
// URL 归一化
// --------------------------------------------------------------------------- #

/**
 * 归一化粘贴进来的微信文章 URL：
 * - 去掉包裹的引号 / 尖括号（复制粘贴常见）；
 * - 还原终端（zsh url-quote-magic 等）自动转义的 `\&`、`\?`；
 * - 解码 HTML 实体（`&amp;` → `&`）；
 * - 裸 `mp.weixin.qq.com/...` 补全 `https://`；
 * - 强制 `https`。
 */
export function normalizeWechatUrl(raw: string): string {
  let s = String(raw ?? '').trim();
  if (!s) return s;

  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('<') && s.endsWith('>')) {
    s = s.slice(1, -1).trim();
  }

  s = s.replace(/\\+([:/&?=#%])/g, '$1');
  s = unescapeHtmlEntities(s);

  if (s.startsWith(`${WECHAT_HOST}/`) || s.startsWith(`//${WECHAT_HOST}/`)) {
    s = `https://${s.replace(/^\/+/, '')}`;
  }

  try {
    const parsed = new URL(s);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.hostname.toLowerCase() === WECHAT_HOST
    ) {
      return `https://${WECHAT_HOST}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // 不是合法 URL：按「原样返回」处理，交由后续校验给出明确报错
  }
  return s;
}

// --------------------------------------------------------------------------- #
// 元数据提取
// --------------------------------------------------------------------------- #

/** Unix 时间戳（秒）→ `YYYY-MM-DD HH:mm:ss`（Asia/Shanghai, UTC+8）。 */
export function formatTimestamp(ts: number): string {
  const d = new Date((ts + 8 * 3600) * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** 从页面 HTML 的内联脚本中提取发布时间。 */
export function extractPublishTime(html: string): string {
  const jsDecode = /create_time\s*:\s*JsDecode\('([^']+)'\)/.exec(html);
  if (jsDecode?.[1] !== undefined) {
    const raw = jsDecode[1];
    // JsDecode('...') 里可能是时间戳，也可能已是可读字符串
    return /^\d+$/.test(raw) ? formatTimestamp(Number(raw)) : raw;
  }

  const quoted = /create_time\s*:\s*'(\d+)'/.exec(html);
  if (quoted?.[1] !== undefined) return formatTimestamp(Number(quoted[1]));

  const loose = /create_time\s*[:=]\s*["']?(\d+)["']?/.exec(html);
  if (loose?.[1] !== undefined) return formatTimestamp(Number(loose[1]));

  return '';
}

export interface WechatMetadata {
  title: string;
  author: string;
  publish_time: string;
}

/** 提取文章元数据：标题、公众号名（作者）、发布时间。 */
export function extractMetadata($: CheerioAPI, html: string): WechatMetadata {
  return {
    title: collapseWhitespace($('#activity-name').first().text()),
    author: collapseWhitespace($('#js_name').first().text()),
    publish_time: extractPublishTime(html),
  };
}

// --------------------------------------------------------------------------- #
// 正文预处理
// --------------------------------------------------------------------------- #

export interface ProcessedContent {
  /** 处理后的正文 HTML（未转 Markdown）。 */
  html: string;
  /** 抽出的代码块（正文中被替换为占位符）。 */
  codeBlocks: CodeBlock[];
  /** 正文中的图片 URL（已去重，顺序保留）。 */
  imgUrls: string[];
}

/** CSS counter 在 `code` 文本里泄漏出的垃圾行，如 `counter(line1)`。 */
const COUNTER_LEAK_RE = /^[ce]?ounter\(line/;

/** 正文中的噪声节点选择器。 */
const NOISE_SELECTORS = ['script', 'style', '.qr_code_pc', '.reward_area'];

/**
 * 预处理正文 DOM：修复懒加载图片、处理代码块、移除噪声元素。
 *
 * 注意：`#js_content` 不存在时返回空结果，由调用方决定如何报错。
 */
export function processContent($: CheerioAPI): ProcessedContent {
  const content = $('#js_content').first();
  if (content.length === 0) return { html: '', codeBlocks: [], imgUrls: [] };

  // 1) 懒加载图片：data-src -> src
  content.find('img').each((_i, el) => {
    const dataSrc = $(el).attr('data-src');
    if (dataSrc) $(el).attr('src', dataSrc);
  });

  // 2) 代码块：抽取 (lang, code)，整块替换为占位符供 Markdown 阶段还原
  const codeBlocks: CodeBlock[] = [];
  content.find('.code-snippet__fix').each((_i, el) => {
    const block = $(el);
    block.find('.code-snippet__line-index').remove();
    const lang = block.find('pre[data-lang]').first().attr('data-lang') ?? '';

    const lines: string[] = [];
    block.find('code').each((_j, codeEl) => {
      const text = $(codeEl).text();
      if (COUNTER_LEAK_RE.test(text)) return;
      lines.push(text);
    });

    const code = lines.length > 0 ? lines.join('\n') : block.text();
    const placeholder = `${CODE_BLOCK_PLACEHOLDER}-${codeBlocks.length}`;
    block.replaceWith(`<p>${placeholder}</p>`);
    codeBlocks.push({ lang, code });
  });

  // 3) 移除噪声元素（script/style 与二维码、打赏区等）
  for (const selector of NOISE_SELECTORS) content.find(selector).remove();

  // 4) 收集图片 URL（去重、保序）
  const imgUrls: string[] = [];
  const seen = new Set<string>();
  content.find('img[src]').each((_i, el) => {
    const src = $(el).attr('src');
    if (!src || seen.has(src)) return;
    seen.add(src);
    imgUrls.push(src);
  });

  return { html: $.html(content), codeBlocks, imgUrls };
}

// --------------------------------------------------------------------------- #
// 抓取
// --------------------------------------------------------------------------- #

/** 用 Camoufox 渲染页面并返回完整 HTML。 */
async function fetchHtmlWithCamoufox(url: string): Promise<string> {
  logger.info('🦊 启动 Camoufox 浏览器...');
  // 动态导入：未安装浏览器 / 原生依赖时，不影响其它来源与单元测试
  const { Camoufox } = await import('camoufox-js');
  const browser = await Camoufox({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector('#js_content', { timeout: CONTENT_WAIT_TIMEOUT_MS });
    } catch {
      // 超时也继续尝试解析（部分文章结构不同 / 已触发风控）
    }
    await new Promise((resolve) => setTimeout(resolve, POST_LOAD_SETTLE_MS));
    return await page.content();
  } finally {
    await browser.close();
  }
}

export class WechatSource extends Source {
  readonly name: string = 'wechat';

  override normalize(url: string): string {
    return normalizeWechatUrl(url);
  }

  override match(url: string): boolean {
    try {
      return new URL(url).hostname.toLowerCase() === WECHAT_HOST;
    } catch {
      return false;
    }
  }

  override articleId(url: string): string {
    // 核心路径（去参、去锚点、去尾斜杠）作为微信文章去重键
    return normalizeWechatUrl(url).split('?')[0]!.split('#')[0]!.replace(/\/+$/, '');
  }

  override async fetch(url: string, options: FetchOptions = {}): Promise<string> {
    const outputDir = options.outputDir ?? defaultOutputDir();
    if (!url.startsWith(`https://${WECHAT_HOST}/`)) {
      throw new Error('无效的微信文章 URL (mp.weixin.qq.com)');
    }

    logger.info(`🔄 正在抓取: ${url}`);
    const html = await fetchHtmlWithCamoufox(url);
    const $ = cheerio.load(html);

    const meta: ArticleMeta = extractMetadata($, html);
    if (!meta.title) {
      await mkdir(outputDir, { recursive: true });
      const debugPath = path.join(outputDir, 'debug.html');
      await writeFile(debugPath, html, 'utf8');
      throw new Error(`未能提取到文章标题，可能触发了验证码；已保存原始 HTML 到 ${debugPath}`);
    }

    meta.source_url = url;
    logger.info(`📄 标题: ${meta.title}`);
    logger.info(`👤 作者: ${meta.author}`);
    logger.info(`📅 时间: ${meta.publish_time}`);

    const { html: contentHtml, codeBlocks, imgUrls } = processContent($);
    if (!contentHtml) throw new Error('未能提取到正文内容');

    let md = convertToMarkdown(contentHtml, codeBlocks);

    const safeTitle = toSafeTitle(meta.title);
    const articleDir = path.join(outputDir, safeTitle);
    const imgDir = path.join(articleDir, 'images');
    await mkdir(imgDir, { recursive: true });

    const urlMap = await downloadAllImages(imgUrls, imgDir, {
      proxy: options.proxy ?? 'direct',
      referer: 'https://mp.weixin.qq.com/',
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
const SOURCE = new WechatSource();

export async function fetchArticle(url: string, options: FetchOptions = {}): Promise<string> {
  return SOURCE.fetch(SOURCE.normalize(url), options);
}
