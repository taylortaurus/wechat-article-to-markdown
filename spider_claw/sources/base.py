"""所有来源的抽象基类：统一接口，新增来源只需实现这几个方法。"""
from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path


class Source(ABC):
    # 来源标识，用于 --source 与 url-list 的 source 字段
    name: str

    def normalize(self, url: str) -> str:
        """清理 URL（默认原样返回，微信等可覆盖）。"""
        return url

    @abstractmethod
    def match(self, url: str) -> bool:
        """该来源是否能处理此 URL（用于自动识别）。"""

    @abstractmethod
    def article_id(self, url: str) -> str:
        """文章的规范化去重键（不含来源前缀）。"""

    @abstractmethod
    async def fetch(
        self, url: str, output_dir: Path | None = None, no_proxy: bool = True
    ) -> Path:
        """抓取单篇文章，返回生成的 Markdown 文件绝对路径。"""
