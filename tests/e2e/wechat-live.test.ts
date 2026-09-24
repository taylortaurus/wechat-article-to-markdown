/**
 * 微信来源的真实端到端测试（需要网络 + Camoufox 浏览器）。
 *
 * 未设置 `WECHAT_E2E_URLS` 时整组跳过，因此可以安全地出现在默认测试集里。
 *
 * ```bash
 * WECHAT_E2E_URLS="https://mp.weixin.qq.com/s/xxx,https://mp.weixin.qq.com/s/yyy" \
 *   pnpm test:e2e
 * ```
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { setSilent } from '../../src/core/logger';
import { fetchWechatArticle } from '../../src/sources/index';

const urls = (process.env.WECHAT_E2E_URLS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const timeoutMs = Number(process.env.WECHAT_E2E_TIMEOUT ?? '240') * 1000;
const outDir = path.join(tmpdir(), `spider-claw-e2e-${Date.now()}`);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe.skipIf(urls.length === 0)('微信公众号 live e2e', () => {
  it(
    '抓取真实文章并产出带原文链接的 Markdown',
    async () => {
      setSilent(false);

      for (const url of urls) {
        const mdPath = await fetchWechatArticle(url, { outputDir: outDir });
        const markdown = await readFile(mdPath, 'utf8');
        expect(markdown).toContain(url);
      }

      const mdFiles = (await readdir(outDir, { recursive: true })).filter((name) =>
        name.endsWith('.md'),
      );
      expect(mdFiles.length).toBeGreaterThan(0);
    },
    timeoutMs,
  );
});
