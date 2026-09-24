/**
 * CLI 路由与批量续爬逻辑的离线单测。
 *
 * 这里把「假来源」注册进真实注册表，从而在完全不联网的前提下覆盖
 * 去重、已爬取跳过、失败回写、退出码等最容易出错的路径。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CliError, resolveSource, runList } from '../../src/cli';
import { Source, type FetchOptions } from '../../src/sources/base';
import { BY_NAME, detectSource } from '../../src/sources/index';

class FakeSource extends Source {
  readonly name: string = 'fake';
  calls: string[] = [];
  failing = new Set<string>();

  override match(url: string): boolean {
    return url.startsWith('https://fake.test/');
  }

  override articleId(url: string): string {
    return new URL(url).pathname;
  }

  override async fetch(url: string, options: FetchOptions = {}): Promise<string> {
    this.calls.push(url);
    if (this.failing.has(url)) throw new Error('模拟抓取失败');
    const file = path.join(options.outputDir ?? '.', 'fake-article', 'fake-article.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '# fake', 'utf8');
    return file;
  }
}

const fake = new FakeSource();
// BY_NAME 对外是只读视图（防止业务代码偷改注册表），测试里显式放开
const registry = BY_NAME as unknown as Map<string, Source>;

let dir: string;

beforeAll(() => {
  registry.set(fake.name, fake);
});

afterAll(() => {
  registry.delete(fake.name);
});

beforeEach(async () => {
  fake.calls = [];
  fake.failing = new Set();
  dir = await mkdtemp(path.join(tmpdir(), 'spider-claw-cli-'));
});

async function listFile(items: unknown): Promise<string> {
  const file = path.join(dir, 'url-list.json');
  await writeFile(file, JSON.stringify(items), 'utf8');
  return file;
}

describe('resolveSource', () => {
  it('显式 --source 覆盖自动识别', () => {
    expect(resolveSource('https://example.com/x', 'blog').name).toBe('blog');
  });

  it('未指定时按 URL 自动识别', () => {
    expect(resolveSource('https://mp.weixin.qq.com/s/abc').name).toBe('wechat');
  });

  it('未知 --source 抛 CliError', () => {
    expect(() => resolveSource('https://example.com/x', 'nope')).toThrow(CliError);
  });

  it('无法识别且未指定 --source 时抛 CliError', () => {
    expect(() => resolveSource('https://unknown.example/x')).toThrow(/无法从 URL 识别来源/);
  });
});

describe('detectSource', () => {
  it('微信 / 已注册博客 / 未注册域名', () => {
    expect(detectSource('https://mp.weixin.qq.com/s/abc')?.name).toBe('wechat');
    expect(detectSource('https://addyosmani.com/blog/x')?.name).toBe('blog');
    expect(detectSource('https://example.com/x')).toBeUndefined();
  });
});

describe('runList', () => {
  it('同一篇文章（不同追踪参数）只爬一次，done 条目直接跳过', async () => {
    const file = await listFile([
      { url: 'https://fake.test/a?x=1', source: 'fake' },
      { url: 'https://fake.test/a?y=2', source: 'fake' },
      { url: 'https://fake.test/b', source: 'fake', status: 'done' },
    ]);

    const failed = await runList(file, dir, 'direct');

    expect(failed).toBe(0);
    expect(fake.calls).toEqual(['https://fake.test/a?x=1']);

    const items = JSON.parse(await readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ status: 'done', source: 'fake' });
    expect(items[0]!.output).toBeTruthy();
    expect(items[0]!.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // 未知来源之外的状态不会被误改
    expect(items[2]!.status).toBe('done');
  });

  it('抓取失败会标记 failed / error，并返回失败条数', async () => {
    const url = 'https://fake.test/boom';
    fake.failing.add(url);
    const file = await listFile([{ url, source: 'fake' }]);

    const failed = await runList(file, dir, 'direct');

    expect(failed).toBe(1);
    const items = JSON.parse(await readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ status: 'failed', error: '模拟抓取失败' });
  });

  it('条目里的未知 source 被标记为 failed', async () => {
    const file = await listFile([{ url: 'https://fake.test/x', source: 'ghost' }]);

    const failed = await runList(file, dir, 'direct');

    expect(failed).toBe(1);
    const items = JSON.parse(await readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    expect(items[0]!.status).toBe('failed');
    expect(String(items[0]!.error)).toContain('ghost');
  });

  it('空列表直接返回 0', async () => {
    const file = await listFile([]);
    await expect(runList(file, dir, 'direct')).resolves.toBe(0);
  });
});
