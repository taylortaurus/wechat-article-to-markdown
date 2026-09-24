# spider-claw

Multi-source article fetcher that converts web articles (WeChat, blogs, Twitter, …) to clean Markdown. WeChat and blogs are implemented; Twitter is a registered stub.

> **TypeScript rewrite.** The project was refactored from Python to a TypeScript/Node.js
> stack on branch `dev-dsh-spider-claw`; the previous Python implementation is archived
> under [`legacy/python/`](./legacy/python). See the
> [重构报告](./docs/typescript-refactor-report.md) for the module-by-module mapping,
> behaviour parity checks and the intentional deviations.

[English](#features) | [中文](#功能特性)

## Features

- **Multi-source router**: auto-detect source from URL, or force with `--source`
- Anti-detection fetching with [Camoufox](https://camoufox.com/) (WeChat)
- Extract article metadata (title, account name, publish time, source URL)
- Convert article HTML to Markdown
- Download article images to local `images/` and rewrite links
- Handle WeChat `code-snippet` blocks with language fences
- Batch mode with resume and per-source deduplication (`url-list.json`)

## Requirements

- **Node.js ≥ 22** (uses native `fetch` + `AbortSignal.timeout`)
- For the **WeChat** source only: the Camoufox browser binary, fetched once with
  `npx camoufox-js fetch`

## Installation

```bash
# Recommended: install the CLI globally
npm install -g spider-claw

# Or run without installing
npx spider-claw "https://mp.weixin.qq.com/s/xxxxxxxx"

# WeChat source needs the anti-detection browser binary once
npx camoufox-js fetch
```

Or from source:

```bash
git clone git@github.com:jackwener/wechat-article-to-markdown.git
cd wechat-article-to-markdown
pnpm install
pnpm build        # produces dist/ (dist/cli.js is the `spider-claw` binary)
```

## Usage

```bash
# Installed CLI
spider-claw "https://mp.weixin.qq.com/s/xxxxxxxx"

# From a source checkout (no build step, runs TypeScript directly)
pnpm dev "https://mp.weixin.qq.com/s/xxxxxxxx"

# Or the built artifact
node dist/cli.js "https://mp.weixin.qq.com/s/xxxxxxxx"
```

> **Naming note:** the installed command is `spider-claw` (hyphen — a shell command),
> backed by the npm package `spider-claw` whose binary entry is `dist/cli.js`.

### Multi-source routing

`spider-claw` is a multi-source fetcher. WeChat (`mp.weixin.qq.com`) and blogs
(any registered blog domain, e.g. `addyosmani.com`) are fully implemented;
Twitter is a registered stub (not yet implemented).

```bash
# Source is auto-detected from the URL:
spider-claw "https://mp.weixin.qq.com/s/XXXXXXXX"
spider-claw "https://addyosmani.com/blog/career-advice-age-of-agents/"

# Or force a source explicitly (overrides auto-detection):
spider-claw --source wechat "https://mp.weixin.qq.com/s/XXXXXXXX"
spider-claw --source blog "https://addyosmani.com/blog/any-post/"   # works for any URL
spider-claw --source twitter "https://twitter.com/xxx/status/123"   # stub → not implemented

# Bulk-crawl a whole blog from its sitemap (auto-filtered, written to url-list.json):
spider-claw --from-sitemap "https://addyosmani.com/sitemap.xml"
```

Available `--source` values: `wechat`, `twitter`, `blog`.

#### Adding a new blog site

Blogs are data-driven: register a `BlogSiteConfig` in
[`src/sources/blog.ts`](./src/sources/blog.ts) (`BLOG_SITES`) with the domain, sitemap
URL and selectors. No changes to the crawl flow are needed. Unknown domains still work
with `--source blog` via a readability-based fallback.

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

### Batch mode with `url-list.json`

Instead of passing a URL each time, put all target URLs in a JSON list and run
a single fixed command. Crawled entries are marked and skipped on the next run.

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
- An object may carry a `source` field (`wechat`/`twitter`/`blog`); when omitted
  it is auto-detected from the URL and falls back to `wechat` (backward compatible
  with lists that predate multi-source support).
- An object with `status: "done"` is **skipped** on subsequent runs.
- After each crawl the file is rewritten with `source`, `status`, `output`
  (relative path) and `updated_at`, so progress survives interruptions (resume).
- **Deduplication**: the dedup key is `(source, articleId)`. For WeChat,
  `articleId` is the core path (`/s/xxx`, with tracking params like
  `?chksm=...&scene=...` and anchors stripped). The same article—even with
  different tracking parameters or listed twice—is crawled only once; extra
  occurrences print `⏭️ 重复 URL，跳过` and are skipped.

```bash
# Default file: ./url-list.json
spider-claw

# Or specify a file
spider-claw --list my-urls.json
```

The process exits with code `1` if any entry failed, so it is CI-friendly.

Output structure:

```text
output/
└── <article-title>/
    ├── <article-title>.md
    └── images/
        ├── img_001.png
        ├── img_002.png
        └── ...
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `-o, --output <dir>` | `./output` | Output directory |
| `--list <file>` | `./url-list.json` | URL list for batch mode |
| `--source <name>` | auto | Force a source (`wechat`/`twitter`/`blog`), overriding URL detection |
| `--from-sitemap <sitemapUrl>` | — | Discover blog posts from a sitemap, append to `url-list.json`, and crawl (resume-safe) |
| `--proxy` | off (direct) | Route HTTP requests through the environment proxy (`ALL_PROXY`/`HTTPS_PROXY`/`NO_PROXY`) |
| `-V, --version` | — | Print the version |

## Testing

```bash
# Unit tests (offline; default CI path)
pnpm test

# Type checking and production build
pnpm typecheck && pnpm build

# Live E2E against real WeChat articles (needs network + Camoufox browser)
WECHAT_E2E_URLS="https://mp.weixin.qq.com/s/Y7dyRC7CJ09miHWU6LBzBA" \
  pnpm test:e2e
```

`tests/e2e` self-skips when `WECHAT_E2E_URLS` is unset, so it also runs safely via the
manual GitHub Actions workflow `.github/workflows/e2e.yml`.

## Library usage

Everything the CLI does is available as a typed API:

```ts
import { BlogSource, detectSource, downloadAllImages, convertToMarkdown } from 'spider-claw';

const source = detectSource('https://addyosmani.com/blog/any-post/');
if (source) {
  const mdPath = await source.fetch('https://addyosmani.com/blog/any-post/', {
    outputDir: './output',
    proxy: 'direct',
  });
  console.log(mdPath);
}
```

## Use as AI Agent Skill

This project ships with a meta [`SKILL.md`](./SKILL.md) plus per-source skills under
[`skills/`](./skills) (e.g. `wechat-to-markdown`), so AI agents can discover and use
this tool workflow.

### [Skills CLI](https://github.com/vercel-labs/skills) (Recommended)

```bash
npx skills add jackwener/wechat-article-to-markdown
```

| Flag | Description |
| --- | --- |
| `-g` | Install globally (user-level, shared across projects) |
| `-a claude-code` | Target a specific agent |
| `-y` | Non-interactive mode |

### Manual Install

```bash
mkdir -p .agents/skills
git clone git@github.com:jackwener/wechat-article-to-markdown.git \
  .agents/skills/wechat-article-to-markdown
```

```bash
# Claude Code user-level skills directory (global)
mkdir -p ~/.claude/skills/wechat-article-to-markdown
curl -o ~/.claude/skills/wechat-article-to-markdown/SKILL.md \
  https://raw.githubusercontent.com/jackwener/wechat-article-to-markdown/main/SKILL.md
```

After adding the file, restart Claude Code to reload skills.

### ~~OpenClaw / ClawHub~~ (Deprecated)

> ⚠️ ClawHub install method is deprecated and no longer supported. Use [Skills CLI](#skills-cli-recommended) or Manual Install above.

## Publishing (GitHub Actions)

Workflows (now npm-based):

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | PR / push to `main` | typecheck → build → unit tests |
| `.github/workflows/e2e.yml` | manual | live WeChat e2e |
| `.github/workflows/publish.yml` | manual | verify → `npm publish` (trusted publishing + provenance) |
| `.github/workflows/release.yml` | `v*` tag | verify → e2e → `npm publish` + GitHub Release |

For release e2e targets, set repository variable `RELEASE_E2E_URLS` (comma-separated
article URLs). If not set, the workflow falls back to
`https://mp.weixin.qq.com/s/Y7dyRC7CJ09miHWU6LBzBA`.

---

## 功能特性

- 使用 Camoufox 进行反检测抓取（微信）
- 提取标题、公众号名称、发布时间、原文链接
- 将文章 HTML 转换为 Markdown
- 下载图片到本地 `images/` 并自动替换链接
- 处理微信 `code-snippet` 代码块并保留语言标识
- 站点地图批量爬取 + 列表续爬去重

## 环境要求

- **Node.js ≥ 22**
- 仅微信来源需要一次性下载 Camoufox 浏览器：`npx camoufox-js fetch`

## 安装

```bash
# 推荐：全局安装 CLI
npm install -g spider-claw

# 或免安装直接运行
npx spider-claw "https://mp.weixin.qq.com/s/xxxxxxxx"
```

或从源码安装：

```bash
git clone git@github.com:jackwener/wechat-article-to-markdown.git
cd wechat-article-to-markdown
pnpm install && pnpm build
```

## 使用示例

```bash
# 安装后的全局命令
spider-claw "https://mp.weixin.qq.com/s/xxxxxxxx"

# 在仓库内直接跑 TypeScript 源码（开发推荐）
pnpm dev "https://mp.weixin.qq.com/s/xxxxxxxx"
```

### 多源路由

微信（`mp.weixin.qq.com`）与博客（任意已注册博客域名，如 `addyosmani.com`）已完整实现；
Twitter 已注册为占位 stub（尚未实现）。

```bash
# 来源由 URL 自动识别：
spider-claw "https://mp.weixin.qq.com/s/XXXXXXXX"
spider-claw "https://addyosmani.com/blog/career-advice-age-of-agents/"

# 或显式指定来源（覆盖自动识别）：
spider-claw --source wechat "https://mp.weixin.qq.com/s/XXXXXXXX"
spider-claw --source blog "https://addyosmani.com/blog/any-post/"   # 任意 URL 均可
spider-claw --source twitter "https://twitter.com/xxx/status/123"   # stub → 尚未实现

# 从站点地图批量爬取整站博客（自动按站点规则过滤，并写入 url-list.json）：
spider-claw --from-sitemap "https://addyosmani.com/sitemap.xml"
```

可选 `--source`：`wechat`、`twitter`、`blog`。

#### 新增博客站点

博客采用「数据驱动」设计：在 [`src/sources/blog.ts`](./src/sources/blog.ts) 的
`BLOG_SITES` 注册表里加一条 `BlogSiteConfig`（域名、站点地图 URL、选择器即可），
无需改动抓取流程。未注册的域名也可通过 `--source blog` 走 readability 通用兜底提取。

### 批量模式（url-list.json）

无需每次传 URL，把目标链接写进 JSON 列表，跑一条固定命令即可。已爬取的条目会被标记，下次运行自动跳过。

```json
[
  "https://mp.weixin.qq.com/s/xxxxxxxx",
  {
    "url": "https://mp.weixin.qq.com/s/yyyyyyyy",
    "status": "done",
    "output": "output/<标题>/<标题>.md",
    "updated_at": "2026-07-11 12:00:00"
  }
]
```

- 直接写字符串 `"https://..."` 视为待爬取；
- 对象可带 `source` 字段（`wechat`/`twitter`/`blog`）；缺省时按 URL 自动识别，并最终回退 `wechat`（兼容多源支持之前的历史列表）；
- 带 `status: "done"` 的对象下次运行会**跳过**；
- 每条爬取后文件会被回写 `source`、`status`、`output`（相对路径）、`updated_at`，中断也可续爬；
- **去重**：去重键为 `(source, articleId)`。微信的 `articleId` 是核心路径（`/s/xxx`，去掉 `?chksm=...&scene=...` 等追踪参数与锚点）。同一篇文章即使链接带不同追踪参数、或在列表里写了多次，也只会爬一次；多余的会打印 `⏭️ 重复 URL，跳过` 并跳过；
- 只要有一条失败，进程退出码为 `1`（方便 CI 判断）。

### 命令行参数

见上方 [Options](#options) 表格：`-o/--output`、`--list`、`--source`、`--from-sitemap`、`--proxy`、`-V/--version`。

## 测试

```bash
pnpm test          # 离线单元测试（默认 CI 路径）
pnpm typecheck     # 类型检查
pnpm build         # 生产构建

# 真实微信文章 e2e（需网络 + Camoufox 浏览器）
WECHAT_E2E_URLS="https://mp.weixin.qq.com/s/Y7dyRC7CJ09miHWU6LBzBA" pnpm test:e2e
```

## 作为 AI Agent Skill 使用

项目自带根目录 [`SKILL.md`](./SKILL.md)（总入口 skill），以及 [`skills/`](./skills)
下按来源拆分的 skill（如 `wechat-to-markdown`），可供支持 `.agents/skills/` 约定的
Agent 自动发现。

```bash
npx skills add jackwener/wechat-article-to-markdown
```

## 文档

- [TypeScript 重构报告](./docs/typescript-refactor-report.md) — 重构范围、映射表、验证结论与已知差异。
- [微信公众号来源设计](./docs/wechat-source-design.md) — 反检测抓取（Camoufox）、URL 归一化、元数据/正文预处理、代码块与图片本地化。
- [博客来源设计](./docs/blog-source-design.md) — 数据驱动的 `BlogSiteConfig`、站点地图批量爬取、新增站点指南，以及博客与微信的差异对比。
- [归档的 Python 实现](./legacy/python/README.md) — 仅供对照参考，不参与构建与 CI。

## License

MIT
