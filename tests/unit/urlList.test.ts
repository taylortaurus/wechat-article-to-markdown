/** url-list.json 读写的离线单测。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  UrlListFormatError,
  UrlListNotFoundError,
  loadUrlList,
  now,
  saveUrlList,
} from '../../src/core/urlList';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'spider-claw-url-list-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeList(name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, content, 'utf8');
  return file;
}

describe('loadUrlList', () => {
  it('裸字符串条目会被归一化为对象', async () => {
    const file = await writeList('a.json', '["https://example.com/1"]');
    expect(await loadUrlList(file)).toEqual([{ url: 'https://example.com/1' }]);
  });

  it('支持 { urls: [...] } 形式', async () => {
    const file = await writeList('b.json', '{"urls":[{"url":"https://example.com/2"}]}');
    expect(await loadUrlList(file)).toEqual([{ url: 'https://example.com/2' }]);
  });

  it('跳过无效条目', async () => {
    const file = await writeList('c.json', '[1, {"noUrl":true}, {"url":"https://example.com/3"}]');
    expect(await loadUrlList(file)).toEqual([{ url: 'https://example.com/3' }]);
  });

  it('文件不存在时抛出 UrlListNotFoundError', async () => {
    await expect(loadUrlList(path.join(dir, 'missing.json'))).rejects.toBeInstanceOf(
      UrlListNotFoundError,
    );
  });

  it('非法 JSON 抛出 UrlListFormatError', async () => {
    const file = await writeList('d.json', '{oops');
    await expect(loadUrlList(file)).rejects.toBeInstanceOf(UrlListFormatError);
  });

  it('顶层结构不对抛出 UrlListFormatError', async () => {
    const file = await writeList('e.json', '"just a string"');
    await expect(loadUrlList(file)).rejects.toBeInstanceOf(UrlListFormatError);
  });
});

describe('saveUrlList / now', () => {
  it('写回后可原样读回（含中文与爬取状态）', async () => {
    const file = path.join(dir, 'round-trip.json');
    const items = [
      { url: 'https://example.com/中文', status: 'done', output: 'output/x/x.md' },
    ];

    await saveUrlList(file, items);

    expect(await loadUrlList(file)).toEqual(items);
  });

  it('now() 输出 YYYY-MM-DD HH:mm:ss', () => {
    expect(now()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
