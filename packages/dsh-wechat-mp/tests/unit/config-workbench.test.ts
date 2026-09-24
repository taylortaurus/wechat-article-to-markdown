/**
 * 可视化配置工作台的后端测试。
 *
 * 这块是新开的一个**可写**面（之前的路由全是只读），所以测试重点在：
 *  1. 白名单 —— 不在名单里的字段绝不能写进去
 *  2. 防跨站写 —— 缺自定义头的 POST 必须 403
 *  3. 坏输入 —— 坏 JSON / 超长 / 类型不对，都不能让插件炸
 */
import { describe, expect, it } from 'vitest';

import { ConfigStore, configPathFor, parseConfigPatch } from '../../src/output/config-store.js';
import { registerConfigRoutes } from '../../src/tools/config-routes.js';

describe('parseConfigPatch（白名单）', () => {
  it('只保留白名单内、类型正确的字段', () => {
    const patch = parseConfigPatch(
      JSON.stringify({
        outputRoot: '/data/out',
        layout: 'byAccountDate',
        pageDelayMs: 5000,
        fetchAfterSync: true,
        proxy: 'env',
      }),
    );
    expect(patch).toEqual({
      outputRoot: '/data/out',
      layout: 'byAccountDate',
      pageDelayMs: 5000,
      fetchAfterSync: true,
      proxy: 'env',
    });
  });

  it('**丢弃白名单之外的字段**（防止把内部字段写坏）', () => {
    const patch = parseConfigPatch(
      JSON.stringify({ rateLimitCodes: [1, 2], proxy: 'env', __proto__: { x: 1 } }),
    );
    expect(patch).toEqual({ proxy: 'env' });
  });

  it('类型不对的字段丢弃，其他保留', () => {
    const patch = parseConfigPatch(
      JSON.stringify({ pageDelayMs: '5000', maxArticles: 100, layout: 'weird' }),
    );
    expect(patch).toEqual({ maxArticles: 100 });
  });

  it('空串 / null 视为「不覆盖」', () => {
    expect(parseConfigPatch(JSON.stringify({ outputRoot: '', proxy: null }))).toEqual({});
  });

  it('坏 JSON / 非对象 → 空对象，不抛', () => {
    expect(parseConfigPatch('{{{')).toEqual({});
    expect(parseConfigPatch('[1,2]')).toEqual({});
    expect(parseConfigPatch('null')).toEqual({});
  });
});

describe('ConfigStore', () => {
  it('文件不存在时返回空对象', async () => {
    const store = new ConfigStore('/tmp/definitely-not-here-12345/config.json');
    await expect(store.load()).resolves.toEqual({});
  });

  it('保存后能读回', async () => {
    const dir = `/tmp/dsh-mp-cfg-${Date.now()}`;
    const file = `${dir}/config.json`;
    const store = new ConfigStore(file);
    await store.save({ outputRoot: '/x', pageDelayMs: 5000 });
    await expect(store.load()).resolves.toEqual({ outputRoot: '/x', pageDelayMs: 5000 });
  });

  it('configPathFor 与凭据文件同目录', () => {
    expect(configPathFor('/ws/.dsh-wechat-mp/session.json')).toBe('/ws/.dsh-wechat-mp/config.json');
  });
});

// ---- 路由 ----

/** 记录状态码与响应体的假 ServerResponse。 */
function makeRes(): { status: number; body: string; writeHead: (s: number) => void; end: (b?: string) => void } {
  const res = {
    status: 0,
    body: '',
    writeHead(status: number) {
      res.status = status;
    },
    end(body?: string) {
      res.body = body ?? '';
    },
  };
  return res;
}

function makeReq(options: { method?: string; headers?: Record<string, string>; body?: unknown }) {
  const payload = options.body === undefined ? '' : JSON.stringify(options.body);
  const listeners: Record<string, ((chunk?: Buffer) => void)[]> = {};
  const req = {
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    on(event: string, cb: (chunk?: Buffer) => void) {
      (listeners[event] ??= []).push(cb);
      return req;
    },
    destroy() {},
  };
  // 模拟 Node 的 data/end 事件时序
  queueMicrotask(() => {
    if (payload) for (const cb of listeners['data'] ?? []) cb(Buffer.from(payload));
    for (const cb of listeners['end'] ?? []) cb();
  });
  return req as never;
}

function makeServer() {
  const routes: { path: string; handler: (req: never, res: never) => Promise<void> }[] = [];
  return {
    routes,
    register(route: { path: string; handler: (req: never, res: never) => Promise<void> }) {
      routes.push(route);
      return () => {};
    },
  };
}

/** 用同一个假 runtime 跑一次请求并返回响应。 */
async function call(
  runtime: unknown,
  options: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: string }> {
  const server = makeServer();
  registerConfigRoutes(server as never, { runtime: runtime as never });
  const post = server.routes.find((r) => r.path === '/wechat-mp/config')!;
  const res = makeRes();
  await post.handler(makeReq(options) as never, res as never);
  return res;
}

function fakeRuntime(config: Record<string, unknown>) {
  const calls: unknown[] = [];
  return {
    calls,
    getConfig: () => config,
    updateConfig: async (patch: Record<string, unknown>) => {
      calls.push(patch);
      Object.assign(config, patch);
      return config;
    },
    getOutputRoot: () => ({ absolute: '/ws/output', origin: 'session' }),
    getListPath: () => ({ absolute: '/ws/url-list.json', origin: 'workspace' }),
    sessionPath: '/ws/.dsh-wechat-mp/session.json',
  } as never;
}

describe('配置路由', () => {
  it('GET 返回配置与路径来源', async () => {
    const res = await call(fakeRuntime({ pageDelayMs: 3000 }), { method: 'GET' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; config: unknown; paths: { outputRoot: string } };
    expect(body.ok).toBe(true);
    expect(body.paths.outputRoot).toBe('/ws/output');
  });

  it('带客户端头的 POST 能改配置', async () => {
    const runtime = fakeRuntime({ pageDelayMs: 3000 });
    const res = await call(runtime, {
      method: 'POST',
      headers: { 'x-dsh-wechat-mp-client': '1' },
      body: { pageDelayMs: 5000, layout: 'byAccountDate' },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).config.pageDelayMs).toBe(5000);
  });

  it('**缺客户端头的 POST 必须 403**（防跨站写）', async () => {
    const res = await call(fakeRuntime({}), {
      method: 'POST',
      body: { pageDelayMs: 1 },
    });
    expect(res.status).toBe(403);
  });

  it('白名单之外的字段被忽略', async () => {
    const runtime = fakeRuntime({});
    await call(runtime, {
      method: 'POST',
      headers: { 'x-dsh-wechat-mp-client': '1' },
      body: { rateLimitCodes: [999], proxy: 'env' },
    });
    const patch = (runtime as { calls: Record<string, unknown>[] }).calls[0]!;
    expect(patch).toEqual({ proxy: 'env' });
  });

  it('坏 JSON → 400', async () => {
    const server = makeServer();
    registerConfigRoutes(server as never, { runtime: fakeRuntime({}) as never });
    const post = server.routes.find((r) => r.path === '/wechat-mp/config')!;
    const res = makeRes();
    // 直接塞一个会解析失败的请求体
    const req = makeReq({ method: 'POST', headers: { 'x-dsh-wechat-mp-client': '1' } }) as {
      on: (e: string, cb: (c?: Buffer) => void) => void;
    };
    const originalOn = req.on.bind(req) as (e: string, cb: (c?: Buffer) => void) => void;
    (req as { on: typeof originalOn }).on = (event, cb) => {
      if (event === 'data') cb(Buffer.from('{{{'));
      if (event === 'end') cb();
      return originalOn(event, cb);
    };
    await post.handler(req as never, res as never);
    expect(res.status).toBe(400);
  });

  it('GET 之外的方法（非 POST）→ 405', async () => {
    const res = await call(fakeRuntime({}), { method: 'PUT' });
    expect(res.status).toBe(405);
  });
});
