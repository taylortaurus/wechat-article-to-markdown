"""spider-claw 命令行入口：统一路由到各来源（source）的抓取能力。

路由规则：
- 显式 --source 优先于 URL 自动识别；
- 未指定 --source 时按 URL 域名自动识别来源；
- 列表模式下每条可带 source 字段，缺省则自动识别、再回退 wechat（向后兼容）。
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from urllib.parse import urlparse

from .core.url_list import load_url_list, save_url_list, _now
from .sources import BY_NAME, detect_source
from .sources.base import Source

DEFAULT_OUTPUT_DIR = Path.cwd() / "output"
DEFAULT_LIST_FILE = Path.cwd() / "url-list.json"


def _resolve_source(url: str, source_name: str | None) -> Source:
    if source_name:
        src = BY_NAME.get(source_name)
        if not src:
            print(f"❌ 未知 source: {source_name}；可选: {', '.join(BY_NAME)}")
            sys.exit(1)
        return src
    src = detect_source(url)
    if src is None:
        print(f"❌ 无法从 URL 识别来源: {url}")
        print(f"   已支持: {', '.join(BY_NAME)}；可用 --source 显式指定")
        sys.exit(1)
    return src


async def _run_list(list_path: Path, output_dir: Path, no_proxy: bool) -> None:
    """按 url-list.json 遍历爬取，已 done 的跳过，结果回写文件以支持续爬。

    去重键为 (source, article_id)，同来源下同篇文章（含不同追踪参数、重复列出）
    只爬一次。
    """
    items = load_url_list(list_path)
    if not items:
        print("📋 列表为空，没有待爬取的 URL。")
        return

    cwd = Path.cwd()
    total = len(items)
    done = skipped = failed = 0
    seen: set[str] = set()

    for idx, item in enumerate(items, 1):
        url = item.get("url", "")
        if not url:
            continue

        # 解析来源：优先 item.source，其次 URL 自动识别，最后回退 wechat
        if item.get("source"):
            src = BY_NAME.get(item["source"])
            if src is None:
                print(f"  ❌ [{idx}/{total}] 未知 source: {item['source']}")
                item["status"] = "failed"
                item["error"] = f"未知 source: {item['source']}"
                item["updated_at"] = _now()
                failed += 1
                save_url_list(list_path, items)
                continue
        else:
            src = detect_source(url) or BY_NAME.get("wechat")

        key = f"{src.name}:{src.article_id(url)}"
        if key in seen:
            print(f"⏭️  [{idx}/{total}] 重复 URL，跳过: {url}")
            skipped += 1
            continue

        if item.get("status") == "done":
            print(f"⏭️  [{idx}/{total}] 已爬取，跳过: {url}")
            skipped += 1
            seen.add(key)
            continue

        norm = src.normalize(url)
        if norm != url:
            print("ℹ️  已自动清理 URL 中的转义字符 / HTML 实体。")
        print(f"🔜  [{idx}/{total}] 开始 [{src.name}]: {norm}")
        try:
            md_path = await src.fetch(norm, output_dir=output_dir, no_proxy=no_proxy)
            try:
                rel = md_path.relative_to(cwd)
            except ValueError:
                rel = md_path
            item["status"] = "done"
            item["source"] = src.name
            item["output"] = str(rel)
            item["updated_at"] = _now()
            item.pop("error", None)
            done += 1
        except Exception as e:
            print(f"  ❌ 抓取失败: {e}")
            item["status"] = "failed"
            item["error"] = str(e)
            item["updated_at"] = _now()
            failed += 1

        seen.add(key)
        # 每条处理后写回，保证中断也能续爬
        save_url_list(list_path, items)

    print(
        f"\n🏁 完成：成功 {done} / 跳过 {skipped} / 失败 {failed}（共 {total}）"
    )
    if failed:
        sys.exit(1)


async def _run_sitemap(sitemap_url: str, output_dir: Path, no_proxy: bool) -> None:
    """从站点地图发现博客文章，合并进 url-list.json 后复用列表续爬逻辑。"""
    from .sources.blog import BLOG_SITES, BlogSource, discover_from_sitemap

    host = (urlparse(sitemap_url).hostname or "").lower()
    cfg = None
    for c in BLOG_SITES.values():
        if host == c.domain or host.endswith("." + c.domain):
            cfg = c
            break
    prefix = cfg.list_path_filter if (cfg and cfg.list_path_filter) else None

    urls = discover_from_sitemap(sitemap_url, path_prefix=prefix)
    if not urls:
        print("🗺  站点地图中未发现可爬取的博客文章。")
        return
    print(f"🗺  站点地图发现 {len(urls)} 篇博客文章。")

    # 合并进 url-list.json（按 (source, article_id) 去重，支持续爬）
    list_path = DEFAULT_LIST_FILE
    try:
        items = load_url_list(list_path)
    except FileNotFoundError:
        items = []

    src = BlogSource()
    existing = {(it.get("source"), src.article_id(it["url"])) for it in items if it.get("url")}
    added = 0
    for u in urls:
        key = ("blog", src.article_id(u))
        if key in existing:
            continue
        items.append({"url": u, "source": "blog"})
        existing.add(key)
        added += 1
    save_url_list(list_path, items)
    print(f"➕ 新增 {added} 条到 {list_path}（已存在则跳过），开始爬取…")

    await _run_list(list_path, output_dir=output_dir, no_proxy=no_proxy)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="多源文章抓取 & Markdown 转换工具 (spider-claw)"
    )
    parser.add_argument(
        "url",
        nargs="?",
        default=None,
        help="单个文章 URL；留空则按 --list 指定的 JSON 列表遍历爬取",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"输出目录 (默认: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument(
        "--list",
        type=Path,
        default=DEFAULT_LIST_FILE,
        help=f"待爬取 URL 列表 JSON (默认: {DEFAULT_LIST_FILE})",
    )
    parser.add_argument(
        "--source",
        choices=list(BY_NAME),
        default=None,
        help="显式指定来源（覆盖 URL 自动识别）",
    )
    parser.add_argument(
        "--proxy",
        action="store_true",
        default=False,
        help="图片下载走环境代理（默认直连，忽略 ALL_PROXY/HTTPS_PROXY 等环境变量）",
    )
    parser.add_argument(
        "--from-sitemap",
        metavar="SITEMAP_URL",
        default=None,
        help="从站点地图批量发现博客文章并爬取（自动按站点规则过滤，并写入 url-list.json 续爬）",
    )

    args = parser.parse_args()
    no_proxy = not args.proxy

    # 站点地图批量模式
    if args.from_sitemap:
        try:
            asyncio.run(
                _run_sitemap(args.from_sitemap, output_dir=args.output, no_proxy=no_proxy)
            )
        except (FileNotFoundError, ValueError) as e:
            print(f"❌ {e}")
            sys.exit(1)
        return

    # 单条模式
    if args.url:
        src = _resolve_source(args.url, args.source)
        norm = src.normalize(args.url)
        if norm != args.url:
            print("ℹ️  已自动清理 URL 中的转义字符 / HTML 实体。")
        try:
            asyncio.run(
                src.fetch(norm, output_dir=args.output, no_proxy=no_proxy)
            )
        except Exception as e:
            print(f"❌ 抓取失败: {e}")
            sys.exit(1)
        return

    # 列表模式
    try:
        asyncio.run(
            _run_list(args.list, output_dir=args.output, no_proxy=no_proxy)
        )
    except (FileNotFoundError, ValueError) as e:
        print(f"❌ {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
