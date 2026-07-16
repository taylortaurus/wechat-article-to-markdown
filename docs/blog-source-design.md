# 博客来源（Blog Source）设计与实现

> 首个「博客类」来源的落地实现，目标是可低成本扩展到任意静态博客站点。

## 1. 背景与目标

原项目仅实现微信公众号抓取。随着多源化，`blog` 作为第二种来源被实现，设计要点：

- **数据驱动**：每个博客站点用一条配置描述，新增站点只改配置、不动流程；
- **静态站友好**：博客多为静态 HTML，直接用 `httpx` 抓取，无需 Camoufox 反检测浏览器；
- **兜底通用**：未注册的域名在显式 `--source blog` 时走 `readability` 通用提取；
- **可批量**：支持从站点地图（sitemap）发现并批量爬取整站。

## 2. 抓取结果验证

已成功爬取目标文章：

```
https://addyosmani.com/blog/career-advice-age-of-agents/
```

产出：

```
output/The Agent-Era Career/
├── The Agent-Era Career.md     # 正文 Markdown
└── images/                     # 本地化图片（含 Referer）
```

`The Agent-Era Career.md` 头信息示例（来源无关、通用）：

```markdown
# The Agent-Era Career

> 作者: Addy Osmani
> 发布时间: 2026-07-06 00:00:00
> 原文链接: https://addyosmani.com/blog/career-advice-age-of-agents

---
```

该站点把发布日期写成正文**首个 `h2`**（如 `July 6, 2026`），已实现自动解析为 `YYYY-MM-DD` 并在正文中剔除，避免顶部重复。

## 3. 架构设计

### 3.1 Source 统一接口

`spider_claw/sources/base.py` 定义了所有来源必须实现的抽象接口：

```python
class Source(ABC):
    name: str                                   # 来源标识，用于 --source / url-list
    def normalize(self, url: str) -> str        # URL 清理（默认原样返回）
    def match(self, url: str) -> bool           # 能否处理该 URL（自动识别）
    def article_id(self, url: str) -> str       # 规范化去重键
    async def fetch(self, url, output_dir, no_proxy) -> Path  # 抓取单篇，返回 md 路径
```

`BlogSource` 与 `WechatSource` 共用同一套接口，因此 CLI 路由、列表续爬、去重逻辑完全复用。

### 3.2 数据驱动的站点配置

`spider_claw/sources/blog.py` 用 `BlogSiteConfig` 描述单个站点：

```python
@dataclass
class BlogSiteConfig:
    domain: str                       # 路由用域名，如 "addyosmani.com"（支持子域）
    sitemap_url: str                  # 站点地图地址
    content_selector: str | None     # 正文 CSS 选择器；None 时优先 <article>，否则 readability
    title_selector: str | None       # 标题选择器（缺省 og:title / <title> / <h1>）
    author_selector: str | None      # 作者选择器（缺省 meta author / JSON-LD）
    date_selector: str | None        # 日期选择器
    date_is_first_h2: bool = False   # 如 addyosmani 将日期写在正文首个 h2
    list_path_filter: str | None     # sitemap 过滤：仅保留 path 以此开头的 URL
    remove_selectors: list[str]      # 正文噪声节点
```

已注册站点集中在 `BLOG_SITES` 注册表：

```python
BLOG_SITES = {
    "addyosmani.com": BlogSiteConfig(
        domain="addyosmani.com",
        sitemap_url="https://addyosmani.com/sitemap.xml",
        content_selector="article.post",
        date_is_first_h2=True,
        list_path_filter="/blog/",          # sitemap 同时含 /notes/，仅爬 /blog/
        remove_selectors=["script", "style"],
    ),
}
```

未注册域名回退到 `DEFAULT_BLOG_CONFIG`（仅含 readability 兜底，无 sitemap）。

### 3.3 路由与去重

- `match(url)`：仅对**已注册域名**返回 `True`，避免抢占未知 URL（未知 URL 需显式 `--source blog`）。
- `normalize(url)`：统一 scheme、去掉路径末尾斜杠。
- `article_id(url)`：以「域名无关的核心路径」作为去重键，配合列表模式的 `(source, article_id)` 实现跨参数续爬去重。

## 4. 抓取流程

```
BlogSource.fetch(url)
  ├─ _config_for(url)            # 按域名取 BlogSiteConfig（未命中用兜底）
  ├─ normalize(url)              # 清理 URL
  ├─ _http_get(url)              # httpx 静态抓取（带 UA / Referer）
  ├─ BeautifulSoup 解析
  ├─ _extract(...)               # 提取正文 / 元数据 / 图片 URL
  │    ├─ _select_content        # content_selector → <article> → readability
  │    ├─ remove_selectors 去噪  # script/style 等
  │    ├─ _title / _author / _date
  │    └─ 去重标题 h1、收集 img_urls
  ├─ convert_to_markdown(...)    # HTML → Markdown（共享核心层）
  ├─ download_all_images(..., referer=站点来源)  # 图片本地化
  ├─ replace_image_urls(...)     # 替换 md 中远程图链为本地路径
  └─ build_markdown(meta, md)    # 拼接头信息 + 正文，写文件
```

### 4.1 元数据提取策略（优先级）

| 字段 | 提取顺序 |
| --- | --- |
| 标题 | `og:title` → `title_selector` → `<h1>` → `<title>` |
| 作者 | `meta[name=author]` → `author_selector` → JSON-LD `author` |
| 日期 | `article:published_time` → `date_selector` → JSON-LD `datePublished` → `date_is_first_h2` |
| 图片 | 正文 `<img>` 的 `src`（含 `data-src`），去重、去 `data:` |

日期统一通过 `_parse_date` 尽量规整为 `YYYY-MM-DD HH:mm:ss`，无法解析则原样保留。

## 5. 站点地图批量爬取（`--from-sitemap`）

CLI 新增 `--from-sitemap` 参数：

```bash
spider-claw --from-sitemap "https://addyosmani.com/sitemap.xml"
```

执行链路（`cli._run_sitemap`）：

1. 解析 sitemap，按站点 `list_path_filter`（如 `/blog/`）过滤文章 URL；
2. 合并进 `url-list.json`，按 `(source, article_id)` 去重（已存在跳过）；
3. 复用 `_run_list` 列表续爬逻辑逐篇抓取（断点可续）。

实测：`addyosmani.com/sitemap.xml` 发现 268 篇 `/blog/` 文章，已正确过滤掉 `/notes/` 等。

## 6. 新增一个博客站点

只需在 `BLOG_SITES` 注册一条配置，无需改动任何流程：

```python
"example.com": BlogSiteConfig(
    domain="example.com",
    sitemap_url="https://example.com/sitemap.xml",
    content_selector="main article",     # 视站点而定
    list_path_filter="/posts/",
),
```

可选字段按需填写：标题/作者/日期选择器、`date_is_first_h2`、`remove_selectors`。
未配置 `content_selector` 时自动回退到 `<article>` 或 `readability` 兜底。

## 7. 与微信来源的差异

| 维度 | 博客（Blog） | 微信（WeChat） |
| --- | --- | --- |
| 抓取方式 | `httpx` 静态 HTTP | Camoufox 反检测浏览器 |
| 反检测 | 无需 | 必须（规避验证码） |
| 正文定位 | 可配置 CSS 选择器 / readability | 固定 `#js_content` |
| 图片 Referer | 站点来源域名 | `mp.weixin.qq.com` |
| 代码块 | 直接 HTML→MD | 需处理 `code-snippet__fix` 行号/占位符 |
| 适用 | 任意静态博客 | 仅公众号文章 |

## 8. 相关文件

- `spider_claw/sources/blog.py` — 博客来源实现 + `BlogSiteConfig` / `BLOG_SITES`
- `spider_claw/sources/base.py` — `Source` 抽象接口
- `spider_claw/core/markdownify_.py` — 通用 Markdown 转换与头信息拼接
- `spider_claw/core/images.py` — 图片下载（支持可配置 Referer）
- `spider_claw/cli.py` — 路由 + `--from-sitemap` 批量模式
- `tests/test_blog.py` — 离线单测（路由、去重键、日期解析、sitemap 过滤、正文提取）
