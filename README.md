# spider-claw

Multi-source article fetcher that converts web articles (WeChat, blogs, Twitter, …) to clean Markdown. WeChat and blogs are implemented; Twitter is a registered stub.

[English](#features) | [中文](#功能特性)

## Features

- **Multi-source router**: auto-detect source from URL, or force with `--source`
- Anti-detection fetching with Camoufox (WeChat)
- Extract article metadata (title, account name, publish time, source URL)
- Convert article HTML to Markdown
- Download article images to local `images/` and rewrite links
- Handle WeChat `code-snippet` blocks with language fences
- Batch mode with resume and per-source deduplication (`url-list.json`)

## Installation

```bash
# Recommended: uv tool (fast, isolated)
uv tool install spider-claw

# Or: pipx
pipx install spider-claw
```

Or from source:

```bash
git clone git@github.com:jackwener/wechat-article-to-markdown.git
cd wechat-article-to-markdown
uv sync
```

## Usage

```bash
# Installed CLI (via uv tool install / pipx)
spider-claw "https://mp.weixin.qq.com/s/xxxxxxxx"

# Run in repo with uv (recommended for development)
uv run spider-claw "https://mp.weixin.qq.com/s/xxxxxxxx"

# Or run through the package explicitly
uv run python -m spider_claw "https://mp.weixin.qq.com/s/xxxxxxxx"
```

> **Naming note:** the installed command is `spider-claw` (hyphen — a shell
> command), backed by the Python package `spider_claw` (underscore — a valid
> module name). The mapping is declared in `pyproject.toml`:
> `spider-claw = "spider_claw:main"`. With `uv run`:
> - `uv run spider-claw` → resolves to the installed console script;
> - `uv run python -m spider_claw` → runs the package entry point directly.

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
`spider_claw/sources/blog.py` (`BLOG_SITES`) with the domain, sitemap URL and
selectors. No changes to the crawl flow are needed. Unknown domains still work
with `--source blog` via a readability-based fallback.

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
- **Deduplication**: the dedup key is `(source, article_id)`. For WeChat,
  `article_id` is the core path (`/s/xxx`, with tracking params like
  `?chksm=...&scene=...` and anchors stripped). The same article—even with
  different tracking parameters or listed twice—is crawled only once; extra
  occurrences print `⏭️ 重复 URL，跳过` and are skipped.

```bash
# Default file: ./url-list.json
uv run spider-claw

# Or specify a file
uv run spider-claw --list my-urls.json
```

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


## Testing

```bash
# Unit tests (default CI path)
uv run --with pytest pytest -q -m "not e2e"

# Live E2E against real WeChat articles
WECHAT_E2E_URLS="https://mp.weixin.qq.com/s/Y7dyRC7CJ09miHWU6LBzBA,https://mp.weixin.qq.com/s/xxxxxxxx" \
  uv run --with pytest pytest -q -m e2e -s
```

`e2e` tests require network and browser runtime, so they run via manual GitHub Actions workflow `.github/workflows/e2e.yml`.

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

## PyPI Publishing (GitHub Actions)

Repository: `jackwener/wechat-article-to-markdown`
Workflow: `.github/workflows/release.yml`
Environment: `pypi`

`release.yml` triggers on `v*` tags, runs unit tests + live e2e tests, then publishes to PyPI with trusted publishing (`id-token: write`).

For release e2e targets, set repository variable `RELEASE_E2E_URLS` (comma-separated article URLs).  
If not set, workflow falls back to `https://mp.weixin.qq.com/s/Y7dyRC7CJ09miHWU6LBzBA`.

---

## 功能特性

- 使用 Camoufox 进行反检测抓取
- 提取标题、公众号名称、发布时间、原文链接
- 将微信公众号文章 HTML 转换为 Markdown
- 下载图片到本地 `images/` 并自动替换链接
- 处理微信 `code-snippet` 代码块并保留语言标识

## 安装

```bash
# 推荐：uv tool
uv tool install spider-claw

# 或者：pipx
pipx install spider-claw
```

或从源码安装：

```bash
git clone git@github.com:jackwener/wechat-article-to-markdown.git
cd wechat-article-to-markdown
uv sync
```

## 使用示例

```bash
# 安装后的全局命令（uv tool install / pipx）
spider-claw "https://mp.weixin.qq.com/s/xxxxxxxx"

# 在仓库内用 uv 运行（开发推荐）
uv run spider-claw "https://mp.weixin.qq.com/s/xxxxxxxx"

# 或通过包直接运行
uv run python -m spider_claw "https://mp.weixin.qq.com/s/xxxxxxxx"
```

> **命名说明：** 安装的命令名为 `spider-claw`（连字符，终端命令），底层是 Python 包
> `spider_claw`（下划线，符合模块命名）。两者在 `pyproject.toml` 中通过
> `spider-claw = "spider_claw:main"` 关联。使用 `uv run` 时：
> - `uv run spider-claw` → 解析为已安装的 console 脚本；
> - `uv run python -m spider_claw` → 直接运行包入口。

### 多源路由

`spider-claw` 是一个多源抓取工具。微信（`mp.weixin.qq.com`）与博客（任意已注册
博客域名，如 `addyosmani.com`）已完整实现；Twitter 已注册为占位 stub（尚未实现）。

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

博客采用「数据驱动」设计：在 `spider_claw/sources/blog.py` 的 `BLOG_SITES`
注册表里加一条 `BlogSiteConfig`（域名、站点地图 URL、选择器即可），无需改动抓取
流程。未注册的域名也可通过 `--source blog` 走 readability 通用兜底提取。

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
- 对象可带 `source` 字段（`wechat`/`twitter`/`blog`）；缺省时按 URL 自动识别，并最终回退 `wechat`（兼容多源支持之前的历史列表）。
- 带 `status: "done"` 的对象下次运行会**跳过**；
- 每条爬取后文件会被回写 `source`、`status`、`output`（相对路径）、`updated_at`，中断也可续爬。
- **去重**：去重键为 `(source, article_id)`。微信的 `article_id` 是核心路径（`/s/xxx`，去掉 `?chksm=...&scene=...` 等追踪参数与锚点）。同一篇文章即使链接带不同追踪参数、或在列表里写了多次，也只会爬一次；多余的会打印 `⏭️ 重复 URL，跳过` 并跳过。

```bash
# 默认文件：./url-list.json
uv run spider-claw

# 或指定文件
uv run spider-claw --list my-urls.json
```

## 作为 AI Agent Skill 使用

项目自带根目录 [`SKILL.md`](./SKILL.md)（总入口 skill），以及 [`skills/`](./skills) 下按来源拆分的 skill（如 `wechat-to-markdown`），可供支持 `.agents/skills/` 约定的 Agent 自动发现。

### [Skills CLI](https://github.com/vercel-labs/skills)（推荐）

```bash
npx skills add jackwener/wechat-article-to-markdown
```

| 参数 | 说明 |
| --- | --- |
| `-g` | 全局安装（用户级别，跨项目共享） |
| `-a claude-code` | 指定目标 Agent |
| `-y` | 非交互模式 |

### 手动安装

```bash
mkdir -p ~/.claude/skills/wechat-article-to-markdown
curl -o ~/.claude/skills/wechat-article-to-markdown/SKILL.md \
  https://raw.githubusercontent.com/jackwener/wechat-article-to-markdown/main/SKILL.md
```

### ~~OpenClaw / ClawHub~~（已过时）

> ⚠️ ClawHub 安装方式已过时，不再支持。请使用上方的 Skills CLI 或手动安装。

## 文档（设计实现 Wiki）

详细的来源设计与实现说明位于 [`docs/`](./docs/)：

- [微信公众号来源设计](./docs/wechat-source-design.md) — 反检测抓取（Camoufox）、URL 归一化、元数据/正文预处理、代码块与图片本地化。
- [博客来源设计](./docs/blog-source-design.md) — 数据驱动的 `BlogSiteConfig`、站点地图批量爬取、新增站点指南，以及博客与微信的差异对比。

## License

MIT
