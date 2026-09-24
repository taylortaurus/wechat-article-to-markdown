/** 图片并发下载与本地化（与具体来源无关）。 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { HttpClient, type ProxyConfig } from './http.js';
import { logger } from './logger.js';

/** 图片并发上限（与 Python 版一致）。 */
export const IMAGE_CONCURRENCY = 5;

/** 将图片 URL 解析为绝对 URL。 */
export function resolveImgUrl(imgUrl: string, articleUrl?: string | null): string {
  const url = imgUrl.trim();
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  if (articleUrl) {
    try {
      return new URL(url, articleUrl).toString();
    } catch {
      return url;
    }
  }
  return url;
}

/** 从 URL 推断图片扩展名（优先微信公众号的 `wx_fmt` 参数）。 */
export function inferImageExt(url: string): string {
  const matched = /wx_fmt=(\w+)/.exec(url) ?? /\.(\w{3,4})(?:\?|$)/.exec(url);
  return matched?.[1] ?? 'png';
}

export interface DownloadImagesOptions {
  proxy?: ProxyConfig;
  referer?: string | null;
  /** 文章原始 URL，用于把相对路径图片解析为绝对 URL。 */
  articleUrl?: string | null;
  concurrency?: number;
  timeoutMs?: number;
}

/** 并发执行并保持结果顺序（等价于带并发上限的 Promise.all）。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 下载全部图片到 `imgDir`，返回 `远程 URL -> 本地相对路径` 的映射。
 *
 * - 命名规则：`img_001.<ext>`（按传入顺序）；
 * - 扩展名：优先解析 URL 中的 `wx_fmt`，其次按后缀推断，兜底 `png`；
 * - 单张失败只告警，不影响其余图片与正文产出。
 */
export async function downloadAllImages(
  imgUrls: string[],
  imgDir: string,
  options: DownloadImagesOptions = {},
): Promise<Map<string, string>> {
  const urlMap = new Map<string, string>();
  if (imgUrls.length === 0) return urlMap;

  const concurrency = options.concurrency ?? IMAGE_CONCURRENCY;
  logger.info(`🖼  下载 ${imgUrls.length} 张图片 (并发 ${concurrency})...`);

  await mkdir(imgDir, { recursive: true });
  const client = new HttpClient(options.proxy ?? 'direct');

  const results = await mapWithConcurrency(imgUrls, concurrency, async (imgUrl, i) => {
    const index = i + 1;
    try {
      const url = resolveImgUrl(imgUrl, options.articleUrl);
      const filename = `img_${String(index).padStart(3, '0')}.${inferImageExt(url)}`;
      const { bytes } = await client.get(url, {
        referer: options.referer ?? undefined,
        timeoutMs: options.timeoutMs ?? 15_000,
      });
      await writeFile(path.join(imgDir, filename), bytes);
      return [imgUrl, `images/${filename}`] as const;
    } catch (e) {
      logger.warn(`  ⚠ 图片下载失败: ${(e as Error).message}`);
      return [imgUrl, null] as const;
    }
  });

  for (const [remoteUrl, localPath] of results) {
    if (localPath) urlMap.set(remoteUrl, localPath);
  }
  logger.info(`  ✅ ${urlMap.size}/${imgUrls.length}`);
  return urlMap;
}
