"""代理 / HTTP 客户端构造的回归测试（不依赖网络）。

覆盖真实踩坑：NO_PROXY 含 IPv6 CIDR（::1/128）时，httpx 构造 Client 会抛
InvalidURL("Invalid port: ':1'")，导致默认直连模式也无法建客户端。
"""
import httpx
import pytest

from spider_claw.core.http import (
    _USE_ENV_PROXY,
    async_client,
    clean_no_proxy,
    sync_client,
)

# 用户 .zshrc 里的真实写法
BROKEN_NO_PROXY = (
    "127.0.0.1,localhost,::1,127.0.0.0/8,::1/128,"
    "192.168.0.200,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,*.local"
)


def test_clean_no_proxy_strips_ipv6_cidr():
    cleaned = clean_no_proxy(BROKEN_NO_PROXY)
    assert "::1/128" not in cleaned
    assert "::1" in cleaned.split(",")
    # 其它条目保持原样
    assert "192.168.0.0/16" in cleaned
    assert "*.local" in cleaned


def test_broken_env_kills_plain_httpx():
    """基线：未修复时 httpx 自身会在这一步炸掉。"""
    import os

    saved = os.environ.get("NO_PROXY")
    os.environ["NO_PROXY"] = BROKEN_NO_PROXY
    try:
        with pytest.raises(httpx.InvalidURL):
            httpx.Client(proxy=None)  # 仍会读 env
    finally:
        if saved is None:
            os.environ.pop("NO_PROXY", None)
        else:
            os.environ["NO_PROXY"] = saved


def test_direct_client_ignores_broken_env(monkeypatch):
    monkeypatch.setenv("NO_PROXY", BROKEN_NO_PROXY)
    monkeypatch.setenv("no_proxy", BROKEN_NO_PROXY)
    monkeypatch.setenv("ALL_PROXY", "socks5://127.0.0.1:7897")
    with sync_client(proxy=None) as c:
        assert c._mounts == {}


def test_async_direct_client_ignores_broken_env(monkeypatch):
    import asyncio

    monkeypatch.setenv("NO_PROXY", BROKEN_NO_PROXY)
    monkeypatch.setenv("no_proxy", BROKEN_NO_PROXY)

    async def _run():
        async with async_client(proxy=None) as c:
            return c._mounts

    assert asyncio.run(_run()) == {}


def test_env_proxy_client_survives_broken_env(monkeypatch):
    monkeypatch.setenv("NO_PROXY", BROKEN_NO_PROXY)
    monkeypatch.setenv("no_proxy", BROKEN_NO_PROXY)
    with sync_client(_USE_ENV_PROXY) as c:
        # 能构造出来即可；解析失败时会降级为直连
        assert isinstance(c, httpx.Client)
