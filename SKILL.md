---
name: spider-claw
description: Multi-source article fetcher that converts web articles (WeChat, blogs, Twitter, ...) to Markdown. Routes by URL or --source; supports sitemap bulk-crawl. 多源文章转 Markdown 工具（微信与博客已实现，Twitter 占位，支持站点地图批量爬取）。
author: jackwener
version: "2.0.0"
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
---

# spider-claw

Fetch articles from multiple sources and convert them to clean Markdown, with
images localized to local files. **WeChat (`mp.weixin.qq.com`) and blogs
(registered domains, e.g. `addyosmani.com`) are fully implemented**; Twitter is a
registered stub (not yet implemented).

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

- Python 3.8+ and [`uv`](https://github.com/astral-sh/uv)
- Camoufox (anti-detection browser) — its browser binary is fetched automatically on first run (WeChat)

```bash
# Run directly with uv (no install needed) from the project root:
uv run spider-claw "<ARTICLE_URL>"

# Or install the CLI globally:
uv tool install spider-claw
spider-claw "<ARTICLE_URL>"
```

## Usage

### Single article (source auto-detected, or forced)

```bash
spider-claw "https://mp.weixin.qq.com/s/XXXXXXXX"
spider-claw --source wechat "https://mp.weixin.qq.com/s/XXXXXXXX"
spider-claw "https://addyosmani.com/blog/career-advice-age-of-agents/"   # blog (auto-detected)
spider-claw --source blog "https://example.com/any/post"                 # any URL (readability fallback)
spider-claw --source twitter "https://twitter.com/xxx/status/123"   # stub → not implemented
```

### Batch mode (url-list.json)

```bash
uv run spider-claw                # default: ./url-list.json
uv run spider-claw --list my-urls.json
```

Each entry is a string or an object. Objects may carry `source` (defaults to
auto-detect → `wechat`), and after a crawl get `status`, `output`, `updated_at`
written back. Dedup key is `(source, article_id)`, so the same article (even with
different tracking params, or listed twice) is crawled only once.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `-o, --output DIR` | `./output` | Output directory |
| `--list FILE` | `./url-list.json` | URL list for batch mode |
| `--source NAME` | auto | Force a source (`wechat`/`twitter`/`blog`), overriding URL detection |
| `--from-sitemap URL` | — | Discover blog posts from a sitemap, append to `url-list.json`, and crawl (resume-safe) |
| `--proxy` | off (direct) | Route image downloads through the environment proxy |

## Output

- `<output>/<article-title>/<article-title>.md`
- `<output>/<article-title>/images/*`

## Features

1. Multi-source router (URL auto-detect + `--source`)
2. WeChat: anti-detection fetch via Camoufox, metadata extraction, image localization, code-snippet handling, markdownify
3. Blogs: data-driven `BlogSiteConfig` per site (addyosmani.com out of the box), readability fallback for unknown domains, sitemap bulk-crawl via `--from-sitemap`
4. Batch mode with resume and per-source deduplication

## Limitations

- Twitter is not implemented yet (stub raises `NotImplementedError`)
- Some code snippets are image/SVG rendered and cannot be extracted as source code
- Camoufox may trigger a WeChat CAPTCHA on aggressive use; the raw HTML is saved to `debug.html`
