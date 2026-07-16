"""图片并发下载（与具体来源无关）。"""
from __future__ import annotations

import asyncio
import re
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx

IMAGE_CONCURRENCY = 5
# 哨兵：表示"使用 httpx 默认行为（读取环境变量中的代理）"
_USE_ENV_PROXY = object()


def _resolve_img_url(img_url: str, article_url: str | None) -> str:
    """将图片 URL 解析为绝对 URL。

    处理以下情况：
    - 协议相对 (``//cdn.example.com/img.jpg``) → 补 https:
    - 绝对路径 (``/assets/img.jpg``) → 基于 article_url 拼接
    - 相对路径 (``../assets/img.jpg``) → 基于 article_url 拼接
    - 已是绝对 URL → 原样返回
    """
    url = img_url.strip()
    if url.startswith("//"):
        return f"https:{url}"
    if url.startswith("http://") or url.startswith("https://"):
        return url
    if article_url:
        return urljoin(article_url, url)
    return url


async def download_image(
    client: httpx.AsyncClient,
    img_url: str,
    img_dir: Path,
    index: int,
    semaphore: asyncio.Semaphore,
    referer: str | None = None,
    article_url: str | None = None,
) -> tuple[str, str | None]:
    """下载单张图片到本地，返回 (remote_url, local_relative_path | None)"""
    async with semaphore:
        try:
            url = _resolve_img_url(img_url, article_url)

            # 推断扩展名
            ext_match = re.search(r"wx_fmt=(\w+)", url) or re.search(
                r"\.(\w{3,4})(?:\?|$)", url
            )
            ext = ext_match.group(1) if ext_match else "png"

            filename = f"img_{index:03d}.{ext}"
            filepath = img_dir / filename

            headers = {"Referer": referer} if referer else None
            resp = await client.get(url, headers=headers, timeout=15.0)
            resp.raise_for_status()
            filepath.write_bytes(resp.content)
            return img_url, f"images/{filename}"
        except Exception as e:
            print(f"  ⚠ 图片下载失败: {e}")
            return img_url, None


async def download_all_images(
    img_urls: list[str],
    img_dir: Path,
    proxy=_USE_ENV_PROXY,
    referer: str | None = None,
    article_url: str | None = None,
) -> dict[str, str]:
    """并发下载所有图片，返回 {remote_url: local_path} 映射

    Args:
        proxy: 传入 httpx 的代理。默认使用哨兵值 _USE_ENV_PROXY（读取环境变量的代理）；
               传入 None 表示禁用代理、直接连接。
        referer: 图片请求携带的 Referer（部分站点防盗链需要）；None 表示不携带。
        article_url: 文章原始 URL，用于将相对路径图片解析为绝对 URL。
    """
    if not img_urls:
        return {}

    print(f"🖼  下载 {len(img_urls)} 张图片 (并发 {IMAGE_CONCURRENCY})...")
    semaphore = asyncio.Semaphore(IMAGE_CONCURRENCY)

    if proxy is _USE_ENV_PROXY:
        client_cm = httpx.AsyncClient()
    else:
        # proxy 为 None 时显式禁用环境代理（直连）
        client_cm = httpx.AsyncClient(proxy=proxy)

    async with client_cm as client:
        tasks = [
            download_image(
                client, url, img_dir, i + 1, semaphore,
                referer=referer, article_url=article_url,
            )
            for i, url in enumerate(img_urls)
        ]
        results = await asyncio.gather(*tasks)

    url_map = {}
    for remote_url, local_path in results:
        if local_path:
            url_map[remote_url] = local_path

    downloaded = sum(1 for v in url_map.values() if v)
    print(f"  ✅ {downloaded}/{len(img_urls)}")
    return url_map
