/**
 * 代理 / HTTP 客户端构造与解码的回归测试（不依赖网络）。
 *
 * 覆盖真实踩坑：`NO_PROXY` 里写 IPv6 CIDR（`::1/128`）时，部分 HTTP 客户端在
 * 构造阶段就会抛错。这里保证「直连」与「环境代理」两种模式都不会因此崩掉。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { HttpClient, cleanNoProxy, decodeBody, resolveDispatcher } from '../../src/core/http';

// 用户 .zshrc 里的真实写法
const BROKEN_NO_PROXY =
  '127.0.0.1,localhost,::1,127.0.0.0/8,::1/128,' +
  '192.168.0.200,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,*.local';

const ENV_KEYS = ['NO_PROXY', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

describe('cleanNoProxy', () => {
  it('去掉 IPv6 CIDR 掩码，其它条目原样保留', () => {
    const cleaned = cleanNoProxy(BROKEN_NO_PROXY);
    expect(cleaned).not.toContain('::1/128');
    expect(cleaned.split(',')).toContain('::1');
    expect(cleaned).toContain('192.168.0.0/16');
    expect(cleaned).toContain('*.local');
  });

  it('空值 / 多余逗号不产生空条目', () => {
    expect(cleanNoProxy('')).toBe('');
    expect(cleanNoProxy('a,,  ,b')).toBe('a,b');
  });
});

describe('resolveDispatcher', () => {
  const saved = snapshotEnv();
  afterEach(() => restoreEnv(saved));

  it('direct 模式不构造代理 dispatcher', () => {
    expect(resolveDispatcher('direct')).toEqual({ dispatcher: undefined, degraded: false });
  });

  it('env 模式在畸形 NO_PROXY（::1/128）下仍能构造，且不污染环境变量', () => {
    process.env.NO_PROXY = BROKEN_NO_PROXY;
    process.env.no_proxy = BROKEN_NO_PROXY;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';

    const resolved = resolveDispatcher('env');

    expect(resolved.dispatcher).toBeDefined();
    expect(resolved.degraded).toBe(false);
    // 净化只发生在构造期间，退出后必须还原
    expect(process.env.NO_PROXY).toBe(BROKEN_NO_PROXY);
    expect(process.env.no_proxy).toBe(BROKEN_NO_PROXY);
  });

  it('显式代理 URL 非法时降级为直连而不是抛错', () => {
    const resolved = resolveDispatcher('not a valid url');
    expect(resolved.dispatcher).toBeUndefined();
    expect(resolved.degraded).toBe(true);
    expect(resolved.reason).toBeTruthy();
  });
});

describe('HttpClient', () => {
  it('直连客户端不读取代理环境变量，畸形 NO_PROXY 也不影响构造', () => {
    const saved = snapshotEnv();
    process.env.NO_PROXY = BROKEN_NO_PROXY;
    process.env.no_proxy = BROKEN_NO_PROXY;
    process.env.ALL_PROXY = 'socks5://127.0.0.1:7897';
    try {
      expect(() => new HttpClient('direct')).not.toThrow();
    } finally {
      restoreEnv(saved);
    }
  });
});

describe('decodeBody', () => {
  it('UTF-8 页面按 UTF-8 解码', () => {
    const bytes = new TextEncoder().encode('<html><body>你好</body></html>');
    expect(decodeBody(bytes, 'text/html; charset=utf-8')).toContain('你好');
  });

  it('响应头声明 GBK 时按 GBK 解码（undici 的 text() 恒定按 UTF-8 会乱码）', () => {
    // "你好" 的 GBK 编码
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    const head = Buffer.from('<html><head><meta charset="gbk"></head><body>');
    const tail = Buffer.from('</body></html>');
    const bytes = new Uint8Array(Buffer.concat([head, gbk, tail]));

    expect(decodeBody(bytes, 'text/html; charset=gbk')).toContain('你好');
  });

  it('未知字符集不抛错，退回 UTF-8', () => {
    const bytes = new TextEncoder().encode('plain ascii');
    expect(decodeBody(bytes, 'text/html; charset=definitely-not-a-charset')).toBe('plain ascii');
  });
});
