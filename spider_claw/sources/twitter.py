"""Twitter / X 来源（占位，尚未实现）。"""
from __future__ import annotations

from .stub import StubSource


class TwitterSource(StubSource):
    name = "twitter"
    # TODO: 基于登录态/会话抓取推文与线程，处理鉴权、anti-bot、限流。
