/**
 * E2 列表入口：批量抓 `url-list.json` 里的文章。
 *
 * 这条链路也**完全不需要登录** —— 列表里可以是不同公众号、甚至不同来源的文章，
 * 它根本不关心文章属于谁。这正是它和 E3 的本质区别。
 *
 * 实现上复用 spider-claw 的 `runList`（它已经带了续爬与去重），
 * 外面套一层跨进程锁（修 P0-16）。
 */
import { readFile } from 'node:fs/promises';


import { loadUrlList, runList, type ProxyConfig } from 'spider-claw';

import { withListLock } from '../output/list-lock.js';
import { summarizeList } from '../output/url-list.js';
import { describeErrorForModel } from '../provider/errors.js';
import { defineTool, array, number, object, string } from './schema.js';
import { describeFetchFailure, withTimeout } from './timeout.js';
import type { Runtime } from '../deps.js';

export interface ListEntryResult {
  listPath: string;
  total: number;
  pendingBefore: number;
  doneBefore: number;
  failedBefore: number;
  /** 本次失败的条数（`runList` 的返回值）。 */
  failedThisRun: number;
  pendingAfter: number;
  doneAfter: number;
  outputRoot: string;
  error?: string;
}

export function registerListEntryTools(
  ctx: { tools: { register(tool: unknown): unknown } },
  deps: { runtime: Runtime },
): void {
  const { runtime } = deps;

  ctx.tools.register(
    defineTool<{ listPath?: string; outputDir?: string; proxy?: string }, ListEntryResult>({
      name: 'wechat_fetch_list',
      description:
        '批量抓取 url-list.json 里列出的文章并转成 Markdown。不需要登录，' +
        '列表里可以混不同公众号、甚至不同来源。已抓过的（status=done）会自动跳过，可断点续爬。',
      parameters: {
        listPath: { type: 'string', description: '列表文件路径；不传则用插件配置/默认位置' },
        outputDir: { type: 'string', description: '输出目录；不传则用插件配置的输出根目录' },
        proxy: { type: 'string', description: "代理策略：'direct'（默认）| 'env' | 代理地址" },
      },
      output: {
        schema: object({
          listPath: string,
          total: number,
          pendingBefore: number,
          doneBefore: number,
          failedBefore: number,
          failedThisRun: number,
          pendingAfter: number,
          doneAfter: number,
          outputRoot: string,
          error: string,
        }),
        render: (_args, value) => {
          if (value.error) return [{ type: 'text', text: value.error }];
          return [
            {
              type: 'text',
              text: [
                `列表：${value.listPath}`,
                `共 ${value.total} 条（本次开跑前：待抓 ${value.pendingBefore}，已完成 ${value.doneBefore}，失败 ${value.failedBefore}）`,
                `本次失败 ${value.failedThisRun} 条`,
                `跑完：待抓 ${value.pendingAfter}，已完成 ${value.doneAfter}`,
                `输出目录：${value.outputRoot}`,
              ].join('\n'),
            },
          ];
        },
      },
      async execute(args, exec) {
        const listPath = args.listPath ?? runtime.getListPath().absolute;
        const outputDir = args.outputDir ?? runtime.getOutputRoot().absolute;
        const proxy = (args.proxy ?? runtime.proxy) as ProxyConfig;

        const before = summarizeList(await loadUrlList(listPath).catch(() => []));

        try {
          // 跨进程锁：避免两个会话同时跑时后写者覆盖前写者的状态回写
          // 批量也有整体上限：单篇卡住会拖住整批（底层没有 per-article 取消接口）
          const failed = await withTimeout(
            withListLock(listPath, () => runList(listPath, outputDir, proxy)),
            {
              timeoutMs: runtime.config.listTimeoutMs,
              signal: exec.signal,
              onTimeoutMessage:
                `批量抓取超过上限（${Math.round(runtime.config.listTimeoutMs / 60000)} 分钟）已中止等待。` +
                '已抓完的部分都保留在清单里，可以直接再跑一次续上。',
            },
          );
          const after = summarizeList(await loadUrlList(listPath).catch(() => []));
          return {
            listPath,
            total: after.total,
            pendingBefore: before.pending,
            doneBefore: before.done,
            failedBefore: before.failed,
            failedThisRun: failed,
            pendingAfter: after.pending,
            doneAfter: after.done,
            outputRoot: outputDir,
          };
        } catch (error) {
          // 锁超时 / 列表不存在 / 抓取异常
          const after = summarizeList(await loadUrlList(listPath).catch(() => []));
          return {
            listPath,
            total: after.total,
            pendingBefore: before.pending,
            doneBefore: before.done,
            failedBefore: before.failed,
            failedThisRun: 0,
            pendingAfter: after.pending,
            doneAfter: after.done,
            outputRoot: outputDir,
            error: `批量抓取未完成。\n\n${describeFetchFailure(error)}`,
          };
        }
      },
    }),
  );

  // 顺带提供一个"只看状态"的轻量工具，避免为了看进度而真的跑一遍抓取
  ctx.tools.register(
    defineTool<{ listPath?: string }, { listPath: string; total: number; pending: number; done: number; failed: number; other: number; preview: string[] }>({
      name: 'wechat_list_status',
      description: '查看 url-list.json 的当前状态（不抓取）。会列出前若干条标题与状态，便于决定要不要跑批量抓取。',
      parameters: {
        listPath: { type: 'string', description: '列表文件路径；不传则用默认位置' },
      },
      output: {
        schema: object({
          listPath: string,
          total: number,
          pending: number,
          done: number,
          failed: number,
          other: number,
          preview: array(string),
        }),
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              `列表：${value.listPath}`,
              `共 ${value.total} 条：待抓 ${value.pending}，已完成 ${value.done}，失败 ${value.failed}，其他 ${value.other}`,
              ...value.preview,
            ].join('\n'),
          },
        ],
      },
      async execute(args) {
        const listPath = args.listPath ?? runtime.getListPath().absolute;
        let items;
        try {
          items = await loadUrlList(listPath);
        } catch (error) {
          // 文件不存在是常见情况，给个空结果比抛错友好
          void error;
          return { listPath, total: 0, pending: 0, done: 0, failed: 0, other: 0, preview: [`（读不到列表文件：${listPath}）`] };
        }
        const summary = summarizeList(items);
        const preview = items.slice(0, 10).map((item, index) => {
          const title = typeof item.title === 'string' && item.title.length > 0 ? item.title : item.url;
          return `${index + 1}. [${item.status ?? 'pending'}] ${title}`;
        });
        return { listPath, ...summary, preview };
      },
    }),
  );
}

/** 供单测：从文件内容上直接统计（不落盘）。 */
export async function previewList(listPath: string): Promise<string> {
  const raw = await readFile(listPath, 'utf8');
  return raw.slice(0, 200);
}
