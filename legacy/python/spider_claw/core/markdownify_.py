"""HTML -> Markdown 转换与图片链接替换（与具体来源无关）。"""
from __future__ import annotations

import re

import markdownify


def convert_to_markdown(content_html: str, code_blocks: list[dict]) -> str:
    """HTML -> Markdown，还原代码块，清理格式"""
    md = markdownify.markdownify(
        content_html,
        heading_style="ATX",
        bullets="-",
        convert=["p", "h1", "h2", "h3", "h4", "h5", "h6",
                 "strong", "em", "a", "img", "ul", "ol", "li",
                 "blockquote", "br", "hr", "table", "thead",
                 "tbody", "tr", "th", "td", "pre", "code"],
    )

    # 还原代码块占位符
    for i, block in enumerate(code_blocks):
        placeholder = f"CODEBLOCK-PLACEHOLDER-{i}"
        fenced = f"\n```{block['lang']}\n{block['code']}\n```\n"
        md = md.replace(placeholder, fenced)

    # 清理 &nbsp; 残留
    md = md.replace("\u00a0", " ")
    # 清理多余空行
    md = re.sub(r"\n{4,}", "\n\n\n", md)
    # 清理行尾多余空格
    md = re.sub(r"[ \t]+$", "", md, flags=re.MULTILINE)

    return md


def replace_image_urls(md: str, url_map: dict[str, str]) -> str:
    """替换 Markdown 中的远程图片链接为本地路径"""
    # Use exact URL matching to avoid regex edge cases such as ')' in URL.
    for remote_url, local_path in url_map.items():
        pattern = re.compile(r"!\[([^\]]*)\]\(" + re.escape(remote_url) + r"\)")
        md = pattern.sub(lambda m: f"![{m.group(1)}]({local_path})", md)
    return md


def build_markdown(meta: dict, body_md: str) -> str:
    """拼接最终 Markdown 文件内容（来源无关的通用头信息）"""
    lines = [f"# {meta['title']}", ""]
    if meta.get("author"):
        lines.append(f"> 作者: {meta['author']}")
    if meta.get("publish_time"):
        lines.append(f"> 发布时间: {meta['publish_time']}")
    if meta.get("source_url"):
        lines.append(f"> 原文链接: {meta['source_url']}")
    if meta.get("author") or meta.get("publish_time") or meta.get("source_url"):
        lines.append("")
    lines.extend(["---", ""])
    return "\n".join(lines) + body_md
