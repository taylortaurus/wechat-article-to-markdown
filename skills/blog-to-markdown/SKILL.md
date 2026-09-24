---
name: blog-to-markdown
description: Fetch a blog post (or a whole blog via its sitemap) and convert it to clean Markdown, with images localized. Implemented in spider-claw via the `blog` source. 通用博客文章转 Markdown（已通过 spider-claw 的 blog 源实现，支持站点地图批量爬取）。
author: jackwener
version: "3.0.0"
tags:
  - blog
  - 博客
  - sitemap
  - markdown
  - article
  - converter
  - spider-claw
---

# Blog → Markdown (spider-claw / blog source)

Fetch a blog post and convert it to clean Markdown. Blogs are **static-HTML
sites** (no Camoufox needed) fetched over HTTP; the main article body is
extracted by CSS selector (per-site) or a readability fallback for unknown
domains.

## When to use

- Archiving a single blog post as Markdown.
- Bulk-archiving an entire blog from its sitemap.
- Any article-like web page when you pass `--source blog` explicitly (readability fallback).

## Prerequisites

- **Node.js ≥ 22** (no browser required for the blog source)

```bash
pnpm dev "<BLOG_POST_URL>"      # from the project root
# or, when installed/built:
spider-claw "<BLOG_POST_URL>"
```

## Commands

```bash
# Single post (source auto-detected for registered domains like addyosmani.com):
spider-claw "https://addyosmani.com/blog/career-advice-age-of-agents/"

# Force the blog source on any URL (readability fallback for unknown sites):
spider-claw --source blog "https://example.com/2026/07/some-post"

# Bulk-crawl a whole blog from its sitemap (auto-filtered, resumed via url-list.json):
spider-claw --from-sitemap "https://addyosmani.com/sitemap.xml"
```

## How it works

- **Registered sites** (`BLOG_SITES` in `src/sources/blog.ts`) define the domain,
  sitemap URL, content/title/author/date selectors, and a path filter for the
  sitemap. `addyosmani.com` is configured out of the box.
- **Metadata**: title from `og:title` / `<title>` / `<h1>`; author from meta
  `author` / JSON-LD; date from `article:published_time` / JSON-LD /
  first date-like `<h2>` (addyosmani writes the date as the first `<h2>`, which is
  then removed from the body so it is not duplicated).
- **Images**: downloaded to `<output>/<title>/images/` and links rewritten.
- **Dedup**: keyed by `(source, articleId)` where `articleId` is the URL path,
  so the same post (even with tracking params) is crawled once.

## Options

See the root [`spider-claw`](../SKILL.md) skill. Relevant flags: `-o/--output`,
`--list`, `--source blog`, `--proxy`, and `--from-sitemap <sitemapUrl>`.

## Adding a new blog site

Edit `src/sources/blog.ts` and add a `BlogSiteConfig` to `BLOG_SITES`:

```ts
'example.com': {
  domain: 'example.com',
  sitemapUrl: 'https://example.com/sitemap.xml',
  contentSelector: 'article.post',   // or omit → <article> → readability
  dateIsFirstH2: true,               // if the site prints the date as first <h2>
  listPathFilter: '/blog/',          // sitemap filter (optional)
  removeSelectors: ['script', 'style', '.ads'],
},
```

No changes to the crawl flow are needed.
