/**
 * `url-list.json` 的读取 / 回写 / 时间戳工具（来源无关）。
 *
 * 列表条目既可以是裸字符串（待爬取 URL），也可以是对象；对象在爬取后会被
 * 回写 `source` / `status` / `output` / `updated_at`，从而支持中断续爬。
 */
import { readFile, writeFile } from 'node:fs/promises';

import { logger } from './logger.js';

export interface UrlListItem {
  url: string;
  source?: string;
  status?: 'done' | 'failed' | string;
  output?: string;
  updated_at?: string;
  error?: string;
  /** 允许携带额外字段（向前兼容历史列表）。 */
  [key: string]: unknown;
}

/** 列表文件不存在（CLI 需要给出「怎么创建」的提示）。 */
export class UrlListNotFoundError extends Error {}

/** 列表文件存在但不是合法结构。 */
export class UrlListFormatError extends Error {}

/** `YYYY-MM-DD HH:mm:ss`（本地时区）。 */
export function now(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 读取 url-list.json，并归一化为条目数组。 */
export async function loadUrlList(filePath: string): Promise<UrlListItem[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    throw new UrlListNotFoundError(
      `未找到列表文件: ${filePath}\n` +
        '请创建该文件并填入 URL（见 README），或改用 `spider-claw "<url>"` 单条抓取。',
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new UrlListFormatError(`${filePath} 不是合法 JSON: ${(e as Error).message}`);
  }

  let raw: unknown;
  if (data && typeof data === 'object' && !Array.isArray(data) && 'urls' in data) {
    raw = (data as { urls: unknown }).urls;
  } else if (Array.isArray(data)) {
    raw = data;
  } else {
    throw new UrlListFormatError(`${filePath} 顶层应为数组，或含 'urls' 字段的对象`);
  }

  if (!Array.isArray(raw)) {
    throw new UrlListFormatError(`${filePath} 顶层应为数组，或含 'urls' 字段的对象`);
  }

  const items: UrlListItem[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      items.push({ url: entry });
    } else if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { url?: unknown }).url === 'string' &&
      (entry as { url: string }).url
    ) {
      items.push(entry as UrlListItem);
    } else {
      logger.warn(`  ⚠️ 跳过无效条目: ${JSON.stringify(entry)}`);
    }
  }
  return items;
}

/** 将列表（含爬取结果）写回 JSON 文件。 */
export async function saveUrlList(filePath: string, items: UrlListItem[]): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}
