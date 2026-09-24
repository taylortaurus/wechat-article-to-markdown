/** 博客来源的离线单测（不依赖网络）。 */
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';

import {
  BLOG_SITES,
  BlogSource,
  DEFAULT_BLOG_CONFIG,
  discoverFromSitemap,
  extractWithReadability,
  looksLikeDate,
  parseDate,
  parseSitemap,
} from '../../src/sources/blog';

const SRC = new BlogSource();

describe('路由与归一化', () => {
  it('只对已注册域名自动识别', () => {
    expect(SRC.match('https://addyosmani.com/blog/foo/')).toBe(true);
    expect(SRC.match('https://www.addyosmani.com/blog/foo/')).toBe(true);
    expect(SRC.match('https://example.com/post')).toBe(false);
  });

  it('去重键为域名无关的核心路径', () => {
    expect(SRC.articleId('https://addyosmani.com/blog/foo/?x=1#bar')).toBe('/blog/foo');
  });

  it('归一化保留 query、去掉 fragment 与尾部斜杠', () => {
    expect(SRC.normalize('https://addyosmani.com/blog/foo/?a=1#b')).toBe(
      'https://addyosmani.com/blog/foo?a=1',
    );
  });

  it('未注册域名回退到兜底配置', () => {
    expect(SRC.configFor('https://example.com/post')).toBe(DEFAULT_BLOG_CONFIG);
    expect(SRC.configFor('https://addyosmani.com/blog/x')).toBe(BLOG_SITES['addyosmani.com']);
  });

  it('站点配置使用驼峰字段名', () => {
    const cfg = BLOG_SITES['addyosmani.com']!;
    expect(cfg.sitemapUrl).toBe('https://addyosmani.com/sitemap.xml');
    expect(cfg.listPathFilter).toBe('/blog/');
    expect(cfg.dateIsFirstH2).toBe(true);
  });
});

describe('日期解析', () => {
  it.each([
    ['July 6, 2026', '2026-07-06 00:00:00'],
    ['Jul 6, 2026', '2026-07-06 00:00:00'],
    ['6 July 2026', '2026-07-06 00:00:00'],
    ['2026-07-06', '2026-07-06 00:00:00'],
    ['2026/07/06', '2026-07-06 00:00:00'],
    ['2026-07-06T12:34:56Z', '2026-07-06 12:34:56'],
    ['2026-07-06 12:34:56', '2026-07-06 12:34:56'],
  ])('%s → %s', (input, expected) => {
    expect(parseDate(input)).toBe(expected);
  });

  it('无法解析时原样返回，空串仍为空串', () => {
    expect(parseDate('not a date')).toBe('not a date');
    expect(parseDate('')).toBe('');
  });

  it('looksLikeDate 能识别常见日期写法', () => {
    expect(looksLikeDate('July 6, 2026')).toBe(true);
    expect(looksLikeDate('2026-07-06')).toBe(true);
    expect(looksLikeDate('Hello world')).toBe(false);
  });
});

const SITEMAP = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://addyosmani.com/blog/a/</loc></url>
<url><loc>https://addyosmani.com/notes/x/</loc></url>
<url><loc><![CDATA[https://addyosmani.com/blog/b/]]></loc></url>
</urlset>`;

const SITEMAP_INDEX = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://addyosmani.com/blog-sitemap.xml</loc></sitemap>
</sitemapindex>`;

const SITEMAP_CHILD = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://addyosmani.com/blog/c/</loc></url>
<url><loc>https://addyosmani.com/notes/y/</loc></url>
</urlset>`;

describe('站点地图', () => {
  it('按 path 前缀过滤，并解码 CDATA', async () => {
    const urls = await parseSitemap(SITEMAP, { pathPrefix: '/blog/' });
    expect(urls).toEqual(['https://addyosmani.com/blog/a/', 'https://addyosmani.com/blog/b/']);
  });

  it('递归解析嵌套 sitemap 索引', async () => {
    const fetchText = async (url: string): Promise<string> =>
      url.includes('blog-sitemap') ? SITEMAP_CHILD : SITEMAP_INDEX;

    const urls = await discoverFromSitemap('https://addyosmani.com/sitemap.xml', {
      pathPrefix: '/blog/',
      fetchText,
    });

    expect(urls).toEqual(['https://addyosmani.com/blog/c/']);
  });

  it('子站点地图抓取失败只告警，不影响其它结果', async () => {
    const fetchText = async (url: string): Promise<string> => {
      if (url.includes('blog-sitemap')) throw new Error('boom');
      return SITEMAP_INDEX;
    };

    await expect(
      discoverFromSitemap('https://addyosmani.com/sitemap.xml', { fetchText }),
    ).resolves.toEqual([]);
  });

  it('超过最大递归深度后停止', async () => {
    const urls = await parseSitemap(SITEMAP_INDEX, {
      depth: 4,
      fetchText: async () => SITEMAP_CHILD,
    });
    expect(urls).toEqual([]);
  });
});

describe('正文提取', () => {
  const html = `<html><head>
  <meta property="og:title" content="The Agent-Era Career">
  <meta name="author" content="Addy Osmani">
  </head><body>
  <article class="post">
    <h1>The Agent-Era Career</h1>
    <h2>July 6, 2026</h2>
    <p>Hello world.</p>
    <script>bad()</script>
  </article></body></html>`;

  it('提取标题 / 作者 / 日期，并剔除重复 h1、日期 h2 与噪声', () => {
    const $ = cheerio.load(html);
    const cfg = BLOG_SITES['addyosmani.com']!;
    const { html: content, meta, imgUrls } = SRC.extract(
      $,
      cfg,
      'https://addyosmani.com/blog/x/',
    );

    expect(meta.title).toBe('The Agent-Era Career');
    expect(meta.author).toBe('Addy Osmani');
    expect(meta.publish_time).toBe('2026-07-06 00:00:00');
    expect(meta.source_url).toBe('https://addyosmani.com/blog/x/');
    expect(content).toContain('Hello world.');
    expect(content).not.toContain('July 6, 2026');
    expect(content).not.toContain('<script');
    expect(content).not.toContain('<h1');
    expect(imgUrls).toEqual([]);
  });

  it('日期已从 meta 取到，正文里重复的日期 h2 仍会被剔除', () => {
    const withMetaDate = `<html><head>
    <meta property="og:title" content="T">
    <meta property="article:published_time" content="2026-07-06T09:00:00Z">
    </head><body><article class="post">
      <h1>T</h1><h2>July 6, 2026</h2><p>Hello world.</p>
    </article></body></html>`;

    const $ = cheerio.load(withMetaDate);
    const { html: content, meta } = SRC.extract(
      $,
      BLOG_SITES['addyosmani.com']!,
      'https://addyosmani.com/blog/z/',
    );

    expect(meta.publish_time).toBe('2026-07-06 09:00:00');
    expect(content).toContain('Hello world.');
    expect(content).not.toContain('July 6, 2026');
  });

  it('从 JSON-LD 读取作者与日期', () => {
    const withJsonLd = `<html><head>
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'BlogPosting',
      author: { name: 'Jane Doe' },
      datePublished: '2026-01-02T03:04:05Z',
    })}</script>
    </head><body><article><p>内容</p></article></body></html>`;

    const $ = cheerio.load(withJsonLd);
    const { meta } = SRC.extract($, BLOG_SITES['addyosmani.com']!, 'https://addyosmani.com/blog/y');

    expect(meta.author).toBe('Jane Doe');
    expect(meta.publish_time).toBe('2026-01-02 03:04:05');
  });

  it('未注册域名用 readability 兜底提取正文', () => {
    const paragraphs = Array.from(
      { length: 20 },
      (_v, i) => `<p>段落 ${i}，这是一段足够长的正文内容用于 readability 的启发式判定。</p>`,
    ).join('');
    const page = `<html><head><title>长文</title></head><body><article><h1>长文</h1>${paragraphs}</article></body></html>`;

    const content = extractWithReadability(page);

    expect(content).toBeTruthy();
    expect(content).toContain('段落 0');
  });
});
