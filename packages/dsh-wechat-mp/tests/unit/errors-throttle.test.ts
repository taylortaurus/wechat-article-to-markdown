/**
 * 错误映射与限速测试。
 *
 * 对应评估文档两件事：
 *  - 缺陷「错误被吞成空结果」的反向要求：`ret != 0` 必须抛，不能返回空
 *  - 缺陷 A3 的修法：翻页必须限速 + 频控必须退避（用假时钟精确验证）
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RATE_LIMIT_CODES,
  MpAuthExpiredError,
  MpBusinessError,
  MpRateLimitedError,
  describeErrorForModel,
  isAuthExpired,
  isRateLimited,
  throwIfNotOk,
} from '../../src/provider/errors.js';
import {
  DEFAULT_THROTTLE,
  Throttle,
  withRateLimitRetry,
  type ThrottleRuntime,
} from '../../src/provider/throttle.js';

/** 假时钟：记录每次 sleep 的时长，不真的等。 */
function fakeRuntime(): { runtime: ThrottleRuntime; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    runtime: {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    },
  };
}

describe('throwIfNotOk', () => {
  it('ret=0 直接放行', () => {
    expect(() => throwIfNotOk({ ret: 0, errMsg: '' }, { context: '测试' })).not.toThrow();
  });

  it('200003 → MpAuthExpiredError（被动过期的唯一判据）', () => {
    expect(() => throwIfNotOk({ ret: 200003, errMsg: 'invalid session' }, { context: '列文章' })).toThrow(
      MpAuthExpiredError,
    );
  });

  it('其他非 0 → MpBusinessError，并把 ret / errMsg 原样带出', () => {
    try {
      throwIfNotOk({ ret: -8, errMsg: '系统错误' }, { context: '列文章' });
      expect.unreachable('应该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(MpBusinessError);
      const business = error as MpBusinessError;
      expect(business.ret).toBe(-8);
      expect(business.context).toBe('列文章');
      expect(business.message).toContain('系统错误');
    }
  });

  it('**绝不返回空结果** —— 这是参考实现的反向要求', () => {
    // 参考实现在 ret!=0 时 LogWarning 后 return new List<>()，调用方分不清
    // 「没有文章」和「接口挂了」。这里必须是抛出。
    let returnedNormally = false;
    try {
      throwIfNotOk({ ret: 100, errMsg: '' }, { context: '列文章' });
      returnedNormally = true;
    } catch {
      /* 预期 */
    }
    expect(returnedNormally).toBe(false);
  });

  it('默认没有配置任何频控码（因为真实码号还没实测出来）', () => {
    expect(DEFAULT_RATE_LIMIT_CODES).toHaveLength(0);
  });

  it('配了频控码之后才按频控处理', () => {
    expect(() =>
      throwIfNotOk({ ret: 200013, errMsg: 'freq' }, { context: '列文章', rateLimitCodes: [200013] }),
    ).toThrow(MpRateLimitedError);
    // 没配就按普通业务错误处理
    expect(() => throwIfNotOk({ ret: 200013, errMsg: 'freq' }, { context: '列文章' })).toThrow(
      MpBusinessError,
    );
  });

  it('类型守卫工作正常', () => {
    const auth = new MpAuthExpiredError('x');
    const rate = new MpRateLimitedError(1, 'x');
    expect(isAuthExpired(auth)).toBe(true);
    expect(isRateLimited(auth)).toBe(false);
    expect(isAuthExpired(rate)).toBe(false);
    expect(isRateLimited(rate)).toBe(true);
  });
});

describe('describeErrorForModel', () => {
  it('登录失效给出「重新扫码」的明确指引', () => {
    const text = describeErrorForModel(new MpAuthExpiredError('列文章'));
    expect(text).toContain('wechat_mp_authorize');
  });

  it('频控提示调大 pageDelayMs', () => {
    const text = describeErrorForModel(new MpRateLimitedError(200013, '列文章'));
    expect(text).toContain('pageDelayMs');
  });

  it('普通错误原样带出', () => {
    expect(describeErrorForModel(new Error('boom'))).toBe('boom');
  });
});

describe('Throttle', () => {
  it('第一次等待用的是基准间隔', async () => {
    const { runtime, waits } = fakeRuntime();
    const throttle = new Throttle({ baseDelayMs: 3000 }, runtime);
    await throttle.acquire();
    expect(waits).toEqual([3000]);
  });

  it('**默认基准间隔是 3 秒**，不是参考实现的 100 毫秒', () => {
    expect(DEFAULT_THROTTLE.baseDelayMs).toBe(3000);
  });

  it('被频控后退避按倍数增长', async () => {
    const { runtime, waits } = fakeRuntime();
    const throttle = new Throttle({ baseDelayMs: 1000, backoffFactor: 2, maxDelayMs: 60_000 }, runtime);

    await throttle.acquire(); // 1000
    throttle.penalize();
    await throttle.acquire(); // 2000
    throttle.penalize();
    await throttle.acquire(); // 4000
    throttle.penalize();
    await throttle.acquire(); // 8000

    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });

  it('退避有上限，不会无限增长', async () => {
    const { runtime, waits } = fakeRuntime();
    const throttle = new Throttle({ baseDelayMs: 1000, backoffFactor: 10, maxDelayMs: 5000 }, runtime);
    for (let i = 0; i < 4; i++) throttle.penalize();
    await throttle.acquire();
    expect(waits[0]).toBe(5000);
  });

  it('成功后档位回落', async () => {
    const { runtime } = fakeRuntime();
    const throttle = new Throttle({ baseDelayMs: 1000, backoffFactor: 2 }, runtime);
    throttle.penalize();
    throttle.penalize();
    expect(throttle.level).toBe(3);
    throttle.relax();
    expect(throttle.level).toBe(2);
    throttle.relax();
    throttle.relax();
    expect(throttle.level).toBe(1);
  });

  it('重试预算用完后 exhausted 为真', () => {
    const throttle = new Throttle({ maxRetries: 2 });
    expect(throttle.penalize()).toBe(true); // 1
    expect(throttle.penalize()).toBe(true); // 2
    expect(throttle.penalize()).toBe(false); // 3 —— 超了
    expect(throttle.exhausted).toBe(true);
  });

  it('reset 会把档位与计数清空', () => {
    const throttle = new Throttle();
    throttle.penalize();
    void throttle.acquire();
    throttle.reset();
    expect(throttle.level).toBe(1);
    expect(throttle.waits).toBe(0);
  });
});

describe('withRateLimitRetry', () => {
  it('成功时只跑一次', async () => {
    const { runtime, waits } = fakeRuntime();
    const throttle = new Throttle({ baseDelayMs: 100 }, runtime);
    let calls = 0;
    const result = await withRateLimitRetry(
      throttle,
      async () => {
        calls += 1;
        return 'ok';
      },
      isRateLimited,
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
    expect(waits).toEqual([100]);
  });

  it('遇到频控会退避重试，直到成功', async () => {
    const { runtime, waits } = fakeRuntime();
    const throttle = new Throttle({ baseDelayMs: 100, backoffFactor: 2, maxRetries: 3 }, runtime);
    let calls = 0;
    const result = await withRateLimitRetry(
      throttle,
      async () => {
        calls += 1;
        if (calls < 3) throw new MpRateLimitedError(200013, '列文章');
        return 'done';
      },
      isRateLimited,
    );
    expect(result).toBe('done');
    expect(calls).toBe(3);
    expect(waits).toEqual([100, 200, 400]);
  });

  it('重试预算耗尽后把频控错误抛出去', async () => {
    const { runtime } = fakeRuntime();
    const throttle = new Throttle({ baseDelayMs: 1, maxRetries: 2 }, runtime);
    await expect(
      withRateLimitRetry(
        throttle,
        async () => {
          throw new MpRateLimitedError(200013, '列文章');
        },
        isRateLimited,
      ),
    ).rejects.toThrow(MpRateLimitedError);
  });

  it('**非频控错误立刻抛出，不重试**（登录失效重试没有意义）', async () => {
    const { runtime } = fakeRuntime();
    const throttle = new Throttle({ baseDelayMs: 1 }, runtime);
    let calls = 0;
    await expect(
      withRateLimitRetry(
        throttle,
        async () => {
          calls += 1;
          throw new MpAuthExpiredError('列文章');
        },
        isRateLimited,
      ),
    ).rejects.toThrow(MpAuthExpiredError);
    expect(calls).toBe(1);
  });
});
