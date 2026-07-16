"""尚未实现的来源占位实现。"""
from __future__ import annotations

from pathlib import Path

from .base import Source


class StubSource(Source):
    # 子类覆盖 name
    name = "stub"

    def match(self, url: str) -> bool:
        return False

    def article_id(self, url: str) -> str:
        return url

    async def fetch(
        self, url: str, output_dir: Path | None = None, no_proxy: bool = True
    ) -> Path:
        raise NotImplementedError(f"来源「{self.name}」尚未实现，敬请期待。")
