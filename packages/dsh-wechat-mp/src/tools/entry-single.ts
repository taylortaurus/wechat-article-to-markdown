/**
 * E1 单链接入口：抓一篇文章，转成 Markdown。
 *
 * 这条链路**完全不需要登录** —— 文章正文页游客可见。实现上直接复用 spider-claw，
 * 本插件只补两件它没有的事：① 返回**结构化的规范值**而不是让人去解析 stdout；
 * ② 跑一遍**输出防护**（试读页/非图文类的判定）。
 */
import { readFile } from 'node:fs/promises';


import { fetchWechatArticle } from 'spider-claw';

import { inspectContent } from '../output/guard.js';
import { describeErrorForModel } from '../provider/errors.js';
import { defineTool, boolean, number, object, string } from './schema.js';
import { describeFetchFailure, withTimeout } from './timeout.js';
import type { FetchResult } from '../definition/types.js';
import type { Runtime } from '../deps.js';

/** 从 spider-claw 生成的 Markdown 头部解析出元数据。 */
export function parseMarkdownHeader(markdown: string): {
  title: string;
  author: string;
  publishTime: string;
  sourceUrl: string;
} {
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? '';
  const author = /^>\s*作者[:：]\s*(.*)$/m.exec(markdown)?.[1]?.trim() ?? '';
  const publishTime = /^>\s*发布时间[:：]\s*(.*)$/m.exec(markdown)?.[1]?.trim() ?? '';
  const sourceUrl = /^>\s*原文链接[:：]\s*(.*)$/m.exec(markdown)?.[1]?.trim() ?? '';
  return { title, author, publishTime, sourceUrl };
}

/** 数一下本地化后的图片。 */
export function countLocalImages(markdown: string): number {
  const matches = markdown.match(/!\[[^\]]*\]\(images\/[^)]+\)/g);
  return matches ? matches.length : 0;
}

export interface FetchArticleDeps {
  runtime: Runtime;
}

/** 注册 E1 的工具。 */
export function registerSingleEntryTools(ctx: { tools: { register(tool: unknown): unknown } }, deps: FetchArticleDeps): void {
  const { runtime } = deps;

  ctx.tools.register(
    defineTool<
      { url: string; outputDir?: string; proxy?: string },
      FetchResult | { error: string }
    >({
      name: 'wechat_fetch_article',
      description:
        '把一篇微信公众号文章抓下来并转成 Markdown（含图片本地化）。不需要登录。' +
        '输入文章 URL，返回生成的 Markdown 路径与元数据。',
      parameters: {
        url: { type: 'string', required: true, description: '微信公众号文章 URL（https://mp.weixin.qq.com/s/…）' },
        outputDir: { type: 'string', description: '输出目录；不传则用插件配置的输出根目录' },
        proxy: { type: 'string', description: "代理策略：'direct'（默认）| 'env' | 代理地址" },
      },
      output: {
        schema: object({
          markdownPath: string,
          title: string,
          author: string,
          publishTime: string,
          imageCount: number,
          guard: object({ isLikelyPaywall: boolean, reason: string }),
          error: string,
        }),
        render: (_args, value) => {
          if ('error' in value) return [{ type: 'text', text: value.error }];
          const lines = [
            `已保存：《${value.title}》`,
            `作者：${value.author || '(未取到)'}`,
            `发布时间：${value.publishTime || '(未取到)'}`,
            `Markdown：${value.markdownPath}`,
            `本地图片：${value.imageCount} 张`,
          ];
          if (value.guard.isLikelyPaywall) {
            lines.push(`⚠️ 内容可能不完整：${value.guard.reason ?? ''}`);
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const outDir = args.outputDir ?? runtime.getOutputRoot().absolute;
        const proxy = args.proxy ?? runtime.proxy;
        try {
          // 必须有超时：浏览器被杀时底层会无限等，用户会看到界面永远卡住。
          const markdownPath = await withTimeout(
            fetchWechatArticle(args.url, { outputDir: outDir, proxy }),
            {
              timeoutMs: runtime.config.fetchTimeoutMs,
              signal: exec.signal,
              onTimeoutMessage:
                `抓取超时（超过 ${Math.round(runtime.config.fetchTimeoutMs / 1000)} 秒）。` +
                '通常是浏览器没起来或被杀掉了 —— 底层没有取消接口，只能在这里止损。',
            },
          );
          const markdown = await readFile(markdownPath, 'utf8');
          const header = parseMarkdownHeader(markdown);
          const guard = inspectContent({ markdown });
          return {
            markdownPath,
            title: header.title,
            author: header.author,
            publishTime: header.publishTime,
            imageCount: countLocalImages(markdown),
            guard,
          };
        } catch (error) {
          // 基础设施故障要让调用方看到原因，但不抛出去（让模型能自己决定下一步）
          // 这里直接把"怎么自查"写进消息，避免用户只看到一句"失败了"。
          return { error: `抓取失败。\n\n${describeFetchFailure(error)}` };
        }
      },
    }),
  );
}
