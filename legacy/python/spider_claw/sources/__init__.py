"""来源（source）注册表：已实现的与占位 stub 都在此登记。"""
from __future__ import annotations

from .base import Source
from .blog import BlogSource
from .twitter import TwitterSource
from .wechat import WechatSource

SOURCES: list[Source] = [
    WechatSource(),
    TwitterSource(),
    BlogSource(),
]

BY_NAME: dict[str, Source] = {s.name: s for s in SOURCES}


def detect_source(url: str) -> Source | None:
    """按 URL 域名自动识别来源，未命中返回 None。"""
    for s in SOURCES:
        if s.match(url):
            return s
    return None
