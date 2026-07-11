# wechat-article-to-markdown

Fetch WeChat Official Account articles and convert them to clean Markdown.

[English](#features) | [中文](#功能特性)

## Features

- Anti-detection fetching with Camoufox
- Extract article metadata (title, account name, publish time, source URL)
- Convert WeChat article HTML to Markdown
- Download article images to local `images/` and rewrite links
- Handle WeChat `code-snippet` blocks with language fences

## Installation

```bash
# Recommended: uv tool (fast, isolated)
uv tool install wechat-article-to-markdown

# Or: pipx
pipx install wechat-article-to-markdown
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
weixin-spider "https://mp.weixin.qq.com/s/xxxxxxxx"

# Run in repo with uv (recommended for development)
uv run weixin-spider "https://mp.weixin.qq.com/s/xxxxxxxx"

# Or run the module file directly
uv run weixin_spider.py "https://mp.weixin.qq.com/s/xxxxxxxx"
```

> **Naming note:** the runnable file is `weixin_spider.py` (underscore — a valid
> Python module name), while the installed command is `weixin-spider` (hyphen —
> the shell command). The mapping is declared in `pyproject.toml`:
> `weixin-spider = "weixin_spider:main"`. With `uv run`:
> - `uv run weixin-spider` → resolves to the installed console script;
> - `uv run weixin_spider.py` → runs the file directly;
> - `uv run weixin_spider` (no `.py`, underscore) → matches neither and fails.

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
- An object with `status: "done"` is **skipped** on subsequent runs.
- After each crawl the file is rewritten with `status`, `output` (relative
  path) and `updated_at`, so progress survives interruptions (resume).
- **Deduplication**: the article is keyed by its core path (`/s/xxx`, with
  tracking params like `?chksm=...&scene=...` and anchors stripped). The same
  article—even with different tracking parameters or listed twice—is crawled
  only once; extra occurrences print `⏭️ 重复 URL，跳过` and are skipped.

```bash
# Default file: ./url-list.json
uv run weixin-spider

# Or specify a file
uv run weixin-spider --list my-urls.json
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

This project ships with [`SKILL.md`](./SKILL.md), so AI agents can discover and use this tool workflow.

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
uv tool install wechat-article-to-markdown

# 或者：pipx
pipx install wechat-article-to-markdown
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
weixin-spider "https://mp.weixin.qq.com/s/xxxxxxxx"

# 在仓库内用 uv 运行（开发推荐）
uv run weixin-spider "https://mp.weixin.qq.com/s/xxxxxxxx"

# 或直接运行模块文件
uv run weixin_spider.py "https://mp.weixin.qq.com/s/xxxxxxxx"
```

> **命名说明：** 可运行文件名为 `weixin_spider.py`（下划线，符合 Python 模块命名），
> 而安装的命令名为 `weixin-spider`（连字符，终端命令）。两者在 `pyproject.toml`
> 中通过 `weixin-spider = "weixin_spider:main"` 关联。使用 `uv run` 时：
> - `uv run weixin-spider` → 解析为已安装的 console 脚本；
> - `uv run weixin_spider.py` → 直接运行文件；
> - `uv run weixin_spider`（无 `.py`、下划线）→ 两者都不匹配，会报错。

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
- 带 `status: "done"` 的对象下次运行会**跳过**；
- 每条爬取后文件会被回写 `status`、`output`（相对路径）、`updated_at`，中断也可续爬。
- **去重**：以文章核心路径（`/s/xxx`，去掉 `?chksm=...&scene=...` 等追踪参数与锚点）作为去重键。同一篇文章即使链接带不同追踪参数、或在列表里写了多次，也只会爬一次；多余的会打印 `⏭️ 重复 URL，跳过` 并跳过。

```bash
# 默认文件：./url-list.json
uv run weixin-spider

# 或指定文件
uv run weixin-spider --list my-urls.json
```

## 作为 AI Agent Skill 使用

项目自带 [`SKILL.md`](./SKILL.md)，可供支持 `.agents/skills/` 约定的 Agent 自动发现。

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

## License

MIT
