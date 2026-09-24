---
name: spider-claw
description: Multi-source article fetcher that converts web articles (WeChat, blogs, Twitter, ...) to Markdown. Routes by URL or --source; supports sitemap bulk-crawl. 多源文章转 Markdown 工具（微信与博客已实现，Twitter 占位，支持站点地图批量爬取）。
author: jackwener
version: "3.0.0"
tags:
  - wechat
  - twitter
  - blog
  - 微信
  - 推特
  - 博客
  - markdown
  - article
  - converter
  - cli
  - batch
  - resume
  - spider-claw
  - typescript
  - node
---

# spider-claw

Fetch articles from multiple sources and convert them to clean Markdown, with
images localized to local files. **WeChat (`mp.weixin.qq.com`) and blogs
(registered domains, e.g. `addyosmani.com`) are fully implemented**; Twitter is a
registered stub (not yet implemented).

Implemented in **TypeScript (Node.js)** — a `spider-claw` CLI plus a typed library API.

## When to use

Use this skill (or a per-source skill under [`skills/`](./skills)) when you need to
save web articles as Markdown for:
- Personal archive
- AI summarization input
- Knowledge base / RAG ingestion
- Batch archiving a list of articles (resume-safe)

## Per-source skills

- [`skills/wechat-to-markdown/`](./skills/wechat-to-markdown) — full WeChat support
- [`skills/blog-to-markdown/`](./skills/blog-to-markdown) — full blog support (sitemap bulk-crawl)
- [`skills/twitter-to-markdown/`](./skills/twitter-to-markdown) — stub (not implemented)

For most tasks, invoke the specific source skill directly; this root skill is the
router/entry point.

## Prerequisites

- **Node.js ≥ 22** (native `fetch`, `AbortSignal.timeout`)
- Camoufox (anti-detection browser) — only for the WeChat source; its browser binary is
  fetched once with `npx camoufox-js fetch`

```bash
# Run directly with the TypeScript source (no install needed) from the project root:
pnpm dev "<ARTICLE_URL>"

# Or install/build the CLI:
npm install -g spider-claw        # global CLI
pnpm install && pnpm build        # then: node dist/cli.js "<ARTICLE_URL>"
spider-claw "<ARTICLE_URL>"
```

## Usage

### Single article (source auto-detected, or forced)

```bash
spider-claw "https://mp.weixin.qq.com/s/XXXXXXXX"
spider-claw --source wechat "https://mp.weixin.qq.com/s/XXXXXXXX"
spider-claw "https://addyosmani.com/blog/career-advice-age-of-agents/"   # blog (auto-detected)
spider-claw --source blog "https://example.com/any/post"                 # any URL (readability fallback)
spider-claw --source twitter "https://twitter.com/xxx/status/123"        # stub → not implemented
```

### Batch mode (url-list.json)

```bash
spider-claw                       # default: ./url-list.json
spider-claw --list my-urls.json
```

Each entry is a string or an object. Objects may carry `source` (defaults to
auto-detect → `wechat`), and after a crawl get `status`, `output`, `updated_at`
written back. Dedup key is `(source, articleId)`, so the same article (even with
different tracking params, or listed twice) is crawled only once.

The process exits with `1` when any entry failed, so callers/CI can detect partial
failures without parsing stdout.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `-o, --output <dir>` | `./output` | Output directory |
| `--list <file>` | `./url-list.json` | URL list for batch mode |
| `--source <name>` | auto | Force a source (`wechat`/`twitter`/`blog`), overriding URL detection |
| `--from-sitemap <sitemapUrl>` | — | Discover blog posts from a sitemap, append to `url-list.json`, and crawl (resume-safe) |
| `--proxy` | off (direct) | Route HTTP requests through the environment proxy |
| `-V, --version` | — | Print the version |

## Output

- `<output>/<article-title>/<article-title>.md`
- `<output>/<article-title>/images/*`

## Features

1. Multi-source router (URL auto-detect + `--source`)
2. WeChat: anti-detection fetch via Camoufox, metadata extraction, image localization, code-snippet handling, HTML→Markdown via turndown
3. Blogs: data-driven `BlogSiteConfig` per site (addyosmani.com out of the box), readability fallback for unknown domains, sitemap bulk-crawl via `--from-sitemap`
4. Batch mode with resume and per-source deduplication

## Limitations

- Twitter is not implemented yet (stub throws `来源「twitter」尚未实现`)
- Some code snippets are image/SVG rendered and cannot be extracted as source code
- Camoufox may trigger a WeChat CAPTCHA on aggressive use; the raw HTML is saved to
  `debug.html`
