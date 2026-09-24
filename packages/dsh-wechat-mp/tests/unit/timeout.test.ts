/**
 * 超时守卫的测试。
 *
 * 对应实测踩过的一次事故：浏览器被环境杀掉后，抓取在底层无限等待，
 * 工具调用永远不结束，界面卡在「深度求索中」而且用户点不动取消。
 * 这一组测试保证**调用方一定拿得回控制权**。
 */
import { describe, expect, it } from 'vitest';

import { describeFetchFailure, withTimeout } from '../../src/tools/timeout.js';
import { MpTransportError } from '../../src/provider/errors.js';

/** 一个可控的、永不 resolve 的 Promise。 */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => setTimeout(resolve, ms, value));
}

describe('withTimeout', () => {
  it('工作按时完成时原样返回', async () => {
    const result = await withTimeout(after(5, 'ok'), {
      timeoutMs: 1000,
      onTimeoutMessage: '超时',
    });
    expect(result).toBe('ok');
  });

  it('**工作卡住时到点抛错**（这是那次事故的回归测试）', async () => {
    await expect(
      withTimeout(never<string>(), { timeoutMs: 20, onTimeoutMessage: '抓取超时了' }),
    ).rejects.toThrow(MpTransportError);
  });

  it('抛出的错误里带上了我们给的提示', async () => {
    await expect(
      withTimeout(never<string>(), { timeoutMs: 20, onTimeoutMessage: '抓取超时了' }),
    ).rejects.toThrow('抓取超时了');
  });

  it('信号已中止时立刻拒绝，不等超时', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await expect(
      withTimeout(never<string>(), {
        timeoutMs: 5000,
        signal: controller.signal,
        onTimeoutMessage: '超时',
      }),
    ).rejects.toThrow('取消');
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('执行中途取消也能立刻返回', async () => {
    const controller = new AbortController();
    const promise = withTimeout(after(5000, 'late'), {
      timeoutMs: 5000,
      signal: controller.signal,
      onTimeoutMessage: '超时',
    });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow('取消');
  });

  it('没有信号时也能正常工作', async () => {
    await expect(
      withTimeout(after(5, 1), { timeoutMs: 1000, onTimeoutMessage: '超时' }),
    ).resolves.toBe(1);
  });
});

describe('describeFetchFailure', () => {
  it('把诊断命令写进消息里（用户直接能照着做）', () => {
    const text = describeFetchFailure(new Error('抓取超时'));
    expect(text).toContain('抓取超时');
    expect(text).toContain('l2-camoufox-host.ts');
    expect(text).toContain('浏览器');
  });

  it('非 Error 输入也不炸', () => {
    expect(() => describeFetchFailure('something bad')).not.toThrow();
    expect(describeFetchFailure('something bad')).toContain('something bad');
  });
});
