"""HTTP 客户端工厂：统一处理代理配置，并规避 httpx 对环境变量的解析缺陷。

背景（真实踩坑）：
    httpx 在 ``trust_env=True`` 时会解析 ``*_PROXY`` / ``NO_PROXY`` 环境变量，
    并在**构造 Client 时**就把它们转成 mount 规则。常见的 ``NO_PROXY`` 写法
    ``...::1/128...``（IPv6 CIDR）会生成 ``all://[::1/128]`` 这样的 pattern，
    解析时直接抛 ``httpx.InvalidURL("Invalid port: ':1'")`` —— 此时连
    ``httpx.AsyncClient(proxy=None)`` 都无法构造（``proxy=None`` 只表示"不指定代理"，
    仍会读取环境变量），整个抓取流程在建客户端这一步就崩掉。

因此这里统一提供两个工厂函数：
    * 直连（``proxy=None``）→ 真正关闭 env 代理（``trust_env=False``）；
    * 走环境代理 → 先净化 ``NO_PROXY``，仍解析失败则告警并降级为直连，绝不中断抓取。
"""
from __future__ import annotations

import os
import re
from contextlib import contextmanager

import httpx

# 哨兵：表示"使用 httpx 默认行为（读取环境变量中的代理）"
_USE_ENV_PROXY = object()

_NO_PROXY_KEYS = ("NO_PROXY", "no_proxy")
# IPv6 CIDR，如 ::1/128 —— httpx 会生成 all://[::1/128] 并解析失败
_IPV6_CIDR_RE = re.compile(r"^([0-9A-Fa-f:]*:[0-9A-Fa-f:]+)/\d+$")


def clean_no_proxy(value: str) -> str:
    """净化 NO_PROXY：`::1/128` → `::1`（httpx 无法解析带掩码的 IPv6）。

    其它条目（IPv4 CIDR、域名、`*` 等）原样保留。
    """
    parts: list[str] = []
    for raw in (value or "").split(","):
        host = raw.strip()
        if not host:
            continue
        m = _IPV6_CIDR_RE.match(host)
        if m:
            host = m.group(1)
        parts.append(host)
    return ",".join(parts)


@contextmanager
def _safe_proxy_env():
    """临时净化 NO_PROXY/np_proxy，退出时还原。"""
    saved = {k: os.environ.get(k) for k in _NO_PROXY_KEYS}
    for key, value in saved.items():
        if value:
            cleaned = clean_no_proxy(value)
            if cleaned != value:
                os.environ[key] = cleaned
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _client_kwargs(proxy) -> dict:
    if proxy is None:
        # 直连：连带关闭环境变量代理，避免被畸形 NO_PROXY 弄崩
        return {"proxy": None, "trust_env": False}
    if proxy is _USE_ENV_PROXY:
        return {"trust_env": True}
    return {"proxy": proxy, "trust_env": False}


def _build(factory, proxy, kwargs):
    """构造 client；环境代理不可解析时告警并降级为直连。"""
    common = {**_client_kwargs(proxy), **kwargs}
    if proxy is None:
        return factory(**common)

    with _safe_proxy_env():
        try:
            return factory(**common)
        except httpx.InvalidURL as exc:  # 畸形代理配置（如 ::1/128）
            message = str(exc)

    print(f"  ⚠ 代理配置无法解析（{message}），本次回退为直连")
    return factory(proxy=None, trust_env=False, **kwargs)


def async_client(proxy=_USE_ENV_PROXY, **kwargs) -> httpx.AsyncClient:
    """构造 AsyncClient。proxy=None 表示强制直连（忽略 *_PROXY 环境变量）。"""
    return _build(httpx.AsyncClient, proxy, kwargs)


def sync_client(proxy=_USE_ENV_PROXY, **kwargs) -> httpx.Client:
    """构造同步 Client。语义同 :func:`async_client`。"""
    return _build(httpx.Client, proxy, kwargs)
