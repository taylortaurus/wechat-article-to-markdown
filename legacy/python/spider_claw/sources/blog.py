"""通用博客来源：基于「站点配置 + 静态 HTTP 抓取」的博客爬取。

设计目标：作为首个“博客类”来源，需便于扩展到更多博客站点。
- 每个博客站点用一条 `BlogSiteConfig` 描述（域名、站点地图、正文/标题/作者/日期
  选择器、去噪规则等）；
- `BlogSource` 按域名路由到对应配置，走统一的抓取流程（抓取 -> 提取 -> 图片本地化
  -> Markdown 转换）；
- 新增博客站点**只需在 `BLOG_SITES` 注册表里加一条配置**，无需改动抓取流程；
- 未注册的域名若显式 `--source blog`，会回退到 `DEFAULT_BLOG_CONFIG`（用 readability
  做正文提取），可作为通用的“网页文章”兜底。

与微信源的区别：博客多为静态 HTML，不需要 Camoufox 反检测浏览器，直接用 httpx 抓取。
"""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse

from bs4 import BeautifulSoup

from .base import Source
from ..core.http import sync_client
from ..core.images import _USE_ENV_PROXY, download_all_images
from ..core.markdownify_ import build_markdown, convert_to_markdown, replace_image_urls

DEFAULT_OUTPUT_DIR = Path.cwd() / "output"

UA = "Mozilla/5.0 (compatible; spider-claw/0.1; +https://github.com/jackwener/wechat-article-to-markdown)"


@dataclass
class BlogSiteConfig:
    """单个博客站点的抓取规则。新增站点只需补充一条。"""

    domain: str  # 用于 match / 路由，如 "addyosmani.com"（支持子域）
    sitemap_url: str  # 站点地图地址
    content_selector: str | None = None  # 正文 CSS 选择器；None 时优先 <article>，否则 readability
    title_selector: str | None = None  # 标题选择器（缺省用 og:title / <title> / <h1>）
    author_selector: str | None = None  # 作者选择器（缺省用 meta author / JSON-LD）
    date_selector: str | None = None  # 日期选择器（缺省用 meta / JSON-LD / 首个日期 h2）
    date_is_first_h2: bool = False  # 部分站点（如 addyosmani）把日期写成正文首个 h2
    list_path_filter: str | None = None  # 站点地图过滤：仅保留 path 以此开头的 URL
    remove_selectors: list[str] = field(default_factory=list)  # 正文中的噪声节点


# 已配置的博客站点。新增站点在此注册即可。
BLOG_SITES: dict[str, BlogSiteConfig] = {
    "addyosmani.com": BlogSiteConfig(
        domain="addyosmani.com",
        sitemap_url="https://addyosmani.com/sitemap.xml",
        content_selector="article.post",
        date_is_first_h2=True,  # 日期以正文首个 h2 呈现（如 "July 6, 2026"）
        list_path_filter="/blog/",  # 站点地图同时含 /notes/ 等，仅爬 /blog/
        remove_selectors=["script", "style"],
    ),
}

# 未注册域名的兜底配置（显式 --source blog 时使用，走 readability 通用提取）。
DEFAULT_BLOG_CONFIG = BlogSiteConfig(domain="*", sitemap_url="")


# --------------------------------------------------------------------------- #
# 日期解析辅助
# --------------------------------------------------------------------------- #
_DATE_RE = re.compile(
    r"\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}"
    r"|\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}"
    r"|[A-Za-z]{3,}\s+\d{1,2},?\s+\d{4})\b"
)
_DATE_FORMATS = [
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%SZ",
    "%B %d, %Y",
    "%b %d, %Y",
    "%d %B %Y",
    "%d %b %Y",
]


def _parse_date(s: str) -> str:
    """尽量解析为 'YYYY-MM-DD HH:mm:ss'；无法解析则原样返回。"""
    s = (s or "").strip()
    if not s:
        return ""
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    return s


def _looks_like_date(s: str) -> bool:
    return bool(_DATE_RE.search(s or ""))


# --------------------------------------------------------------------------- #
# HTTP 辅助（静态站点，无需浏览器）
# --------------------------------------------------------------------------- #
def _http_get(url: str, referer: str | None = None, timeout: int = 20) -> str:
    headers = {"User-Agent": UA}
    if referer:
        headers["Referer"] = referer
    with sync_client() as client:
        r = client.get(url, follow_redirects=True, timeout=timeout, headers=headers)
    r.raise_for_status()
    return r.text


def _unescape_sitemap(text: str) -> str:
    """解码站点地图 XML 中的常见实体与 CDATA 包装。"""
    import html as html_mod
    text = text.strip()
    # 移除 CDATA 包装
    if text.startswith("<![CDATA[") and text.endswith("]]>"):
        text = text[9:-3]
    return html_mod.unescape(text)


def _parse_sitemap(xml: str, path_prefix: str | None = None, depth: int = 0) -> list[str]:
    """递归解析站点地图，支持嵌套 sitemap 索引。

    Returns:
        文章 URL 列表（已去重、已过滤 path_prefix）。
    """
    if depth > 3:
        return []  # 防止无限递归
    # 提取所有 <sitemap><loc> 和 <url><loc>（支持 CDATA 包裹）
    sitemap_locs = re.findall(r"<sitemap>\s*<loc>(.*?)</loc>", xml, re.S)
    url_locs = re.findall(r"<url>\s*<loc>(.*?)</loc>", xml, re.S)

    urls: list[str] = []
    for raw in url_locs:
        u = _unescape_sitemap(raw)
        if u.startswith("http"):
            if not path_prefix or urlparse(u).path.startswith(path_prefix):
                urls.append(u)

    # 递归处理嵌套 sitemap
    for raw in sitemap_locs:
        sub_url = _unescape_sitemap(raw)
        if sub_url.startswith("http") and sub_url != sitemap_locs:
            try:
                sub_xml = _http_get(sub_url)
                urls.extend(_parse_sitemap(sub_xml, path_prefix=path_prefix, depth=depth + 1))
            except Exception as e:
                print(f"  ⚠ 跳过子站点地图 {sub_url}: {e}")

    return sorted(set(urls))


def discover_from_sitemap(sitemap_url: str, path_prefix: str | None = None) -> list[str]:
    """解析站点地图（含嵌套 sitemap 索引），返回文章 URL 列表（可按 path 前缀过滤）。"""
    xml = _http_get(sitemap_url)
    return _parse_sitemap(xml, path_prefix=path_prefix)


# --------------------------------------------------------------------------- #
# 博客来源
# --------------------------------------------------------------------------- #
class BlogSource(Source):
    name = "blog"

    # ---- 路由 / 归一化 ---- #
    def _config_for(self, url: str) -> BlogSiteConfig:
        host = (urlparse(url).hostname or "").lower()
        for cfg in BLOG_SITES.values():
            if host == cfg.domain or host.endswith("." + cfg.domain):
                return cfg
        return DEFAULT_BLOG_CONFIG

    def match(self, url: str) -> bool:
        # 仅对“已注册域名”自动识别，避免抢占未知 URL（未知 URL 需显式 --source blog）
        return self._config_for(url).domain != "*"

    def normalize(self, url: str) -> str:
        p = urlparse(url.strip())
        scheme = p.scheme or "https"
        netloc = p.netloc
        path = p.path.rstrip("/")
        # 保留 query：WordPress ?p=123、Medium ?source= 等依赖 query 的站点需要
        query = p.query
        return urlunparse((scheme, netloc, path, "", query, "")) or url

    def article_id(self, url: str) -> str:
        # 以「域名无关的核心路径」作为去重键
        p = urlparse(self.normalize(url))
        return (p.path or "/").rstrip("/")

    # ---- 提取 ---- #
    @staticmethod
    def _jsonld(soup: BeautifulSoup) -> dict | None:
        for s in soup.find_all("script", type="application/ld+json"):
            try:
                obj = json.loads(s.get_text())
            except Exception:
                continue
            if isinstance(obj, dict):
                # 单个对象时也校验 @type，避免取到 WebSite/BreadcrumbList 等
                t = obj.get("@type", "")
                if isinstance(t, str) and t.lower() in ("blogposting", "article", "newsarticle", "techarticle", "scholarlyarticle"):
                    return obj
                # 含 @graph 的图结构也扫描
                graph = obj.get("@graph")
                if isinstance(graph, list):
                    for node in graph:
                        if isinstance(node, dict) and node.get("@type") in (
                            "BlogPosting", "Article", "NewsArticle", "TechArticle", "ScholarlyArticle",
                        ):
                            return node
            if isinstance(obj, list):
                for o in obj:
                    if isinstance(o, dict) and o.get("@type") in (
                        "BlogPosting",
                        "Article",
                        "NewsArticle",
                        "TechArticle",
                        "ScholarlyArticle",
                    ):
                        return o
        return None

    def _select_content(self, soup: BeautifulSoup, cfg: BlogSiteConfig):
        if cfg.content_selector:
            el = soup.select_one(cfg.content_selector)
            if el:
                return el
        art = soup.find("article")
        if art:
            return art
        # 兜底：readability 抽取正文（懒加载，未安装则不启用）
        try:
            from readability import Document

            return BeautifulSoup(Document(str(soup)).summary(), "html.parser")
        except Exception:
            return soup.body or soup

    def _title(self, soup: BeautifulSoup, cfg: BlogSiteConfig) -> str:
        og = soup.find("meta", attrs={"property": "og:title"})
        if og and og.get("content"):
            return og["content"].strip()
        if cfg.title_selector:
            el = soup.select_one(cfg.title_selector)
            if el:
                return el.get_text(strip=True)
        h1 = soup.find("h1")
        if h1:
            return h1.get_text(strip=True)
        t = soup.find("title")
        if t:
            return t.get_text(strip=True)
        return ""

    def _author(self, soup: BeautifulSoup, cfg: BlogSiteConfig) -> str:
        am = soup.find("meta", attrs={"name": "author"})
        if am and am.get("content"):
            return am["content"].strip()
        if cfg.author_selector:
            el = soup.select_one(cfg.author_selector)
            if el:
                return el.get_text(strip=True)
        ld = self._jsonld(soup)
        if ld:
            author = ld.get("author")
            if isinstance(author, dict):
                return (author.get("name") or "").strip()
            if isinstance(author, str):
                return author.strip()
        return ""

    def _date(self, soup: BeautifulSoup, cfg: BlogSiteConfig, content) -> str:
        pm = soup.find("meta", attrs={"property": "article:published_time"}) or soup.find(
            "meta", attrs={"property": "article:modified_time"}
        )
        if pm and pm.get("content"):
            d = _parse_date(pm["content"])
            if d:
                return d
        if cfg.date_selector:
            el = content.select_one(cfg.date_selector) or soup.select_one(cfg.date_selector)
            if el:
                d = _parse_date(el.get_text(strip=True))
                if d:
                    return d
        ld = self._jsonld(soup)
        if ld and ld.get("datePublished"):
            d = _parse_date(ld["datePublished"])
            if d:
                return d
        if cfg.date_is_first_h2:
            h2 = content.find("h2")
            if h2:
                txt = h2.get_text(strip=True)
                if _looks_like_date(txt):
                    d = _parse_date(txt)
                    if d:
                        h2.decompose()
                        return d
        return ""

    def _extract(self, soup: BeautifulSoup, cfg: BlogSiteConfig, url: str):
        content = self._select_content(soup, cfg)
        if content is None:
            raise RuntimeError("未能定位正文内容")
        for sel in cfg.remove_selectors:
            for tag in content.select(sel):
                tag.decompose()

        title = self._title(soup, cfg)
        # 去掉正文中与标题重复的 h1，避免 Markdown 顶部重复
        if title:
            h1 = content.find("h1")
            if h1 and h1.get_text(strip=True) == title:
                h1.decompose()

        author = self._author(soup, cfg)
        date = self._date(soup, cfg, content)

        img_urls: list[str] = []
        seen: set[str] = set()
        for img in content.find_all("img"):
            src = img.get("src") or img.get("data-src")
            if not src or src.startswith("data:"):
                continue
            if src in seen:
                continue
            seen.add(src)
            img_urls.append(src)

        meta = {
            "title": title,
            "author": author,
            "publish_time": date,
            "source_url": url,
        }
        return str(content), meta, img_urls

    # ---- 抓取 ---- #
    async def fetch(
        self, url: str, output_dir: Path | None = None, no_proxy: bool = True
    ) -> Path:
        if output_dir is None:
            output_dir = DEFAULT_OUTPUT_DIR

        cfg = self._config_for(url)
        norm = self.normalize(url)
        print(f"🔄 正在抓取博客: {norm}")

        html = await asyncio.to_thread(_http_get, norm)
        soup = BeautifulSoup(html, "html.parser")
        content_html, meta, img_urls = self._extract(soup, cfg, norm)
        if not content_html.strip():
            raise RuntimeError("未能提取到正文内容")

        md = convert_to_markdown(content_html, [])

        # 图片本地化（按站点来源设置 Referer）
        safe_title = re.sub(r'[/\\?%*:|"<>]', "_", meta["title"] or norm)[:80]
        article_dir = output_dir / safe_title
        img_dir = article_dir / "images"
        img_dir.mkdir(parents=True, exist_ok=True)
        referer = f"{urlparse(norm).scheme}://{urlparse(norm).netloc}"
        url_map = await download_all_images(
            img_urls, img_dir, proxy=None if no_proxy else _USE_ENV_PROXY, referer=referer,
            article_url=norm,
        )
        md = replace_image_urls(md, url_map)

        result = build_markdown(meta, md)
        md_path = article_dir / f"{safe_title}.md"
        md_path.write_text(result, encoding="utf-8")

        print(f"✅ 已保存: {md_path}")
        print(f"📊 Markdown 约 {len(md)} 字符")
        return md_path


# 供测试 / 脚本直接调用的模块级函数（自动归一化 URL）
_SOURCE = BlogSource()


async def fetch_article(
    url: str, output_dir: Path | None = None, no_proxy: bool = True
) -> Path:
    return await _SOURCE.fetch(
        _SOURCE.normalize(url), output_dir=output_dir, no_proxy=no_proxy
    )
