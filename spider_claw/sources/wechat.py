"""微信公众号来源：反检测抓取 + 元数据提取 + 图片本地化 + Markdown 转换。"""
from __future__ import annotations

import asyncio
import html as html_mod
import re
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from bs4 import BeautifulSoup
from camoufox.async_api import AsyncCamoufox

from .base import Source
from ..core.images import _USE_ENV_PROXY, download_all_images
from ..core.markdownify_ import build_markdown, convert_to_markdown, replace_image_urls

DEFAULT_OUTPUT_DIR = Path.cwd() / "output"


def normalize_wechat_url(raw: str) -> str:
    """Normalize a pasted WeChat article URL.

    Handles common issues:
    - Terminal/zsh auto-escaped backslashes (``\\&``, ``\\?``)
    - HTML entities (``&amp;``)
    - Missing or http scheme on mp.weixin.qq.com
    - Stray quote wrappers from copy-paste
    """
    s = str(raw or "").strip()
    if not s:
        return s

    # Strip wrapping quotes / angle brackets
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        s = s[1:-1].strip()
    if s.startswith("<") and s.endswith(">"):
        s = s[1:-1].strip()

    # Remove backslash escapes before URL-significant characters
    s = re.sub(r"\\+([:/&?=#%])", r"\1", s)

    # Decode HTML entities
    s = html_mod.unescape(s)

    # Allow bare hostnames
    if s.startswith("mp.weixin.qq.com/") or s.startswith("//mp.weixin.qq.com/"):
        s = "https://" + s.lstrip("/")

    # Force https for mp.weixin.qq.com
    parsed = urlparse(s)
    if parsed.scheme in ("http", "https") and (parsed.hostname or "").lower() == "mp.weixin.qq.com":
        s = urlunparse(("https", "mp.weixin.qq.com", parsed.path, parsed.params, parsed.query, parsed.fragment))

    return s


def extract_publish_time(html: str) -> str:
    """从 HTML script 标签中提取发布时间"""
    # JsDecode 格式
    m = re.search(r"create_time\s*:\s*JsDecode\('([^']+)'\)", html)
    if m:
        val = m.group(1)
        try:
            ts = int(val)
            if ts > 0:
                return format_timestamp(ts)
        except ValueError:
            return val

    # 纯数字格式
    m = re.search(r"create_time\s*:\s*'(\d+)'", html)
    if m:
        return format_timestamp(int(m.group(1)))

    # 兼容双引号与 = 赋值风格
    m = re.search(r'create_time\s*[:=]\s*["\']?(\d+)["\']?', html)
    if m:
        return format_timestamp(int(m.group(1)))

    return ""


def format_timestamp(ts: int) -> str:
    """Unix timestamp (秒) -> 'YYYY-MM-DD HH:mm:ss' (Asia/Shanghai, UTC+8)"""
    from datetime import datetime, timezone, timedelta

    tz = timezone(timedelta(hours=8))
    dt = datetime.fromtimestamp(ts, tz=tz)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def extract_metadata(soup: BeautifulSoup, html: str) -> dict:
    """提取文章元数据: 标题、作者、发布时间"""
    title_el = soup.select_one("#activity-name")
    author_el = soup.select_one("#js_name")
    return {
        "title": title_el.get_text(strip=True) if title_el else "",
        "author": author_el.get_text(strip=True) if author_el else "",
        "publish_time": extract_publish_time(html),
    }


def process_content(soup: BeautifulSoup) -> tuple[str, list[dict], list[str]]:
    """
    预处理正文 DOM：修复图片、处理代码块、移除噪声元素。
    返回 (content_html, code_blocks, img_urls)
    """
    content_el = soup.select_one("#js_content")
    if not content_el:
        return "", [], []

    # 1) 图片: data-src -> src (微信懒加载)
    for img in content_el.find_all("img"):
        data_src = img.get("data-src")
        if data_src:
            img["src"] = data_src

    # 2) 代码块: 提取 code-snippet__fix 内容，替换为占位符
    code_blocks = []
    for el in content_el.select(".code-snippet__fix"):
        # 移除行号
        for line_idx in el.select(".code-snippet__line-index"):
            line_idx.decompose()

        pre = el.select_one("pre[data-lang]")
        lang = pre.get("data-lang", "") if pre else ""

        lines = []
        for code_tag in el.find_all("code"):
            text = code_tag.get_text()
            # 跳过 CSS counter 泄漏的垃圾行
            if re.match(r"^[ce]?ounter\(line", text):
                continue
            lines.append(text)

        if not lines:
            lines.append(el.get_text())

        placeholder = f"CODEBLOCK-PLACEHOLDER-{len(code_blocks)}"
        code_blocks.append({"lang": lang, "code": "\n".join(lines)})
        el.replace_with(soup.new_tag("p", string=placeholder))

    # 3) 移除噪声元素
    for sel in ("script", "style", ".qr_code_pc", ".reward_area"):
        for tag in content_el.select(sel):
            tag.decompose()

    # 4) 收集图片 URL（去重）
    img_urls = []
    seen = set()
    for img in content_el.find_all("img", src=True):
        src = img["src"]
        if src not in seen:
            seen.add(src)
            img_urls.append(src)

    return str(content_el), code_blocks, img_urls


class WechatSource(Source):
    name = "wechat"

    def normalize(self, url: str) -> str:
        return normalize_wechat_url(url)

    def match(self, url: str) -> bool:
        try:
            host = urlparse(url).hostname or ""
            return host.lower() == "mp.weixin.qq.com"
        except Exception:
            return False

    def article_id(self, url: str) -> str:
        # 核心路径（去参、去锚点）作为微信文章去重键
        return normalize_wechat_url(url).split("?")[0].split("#")[0].rstrip("/")

    async def fetch(
        self, url: str, output_dir: Path | None = None, no_proxy: bool = True
    ) -> Path:
        if output_dir is None:
            output_dir = DEFAULT_OUTPUT_DIR

        if not url.startswith("https://mp.weixin.qq.com/"):
            raise RuntimeError("无效的微信文章 URL (mp.weixin.qq.com)")

        print(f"🔄 正在抓取: {url}")

        # 使用 Camoufox 反检测浏览器获取完整 HTML
        print("🦊 启动 Camoufox 浏览器...")
        async with AsyncCamoufox(headless=True) as browser:
            page = await browser.new_page()
            await page.goto(url, wait_until="domcontentloaded")
            # 等待正文加载
            try:
                await page.wait_for_selector("#js_content", timeout=10000)
            except Exception:
                pass  # 超时也继续尝试解析
            # 额外等待确保 JS 执行完毕
            await asyncio.sleep(2)
            html = await page.content()

        # 解析
        soup = BeautifulSoup(html, "html.parser")

        # 提取元数据
        meta = extract_metadata(soup, html)
        if not meta["title"]:
            output_dir.mkdir(parents=True, exist_ok=True)
            debug_path = output_dir / "debug.html"
            debug_path.write_text(html, encoding="utf-8")
            raise RuntimeError(
                "未能提取到文章标题，可能触发了验证码；已保存原始 HTML 到 "
                f"{debug_path}"
            )

        meta["source_url"] = url
        print(f"📄 标题: {meta['title']}")
        print(f"👤 作者: {meta['author']}")
        print(f"📅 时间: {meta['publish_time']}")

        # 处理正文
        content_html, code_blocks, img_urls = process_content(soup)
        if not content_html:
            raise RuntimeError("未能提取到正文内容")

        # 转 Markdown
        md = convert_to_markdown(content_html, code_blocks)

        # 下载图片
        safe_title = re.sub(r'[/\\?%*:|"<>]', "_", meta["title"])[:80]
        article_dir = output_dir / safe_title
        img_dir = article_dir / "images"
        img_dir.mkdir(parents=True, exist_ok=True)

        url_map = await download_all_images(
            img_urls, img_dir, proxy=None if no_proxy else _USE_ENV_PROXY,
            referer="https://mp.weixin.qq.com/",
        )
        md = replace_image_urls(md, url_map)

        # 写入文件
        result = build_markdown(meta, md)
        md_path = article_dir / f"{safe_title}.md"
        md_path.write_text(result, encoding="utf-8")

        print(f"✅ 已保存: {md_path}")
        print(f"📊 Markdown 约 {len(md)} 字符")
        return md_path


# 供测试 / 脚本直接调用的模块级函数（自动归一化 URL）
_SOURCE = WechatSource()


async def fetch_article(
    url: str, output_dir: Path | None = None, no_proxy: bool = True
) -> Path:
    return await _SOURCE.fetch(
        _SOURCE.normalize(url), output_dir=output_dir, no_proxy=no_proxy
    )
