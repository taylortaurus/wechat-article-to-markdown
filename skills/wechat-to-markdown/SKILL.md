---
name: wechat-to-markdown
description: Fetch a WeChat Official Account (微信公众号) article from mp.weixin.qq.com and convert it to Markdown. 微信文章转 Markdown（spider-claw 的微信来源）。
author: jackwener
version: "3.0.0"
tags:
  - wechat
  - 微信
  - 微信文章
  - 公众号
  - mp.weixin.qq.com
  - markdown
  - article
  - converter
  - cli
  - batch
  - resume
  - spider-claw
---

# WeChat → Markdown (spider-claw / wechat source)

Fetch a WeChat Official Account article from `mp.weixin.qq.com` and convert it to
clean Markdown, with images localized to local files. This is the fully implemented
WeChat source of [`spider-claw`](../../SKILL.md).

## When to use

Use this skill when you need to save WeChat articles as Markdown for:
- Personal archive
- AI summarization input
- Knowledge base ingestion
- Batch archiving a list of articles (resume-safe)

## Prerequisites

- **Node.js ≥ 22**
- Camoufox (anti-detection browser) — its browser binary is fetched once:

```bash
npx camoufox-js fetch
```

```bash
# Run directly with the TypeScript source (no install needed) from the project root:
pnpm dev "https://mp.weixin.qq.com/s/XXXXXXXX"

# Or install the CLI globally:
npm install -g spider-claw
spider-claw "https://mp.weixin.qq.com/s/XXXXXXXX"
```

> This skill targets the `wechat` source, selected automatically for
> `mp.weixin.qq.com` URLs or via `--source wechat`. The implementation lives in
> `src/sources/wechat.ts`.

## Usage

### Single article

```bash
spider-claw "https://mp.weixin.qq.com/s/XXXXXXXX"
```

### Batch mode (url-list.json)

Put target URLs in `url-list.json` (array of strings or objects) and run a single
fixed command. Crawled entries are marked and skipped on the next run; the same
article is never crawled twice.

```bash
# Default file: ./url-list.json
spider-claw

# Or specify a file
spider-claw --list my-urls.json
```

`url-list.json` format:

```json
[
  "https://mp.weixin.qq.com/s/xxxxxxxx",
  {
    "url": "https://mp.weixin.qq.com/s/yyyyyyyy",
    "status": "done",
    "output": "output/<title>/<title>.md",
    "updated_at": "2026-07-11 12:00:00"
  }
]
```

- A bare string `"https://..."` is treated as a pending URL.
- An object may carry a `source` field; when omitted it is auto-detected (defaults to
  `wechat` for backward compatibility).
- An object with `status: "done"` is skipped on subsequent runs.
- After each crawl the file is rewritten with `source`, `status`, `output` (relative
  path) and `updated_at`, so progress survives interruptions (resume).
- Deduplication: the dedup key is `(source, articleId)`; for WeChat `articleId` is
  the core path (`/s/xxx`, tracking params like `?chksm=...&scene=...` and anchors
  stripped). The same article—even with different tracking parameters or listed
  twice—is crawled only once; extra occurrences print `⏭️ 重复 URL，跳过` and are skipped.
- The process exits with `1` when any entry failed.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `-o, --output <dir>` | `./output` | Output directory |
| `--list <file>` | `./url-list.json` | URL list for batch mode |
| `--proxy` | off (direct) | Route HTTP requests through the environment proxy (`ALL_PROXY`/`HTTPS_PROXY`). Default is direct, ignoring proxy env vars. |

## Output

- `<output>/<article-title>/<article-title>.md`
- `<output>/<article-title>/images/*`

The Markdown head includes the title, account name, publish time and source URL.

## Features

1. Anti-detection fetch with Camoufox (headless Firefox with fingerprint spoofing)
2. Metadata extraction (title, account name, publish time, source URL)
3. Image localization to local files (with `mp.weixin.qq.com` Referer)
4. WeChat code-snippet extraction and fenced code block output
5. HTML to Markdown conversion via turndown
6. Concurrent image downloading (5 at a time by default)
7. Batch mode with resume and deduplication (`url-list.json`)

## Limitations

- Some code snippets are image/SVG rendered and cannot be extracted as source code
- A public `mp.weixin.qq.com` article URL is required
- Camoufox may trigger a WeChat CAPTCHA on aggressive use; the raw HTML is saved to
  `debug.html` for inspection
