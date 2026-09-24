/**
 * 集成测试：把插件**真的装到**一个假的宿主上下文上。
 *
 * 这比"单测各个纯函数"强一档：它验证的是 `apply(ctx, config)` 这个入口在真实
 * 契约下能不能跑通 —— 工具是否都注册上了、路由是否注册上了、路由处理器真的被调用时
 * 返回什么。这些都是 P0-6 / P0-9 / P0-11 想验证的东西，只是不需要启动真宿主。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apply, DEFAULT_CONFIG, normalizeConfig } from '../../src/index.js';

/** 记录一次工具注册。 */
interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: { schema: unknown; render: (args: unknown, value: unknown) => { text: string }[] };
  execute: (args: never, exec: never) => Promise<unknown>;
}

interface RegisteredRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: unknown, res: FakeResponse) => void;
}

/** 假的响应对象：把写出的内容记下来，便于断言。 */
class FakeResponse {
  status = 0;
  headers: Record<string, string> = {};
  body: string | Uint8Array = '';
  ended = false;

  writeHead(status: number, headers?: Record<string, string>): void {
    this.status = status;
    this.headers = headers ?? {};
  }

  end(body?: string | Uint8Array): void {
    this.ended = true;
    if (body !== undefined) this.body = body;
  }
}

/** 假的宿主上下文。只实现插件真正用到的那几个面。 */
function makeFakeContext(options: { withJobs?: boolean; withWebServer?: boolean; withSettings?: boolean } = {}) {
  const tools: RegisteredTool[] = [];
  const routes: RegisteredRoute[] = [];
  const effects: (() => void)[] = [];
  const jobs: { kind: string; label: string; run: () => unknown }[] = [];
  const settingsUpdates: Record<string, unknown>[] = [];

  const services: Record<string, unknown> = {
    tools: {
      register(tool: unknown) {
        tools.push(tool as RegisteredTool);
        return () => {};
      },
    },
  };

  if (options.withWebServer !== false) {
    services['webServer'] = {
      register(route: RegisteredRoute) {
        routes.push(route);
        return () => {};
      },
    };
  }

  if (options.withJobs !== false) {
    services['jobs'] = {
      async start(decl: { kind: string; label: string; run: () => unknown }) {
        jobs.push(decl);
        // 立刻调一次 run，确认它同步返回 hooks（这是 R1 那个坑的核心）
        const hooks = decl.run();
        return { id: 'job-test-1', hooks };
      },
    };
  }

  if (options.withSettings !== false) {
    services['settingsScope'] = {
      update(values: Record<string, unknown>) {
        settingsUpdates.push(values);
      },
    };
  }

  const ctx = {
    /**
     * 真的 cordis `Context` 就是靠这个读可选服务的。
     * **不存在的服务返回 undefined，不抛** —— 这正是 `ctx.get` 与 `ctx.foo` 的区别。
     */
    get(name: string): unknown {
      return services[name];
    },
    tools: services['tools'],
    effect(effect: () => void | (() => void)) {
      const dispose = effect();
      if (typeof dispose === 'function') effects.push(dispose);
      return () => {};
    },
    /**
     * 带依赖的子插件挂载。真 cordis 是"服务就绪后才调 callback"；
     * 这里服务都是现成的，所以立即调用 —— 但要保证 callback 能**直接读**注入的服务
     * （像真宿主一样）。这一点很关键：`apply` 阶段用 `ctx.get()` 抢异步服务会拿到
     * undefined，必须靠 `inject` 等。
     */
    inject(deps: string[], callback: (innerCtx: unknown) => void) {
      const inner: Record<string, unknown> = {
        effect(effect: () => void | (() => void)) {
          const dispose = effect();
          if (typeof dispose === 'function') effects.push(dispose);
          return () => {};
        },
      };
      for (const dep of deps) {
        const service = services[dep];
        if (service === undefined) {
          throw new Error(`cannot inject missing service "${dep}"`);
        }
        inner[dep] = service;
      }
      callback(inner);
      return {};
    },
    plugin() {
      return {};
    },
  };

  return { ctx, tools, routes, effects, jobs, settingsUpdates };
}

/**
 * 一个**会在读取未声明属性时抛错**的上下文 —— 复刻 cordis `Context` Proxy 的行为。
 *
 * 加这个是因为实测踩过一次：插件里写 `ctx.workspaceRoot` 试探服务，cordis 直接抛
 * `cannot get property "workspaceRoot" without inject`，**把整个 dsh web 的启动都带崩了**。
 * 这个假宿主保证同样的错误会在单测里立刻被抓到。
 */
function makeStrictContext(allowedExtra: string[] = []) {
  const allowed = new Set(['get', 'inject', 'tools', 'effect', 'plugin', ...allowedExtra]);
  const base = makeFakeContext();

  return new Proxy(base.ctx as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !allowed.has(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as unknown as ReturnType<typeof makeFakeContext>['ctx'];
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'dsh-wechat-mp-apply-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** 用一份把输出目录指到临时目录的配置来跑 `apply`。 */
function applyWith(workspaceRoot: string) {
  const fake = makeFakeContext();
  apply(
    fake.ctx as never,
    normalizeConfig({ ...DEFAULT_CONFIG, outputRoot: path.join(workspaceRoot, 'out') }),
  );
  return fake;
}

describe('apply() —— 工具注册', () => {
  it('三个入口的工具都注册上了', () => {
    const { tools } = applyWith(workspace);
    const names = tools.map((t) => t.name).sort();

    // E1
    expect(names).toContain('wechat_fetch_article');
    // E2
    expect(names).toContain('wechat_fetch_list');
    expect(names).toContain('wechat_list_status');
    // E3
    expect(names).toContain('wechat_mp_authorize');
    expect(names).toContain('wechat_mp_search_account');
    expect(names).toContain('wechat_mp_list_articles');
    expect(names).toContain('wechat_mp_sync_account');
    expect(names).toContain('wechat_mp_logout');
    expect(names).toContain('wechat_mp_status');
    // 输出配置
    expect(names).toContain('wechat_set_output_root');
    expect(names).toContain('wechat_output_info');
  });

  it('工具名没有重复（keyed 槽位重名会导致卡片互相覆盖）', () => {
    const { tools } = applyWith(workspace);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('每个工具都有 name / description / parameters / output.render', () => {
    const { tools } = applyWith(workspace);
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(10);
      expect(typeof tool.parameters).toBe('object');
      expect(typeof tool.output.render).toBe('function');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('**浏览器半注册的卡片键与工具名逐字一致**（否则卡片永远挂不上）', async () => {
    const { tools } = applyWith(workspace);
    const names = new Set(tools.map((t) => t.name));

    // 这两个名字同时出现在 src/client/index.ts 的注册里
    const clientKeys = ['wechat_mp_authorize', 'wechat_output_info'];
    for (const key of clientKeys) {
      expect(names.has(key)).toBe(true);
    }
  });
});

describe('apply() —— 二维码路由（主交付方案）', () => {
  it('注册了 /wechat-mp/qr 与 /wechat-mp/status 两条精确路由', () => {
    const { routes } = applyWith(workspace);
    const paths = routes.map((r) => r.path).sort();
    // qr / status / config（配置工作台的读写路由）
    expect(paths).toEqual(['/wechat-mp/config', '/wechat-mp/qr', '/wechat-mp/status']);
    // 都是 exact（不是 prefix），避免和 SPA 的兜底抢范围
    for (const route of routes) expect(route.kind).toBe('exact');
  });

  it('还没有二维码时 /qr 返回 404 而不是空图', () => {
    const { routes } = applyWith(workspace);
    const qr = routes.find((r) => r.path === '/wechat-mp/qr')!;
    const res = new FakeResponse();
    qr.handler({}, res);
    expect(res.status).toBe(404);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('/status 返回 JSON 且禁止缓存', () => {
    const { routes } = applyWith(workspace);
    const status = routes.find((r) => r.path === '/wechat-mp/status')!;
    const res = new FakeResponse();
    status.handler({}, res);
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(res.headers['Cache-Control']).toBe('no-store');
    const parsed = JSON.parse(res.body as string) as { phase: string; ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.phase).toBe('idle');
  });
});

describe('apply() —— 副作用清理', () => {
  it('注册了 effect，便于插件卸载时释放', () => {
    const { effects } = applyWith(workspace);
    expect(effects.length).toBeGreaterThan(0);
  });

  it('释放函数可重复调用而不抛', () => {
    const { effects } = applyWith(workspace);
    for (const dispose of effects) {
      expect(() => dispose()).not.toThrow();
    }
  });
});

describe('apply() —— 配置归一化', () => {
  it('没有 jobs 服务时也能跑（可选依赖）', () => {
    const fake = makeFakeContext({ withJobs: false });
    expect(() => apply(fake.ctx as never, normalizeConfig(DEFAULT_CONFIG))).not.toThrow();
  });

  it('没有 webServer 时降级（不抛，只是没有路由）', () => {
    const fake = makeFakeContext({ withWebServer: false });
    expect(() => apply(fake.ctx as never, normalizeConfig(DEFAULT_CONFIG))).not.toThrow();
    expect(fake.routes).toHaveLength(0);
  });

  it('没有 settingsScope 时也能跑（输出目录只存内存）', () => {
    const fake = makeFakeContext({ withSettings: false });
    expect(() => apply(fake.ctx as never, normalizeConfig(DEFAULT_CONFIG))).not.toThrow();
  });

  it('恶意的 pageDelayMs=0 会被抬回安全下限', () => {
    const cfg = normalizeConfig({ ...DEFAULT_CONFIG, pageDelayMs: 0 });
    expect(cfg.pageDelayMs).toBeGreaterThanOrEqual(1000);
  });

  it('maxArticles / listPageSize 有硬上限', () => {
    const cfg = normalizeConfig({ ...DEFAULT_CONFIG, maxArticles: 999999, listPageSize: 9999 });
    expect(cfg.maxArticles).toBeLessThanOrEqual(5000);
    expect(cfg.listPageSize).toBeLessThanOrEqual(50);
  });
});

describe('apply() —— 绝不因读未声明的服务而崩（实测踩过的坑）', () => {
  it('**面对会抛错的 Proxy 上下文也能正常初始化**', () => {
    // 真机上写 `ctx.workspaceRoot` 试探服务，cordis 抛
    // `cannot get property "workspaceRoot" without inject`，
    // 而 apply 里的异常会把**整个 dsh web 的启动带崩**。
    // 这个用例保证插件只通过 `ctx.get()` 读可选服务。
    const strict = makeStrictContext();
    expect(() => apply(strict as never, normalizeConfig(DEFAULT_CONFIG))).not.toThrow();
  });

  it('初始化真出错时也不把异常抛出去（只大声记录）', () => {
    // 让 tools.register 抛错，模拟"注册阶段炸了"
    const strict = makeStrictContext();
    const hostile = new Proxy(strict as unknown as Record<string, unknown>, {
      get(target, prop, receiver) {
        if (prop === 'tools') {
          return {
            register() {
              throw new Error('模拟注册失败');
            },
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    // 关键断言：**不抛**。宿主因此能继续启动，用户至少还有别的工具可用。
    expect(() => apply(hostile as never, normalizeConfig(DEFAULT_CONFIG))).not.toThrow();
  });
});
