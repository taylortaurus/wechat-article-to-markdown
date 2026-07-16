"""url-list.json 的读取 / 回写 / 时间戳工具（来源无关）。"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def load_url_list(path: Path) -> list[dict]:
    """读取 url-list.json，归一化为 [{url, source?, status?, output?, updated_at?, error?}, ...]"""
    if not path.exists():
        raise FileNotFoundError(
            f"未找到列表文件: {path}\n"
            f"请创建该文件并填入 URL（见 README），或改用 `spider-claw \"<url>\"` 单条抓取。"
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"{path} 不是合法 JSON: {e}")

    if isinstance(data, dict) and "urls" in data:
        raw = data["urls"]
    elif isinstance(data, list):
        raw = data
    else:
        raise ValueError(f"{path} 顶层应为数组，或含 'urls' 字段的对象")

    items: list[dict] = []
    for entry in raw:
        if isinstance(entry, str):
            items.append({"url": entry})
        elif isinstance(entry, dict) and entry.get("url"):
            items.append(entry)
        else:
            print(f"  ⚠️ 跳过无效条目: {entry!r}")
    return items


def save_url_list(path: Path, items: list[dict]) -> None:
    """将列表（含爬取结果）写回 JSON 文件"""
    path.write_text(
        json.dumps(items, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
