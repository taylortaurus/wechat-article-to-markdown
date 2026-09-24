/**
 * P0-16 的实证与修复验证。
 *
 * 要证明两件事：
 *  1. **不加锁时，两个并发写入者会互相覆盖**（这正是参考实现缺陷 A2「可变共享状态」
 *     在文件层面的重演）；
 *  2. 加了 `withListLock` 之后，两次写入都保留下来。
 *
 * 这里的"并发"是真实的并发：Node 单线程，但 `await` 之间会发生交错，
 * 与两个进程交错读写的效果等价。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ListLockTimeoutError,
  acquireListLock,
  lockPathFor,
  withListLock,
} from '../../src/output/list-lock.js';

let dir: string;
let listPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dsh-wechat-mp-lock-'));
  listPath = path.join(dir, 'url-list.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readList(): Promise<{ url: string; status?: string }[]> {
  try {
    return JSON.parse(await readFile(listPath, 'utf8')) as { url: string; status?: string }[];
  } catch {
    return [];
  }
}

async function writeList(items: { url: string; status?: string }[]): Promise<void> {
  await writeFile(listPath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

/**
 * 模拟 `runList` 的读写模式：**启动时整表读进来，处理完一条整表回写**。
 *
 * 出处：`cli.ts:73`（读）+ `cli.ts:144`（每处理一条回写）。
 */
async function processOneWithoutLock(url: string): Promise<void> {
  const items = await readList(); // 读
  await new Promise((r) => setTimeout(r, 20)); // 模拟抓取耗时
  for (const item of items) {
    if (item.url === url) item.status = 'done';
  }
  await writeList(items); // 整表回写
}

describe('P0-16：不加锁会丢写入', () => {
  it('两个并发写入者互相覆盖 —— 复现问题本身', async () => {
    await writeList([
      { url: 'https://mp.weixin.qq.com/s/AAAA', status: 'pending' },
      { url: 'https://mp.weixin.qq.com/s/BBBB', status: 'pending' },
    ]);

    // 两个「会话」同时开跑
    await Promise.all([processOneWithoutLock('https://mp.weixin.qq.com/s/AAAA'), processOneWithoutLock('https://mp.weixin.qq.com/s/BBBB')]);

    const final = await readList();
    const doneCount = final.filter((item) => item.status === 'done').length;

    // 两个都处理完了，但只有一份回写活了下来 —— 这就是丢失更新
    expect(doneCount).toBe(1);
  });
});

describe('P0-16：加锁后两次写入都保留', () => {
  it('withListLock 串行化，更新不丢', async () => {
    await writeList([
      { url: 'https://mp.weixin.qq.com/s/AAAA', status: 'pending' },
      { url: 'https://mp.weixin.qq.com/s/BBBB', status: 'pending' },
    ]);

    const processOne = async (url: string): Promise<void> =>
      withListLock(
        listPath,
        async () => {
          const items = await readList();
          await new Promise((r) => setTimeout(r, 20));
          for (const item of items) {
            if (item.url === url) item.status = 'done';
          }
          await writeList(items);
        },
        { timeoutMs: 5000, retryMs: 5 },
      );

    await Promise.all([
      processOne('https://mp.weixin.qq.com/s/AAAA'),
      processOne('https://mp.weixin.qq.com/s/BBBB'),
    ]);

    const final = await readList();
    expect(final.filter((item) => item.status === 'done')).toHaveLength(2);
  });

  it('异常路径也会释放锁（否则后续调用会全部超时）', async () => {
    await expect(
      withListLock(
        listPath,
        async () => {
          throw new Error('boom');
        },
        { timeoutMs: 1000, retryMs: 5 },
      ),
    ).rejects.toThrow('boom');

    // 锁已释放，第二次能立刻拿到
    const result = await withListLock(listPath, async () => 'ok', { timeoutMs: 1000, retryMs: 5 });
    expect(result).toBe('ok');
  });
});

describe('锁的边界行为', () => {
  it('锁文件路径是列表文件加 .lock 后缀', () => {
    expect(lockPathFor('/a/b/url-list.json')).toBe('/a/b/url-list.json.lock');
  });

  it('被别人持有时会等待，超时后抛 ListLockTimeoutError 并指明持有者', async () => {
    const release = await acquireListLock(listPath, { timeoutMs: 1000, retryMs: 5 });

    let error: unknown;
    try {
      await acquireListLock(listPath, { timeoutMs: 60, retryMs: 5 });
    } catch (e) {
      error = e;
    } finally {
      await release();
    }

    expect(error).toBeInstanceOf(ListLockTimeoutError);
    expect((error as Error).message).toContain('另一个 dsh 会话');
    // 提示里应当带上持有者信息（pid），方便排查
    expect((error as Error).message).toContain('pid=');
  });

  it('释放是幂等的', async () => {
    const release = await acquireListLock(listPath, { timeoutMs: 500, retryMs: 5 });
    await release();
    await expect(release()).resolves.toBeUndefined();
  });

  it('残留锁（超过 staleMs）可以被抢占', async () => {
    // 手工造一个"很老"的锁
    await writeFile(lockPathFor(listPath), JSON.stringify({ pid: 999999, host: 'ghost', at: '1970-01-01T00:00:00.000Z' }), 'utf8');

    // 假时钟：让 now 比锁文件的 mtime 晚很多
    const release = await acquireListLock(listPath, {
      timeoutMs: 500,
      retryMs: 5,
      staleMs: 1,
      now: () => Date.now() + 60_000,
    });
    await release();
    expect(true).toBe(true);
  });

  it('锁内容包含 pid / host / 时间，便于诊断', async () => {
    const release = await acquireListLock(listPath, { timeoutMs: 500, retryMs: 5 });
    const raw = await readFile(lockPathFor(listPath), 'utf8');
    const parsed = JSON.parse(raw) as { pid?: number; host?: string; at?: string };
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.host).toBe('string');
    expect(typeof parsed.at).toBe('string');
    await release();
  });

  it('可注入的 sleep 让等待可预测（连 sleep 都不该被调用——锁是空闲的）', async () => {
    const sleeps: number[] = [];
    const release = await acquireListLock(listPath, {
      timeoutMs: 500,
      retryMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([]);
    await release();
  });
});
