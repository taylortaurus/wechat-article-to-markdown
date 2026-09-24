/**
 * E3 账号入口：扫码 → 搜号 → 枚举。**只有这一条链路需要登录。**
 *
 * 四个工具：authorize / search_account / list_articles / sync_account。
 * sync_account 是长任务，走 `ctx.jobs`。
 *
 * 关于 `ctx.jobs` 的用法，这里是照 `packages/jobs/jobs/src/types.ts` 写的：
 * **`run()` 不接收任何参数、同步返回 `JobHooks`**；取消由 owner 调
 * `ctx.jobs.kill(id)` 发起，运行时再转发给生产方自己的 `hooks.cancel`。
 * 所以取消控制器要**插件自己持有**（`AbortController`），在 `cancel` 里触发。
 * （评估文档初稿把这写成了 `run: async (ownSignal) => …`，那是错的。）
 */

import { loadUrlList } from 'spider-claw';

import { describeErrorForModel } from '../provider/errors.js';
import { mergeArticlesIntoList } from '../output/url-list.js';
import type { AuthorizeResult, ListResult, OfficialAccount, MpArticle } from '../definition/types.js';
import { defineTool } from './schema.js';
import type { QrDelivery } from '../auth/delivery.js';
import type { Runtime } from '../deps.js';

/** 工具层的统一返回：要么成功值，要么一句可读的错误。 */
type ToolOutcome<T> = T | { error: string };

/** 把文章清单压成给模型看的一行。 */
function formatArticleLine(article: MpArticle, index: number): string {
  const bits = [
    `${index + 1}. ${article.title || '(无标题)'}`,
    article.publishTime || '未知时间',
  ];
  if (article.isOriginal) bits.push('原创');
  if (article.isPaySubscribe) bits.push('付费');
  if (article.itemShowType !== 'article') bits.push(article.itemShowType);
  if (article.isDeleted) bits.push('已删除');
  return bits.join(' · ');
}

export interface AccountEntryDeps {
  runtime: Runtime;
  /**
   * 懒解析宿主的长任务服务。**在工具执行时**才读 —— `apply` 阶段服务可能还没就绪。
   */
  resolveJobs?: (() => { start(decl: unknown): Promise<{ id: string }> } | undefined) | undefined;
  /**
   * 懒解析二维码交付通道。授权时要靠它把二维码送到用户眼前。
   */
  resolveDelivery?: (() => QrDelivery | undefined) | undefined;
}

export function registerAccountEntryTools(
  ctx: { tools: { register(tool: unknown): unknown } },
  deps: AccountEntryDeps,
): void {
  const { runtime } = deps;
  const provider = runtime.provider;

  // ------------------------------------------------------------------------- #
  // E3-1 扫码授权
  // ------------------------------------------------------------------------- #
  ctx.tools.register(
    defineTool<{ force?: boolean }, ToolOutcome<AuthorizeResult>>({
      name: 'wechat_mp_authorize',
      description:
        '扫码登录微信公众平台后台，取得枚举公众号文章所需的登录态。' +
        '需要你的微信是某个公众号的管理员或运营者。二维码会写到配置的工作区目录下，' +
        '请打开图片用微信扫描并在手机上确认。授权结果会保存下来供后续复用。',
      parameters: {
        force: { type: 'boolean', description: '忽略已保存的凭据，强制重新扫码' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            nickname: { type: 'string' },
            credentialSource: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if ('error' in value) return [{ type: 'text', text: value.error }];
          if (value.status === 'already_authorized') {
            return [{ type: 'text', text: '已存在可用的登录态，无需重新扫码。\n直接可以搜号或列文章。' }];
          }
          if (value.status === 'cancelled') return [{ type: 'text', text: '授权已取消。' }];
          return [
            {
              type: 'text',
              text: [
                `授权成功${value.nickname ? `：${value.nickname}` : ''}（凭据来源：${value.credentialSource}）`,
                '接下来可以：wechat_mp_search_account 搜号 → wechat_mp_list_articles 列文章 → wechat_mp_sync_account 写入清单。',
              ].join('\n'),
            },
          ];
        },
      },
      async execute(args, exec) {
        const delivery = deps.resolveDelivery?.();
        try {
          if (delivery) await delivery.begin();
          const result = await provider.authorize({
            ...(args.force === undefined ? {} : { force: args.force }),
            signal: exec.signal,
            ...(delivery
              ? { onProgress: (progress) => void delivery.publish(progress) }
              : {}),
          });
          await delivery?.end();
          return result;
        } catch (error) {
          await delivery?.end();
          return { error: `扫码授权失败：${describeErrorForModel(error)}` };
        }
      },
    }),
  );

  // ------------------------------------------------------------------------- #
  // E3-2 搜公众号
  // ------------------------------------------------------------------------- #
  ctx.tools.register(
    defineTool<{ query: string; limit?: number }, ToolOutcome<{ accounts: OfficialAccount[] }>>({
      name: 'wechat_mp_search_account',
      description:
        '按昵称或微信号搜索公众号，返回候选列表（含 fakeid）。' +
        'fakeid 是后续列文章必须用到的标识。需要先完成扫码授权。',
      parameters: {
        query: { type: 'string', required: true, description: '公众号昵称或微信号' },
        limit: { type: 'number', description: '最多返回几个候选，默认 5' },
      },
      output: {
        schema: {
          type: 'object',
          properties: { accounts: { type: 'array' }, error: { type: 'string' } },
        },
        render: (_args, value) => {
          if ('error' in value) return [{ type: 'text', text: value.error }];
          if (value.accounts.length === 0) return [{ type: 'text', text: '没有搜到匹配的公众号。换个关键词试试。' }];
          return [
            {
              type: 'text',
              text: value.accounts
                .map((a, i) => `${i + 1}. ${a.nickname}${a.alias ? `（${a.alias}）` : ''}\n   简介：${a.signature || '(无)'}`)
                .join('\n'),
            },
          ];
        },
      },
      async execute(args) {
        try {
          const accounts = await provider.searchAccounts(args.query, args.limit ?? 5);
          return { accounts };
        } catch (error) {
          return { error: `搜索公众号失败：${describeErrorForModel(error)}` };
        }
      },
    }),
  );

  // ------------------------------------------------------------------------- #
  // E3-3 列文章
  // ------------------------------------------------------------------------- #
  ctx.tools.register(
    defineTool<
      {
        fakeid: string;
        keyword?: string;
        since?: string;
        until?: string;
        originalOnly?: boolean;
        albumName?: string;
        includeDeleted?: boolean;
        limit?: number;
      },
      ToolOutcome<ListResult>
    >({
      name: 'wechat_mp_list_articles',
      description:
        '列出某个公众号的已群发文章（**只有元数据，没有正文**）。支持服务端关键词检索、' +
        '时间区间、仅原创、按合集筛选。需要先完成扫码授权。' +
        '正文要用 wechat_fetch_article 或 wechat_fetch_list 去抓。',
      parameters: {
        fakeid: { type: 'string', required: true, description: '公众号标识，来自 wechat_mp_search_account' },
        keyword: { type: 'string', description: '服务端关键词检索' },
        since: { type: 'string', description: '发布时间下界，YYYY-MM-DD' },
        until: { type: 'string', description: '发布时间上界，YYYY-MM-DD' },
        originalOnly: { type: 'boolean', description: '只要原创文章' },
        albumName: { type: 'string', description: '按合集名筛选' },
        includeDeleted: { type: 'boolean', description: '是否包含已删除的文章，默认 false' },
        limit: { type: 'number', description: '最多返回多少条，默认 100' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            articles: { type: 'array' },
            totalCount: { type: 'number' },
            truncated: { type: 'boolean' },
            pagesFetched: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if ('error' in value) return [{ type: 'text', text: value.error }];
          if (value.articles.length === 0) return [{ type: 'text', text: '没有符合条件的文章。' }];
          const head = `共取到 ${value.articles.length} 篇（请求了 ${value.pagesFetched} 页${value.truncated ? '，已按上限截断' : ''}）：`;
          return [{ type: 'text', text: [head, ...value.articles.slice(0, 30).map(formatArticleLine)].join('\n') }];
        },
      },
      async execute(args) {
        try {
          return await provider.listArticles({
            fakeid: args.fakeid,
            ...(args.keyword === undefined ? {} : { keyword: args.keyword }),
            ...(args.since === undefined ? {} : { since: args.since }),
            ...(args.until === undefined ? {} : { until: args.until }),
            ...(args.originalOnly === undefined ? {} : { originalOnly: args.originalOnly }),
            ...(args.albumName === undefined ? {} : { albumName: args.albumName }),
            ...(args.includeDeleted === undefined ? {} : { includeDeleted: args.includeDeleted }),
            limit: args.limit ?? Math.min(100, runtime.config.maxArticles),
            count: runtime.config.listPageSize,
          });
        } catch (error) {
          return { error: `列文章失败：${describeErrorForModel(error)}` };
        }
      },
    }),
  );

  // ------------------------------------------------------------------------- #
  // E3-4 同步一个账号（长任务）
  // ------------------------------------------------------------------------- #

  interface SyncValue {
    kind: 'background';
    jobId: string;
  }
  interface SyncDone {
    kind: 'completed';
    discovered: number;
    queued: number;
    duplicates: number;
    excluded: number;
    excludedReasons: string[];
    listPath: string;
    outputRoot: string;
    fetched: boolean;
  }

  ctx.tools.register(
    defineTool<
      {
        fakeid: string;
        accountName?: string;
        since?: string;
        until?: string;
        listPath?: string;
        background?: boolean;
        fetchAfterSync?: boolean;
      },
      ToolSyncOutcome
    >({
      name: 'wechat_mp_sync_account',
      description:
        '枚举某个公众号的文章并写入 url-list.json（可选接着抓正文）。' +
        '这是"喂料"动作：产出的清单正好是 wechat_fetch_list 的输入。需要先扫码授权。' +
        '已存在（按来源+文章ID 去重）的条目不会重复添加；已删除和非图文类会被排除。',
      parameters: {
        fakeid: { type: 'string', required: true, description: '公众号标识' },
        accountName: { type: 'string', description: '账号名，用于 byAccountDate 布局与清单标注' },
        since: { type: 'string', description: '只取这个日期之后发布的，YYYY-MM-DD' },
        until: { type: 'string', description: '只取这个日期之前发布的，YYYY-MM-DD' },
        listPath: { type: 'string', description: '列表文件路径；不传用默认位置' },
        background: { type: 'boolean', description: '是否作为后台任务运行，默认 false' },
        fetchAfterSync: { type: 'boolean', description: '枚举完是否接着抓正文，默认取插件配置' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            jobId: { type: 'string' },
            discovered: { type: 'number' },
            queued: { type: 'number' },
            duplicates: { type: 'number' },
            excluded: { type: 'number' },
            listPath: { type: 'string' },
            outputRoot: { type: 'string' },
            fetched: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if ('error' in value) return [{ type: 'text', text: value.error }];
          if (value.kind === 'background') {
            return [{ type: 'text', text: `已在后台开始枚举（任务 ${value.jobId}）。可以用 dsh 的任务工具查看进度。` }];
          }
          return [
            {
              type: 'text',
              text: [
                `枚举完成：发现 ${value.discovered} 篇`,
                `新入列 ${value.queued} 篇，重复跳过 ${value.duplicates} 篇，排除 ${value.excluded} 篇`,
                ...(value.excludedReasons.length > 0 ? value.excludedReasons.slice(0, 5).map((r) => `  · ${r}`) : []),
                `清单：${value.listPath}`,
                value.fetched ? '已接着抓取正文' : '正文还没抓，可以下一步用 wechat_fetch_list',
              ].join('\n'),
            },
          ];
        },
      },
      async execute(args, exec): Promise<ToolSyncOutcome> {
        const listPath = args.listPath ?? runtime.getListPath().absolute;
        const outputRoot = runtime.getOutputRoot().absolute;
        const fetchAfter = args.fetchAfterSync ?? runtime.config.fetchAfterSync;

        const work = async (signal: AbortSignal): Promise<SyncDone | { error: string }> => {
          try {
            const result = await provider.listArticles({
              fakeid: args.fakeid,
              ...(args.since === undefined ? {} : { since: args.since }),
              ...(args.until === undefined ? {} : { until: args.until }),
              limit: runtime.config.maxArticles,
              count: runtime.config.listPageSize,
            });
            if (signal.aborted) return { error: '任务已取消。' };

            const merged = await mergeArticlesIntoList(result.articles, {
              listPath,
              accountName: args.accountName ?? args.fakeid,
            });

            let fetched = false;
            if (fetchAfter && merged.appended > 0 && !signal.aborted) {
              const { runList } = await import('spider-claw');
              const { withListLock } = await import('../output/list-lock.js');
              await withListLock(listPath, () => runList(listPath, outputRoot, runtime.proxy as never));
              fetched = true;
            }

            return {
              kind: 'completed',
              discovered: result.articles.length,
              queued: merged.appended,
              duplicates: merged.duplicates,
              excluded: merged.excluded,
              excludedReasons: merged.excludedReasons,
              listPath,
              outputRoot,
              fetched,
            };
          } catch (error) {
            return { error: `同步失败：${describeErrorForModel(error)}` };
          }
        };

        // 长任务路径
        const jobs = deps.resolveJobs?.();
        if (args.background === true && jobs) {
          // 插件自己持有取消控制器 —— `run()` 不会给你 per-job 的 signal
          const controller = new AbortController();
          const started = await jobs.start({
            kind: 'wechat-mp-sync',
            label: `同步公众号 ${args.accountName ?? args.fakeid} 的文章`,
            owner: exec.agent,
            run(): unknown {
              const promise = work(controller.signal);
              return {
                cancel(reason?: string): void {
                  controller.abort(new Error(reason ?? 'cancelled'));
                },
                done: promise.then(
                  (value) => ({ status: 'completed' as const, detail: 'error' in value ? value.error : `${value.queued} queued` }),
                  () => ({ status: 'killed' as const }),
                ),
              };
            },
          });
          return { kind: 'background', jobId: started.id };
        }

        // 前台路径
        return await work(exec.signal);
      },
    }),
  );

  // ------------------------------------------------------------------------- #
  // 退出登录
  // ------------------------------------------------------------------------- #
  ctx.tools.register(
    defineTool<Record<string, never>, ToolOutcome<{ cleared: boolean }>>({
      name: 'wechat_mp_logout',
      description: '丢弃已保存的登录态。下次枚举需要重新扫码。',
      parameters: {},
      output: {
        schema: { type: 'object', properties: { cleared: { type: 'boolean' }, error: { type: 'string' } } },
        render: (_args, value) => {
          if ('error' in value) return [{ type: 'text', text: value.error }];
          return [{ type: 'text', text: '已清除登录态。' }];
        },
      },
      async execute() {
        try {
          await provider.clearSession();
          return { cleared: true };
        } catch (error) {
          return { error: `清除登录态失败：${describeErrorForModel(error)}` };
        }
      },
    }),
  );

  /** 顺带暴露一个"我现在有没有登录"的查询，避免模型瞎猜。 */
  ctx.tools.register(
    defineTool<Record<string, never>, { authorized: boolean; savedAt?: string; source: string; listPath: string; outputRoot: string }>({
      name: 'wechat_mp_status',
      description: '查询当前登录态、清单路径与输出根目录（不发起任何抓取）。',
      parameters: {},
      output: {
        schema: { type: 'object', properties: { authorized: { type: 'boolean' }, savedAt: { type: 'string' }, source: { type: 'string' }, listPath: { type: 'string' }, outputRoot: { type: 'string' } } },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              `登录态：${value.authorized ? `有效（保存于 ${value.savedAt ?? '未知'}，来源 ${value.source}）` : '无'}`,
              `清单路径：${value.listPath}`,
              `输出根目录：${value.outputRoot}`,
            ].join('\n'),
          },
        ],
      },
      async execute() {
        const session = provider.getSession();
        const listItems = await loadUrlList(runtime.getListPath().absolute).catch(() => []);
        void listItems;
        return {
          authorized: provider.hasUsableSession(),
          ...(session?.savedAt === undefined ? {} : { savedAt: session.savedAt }),
          source: 'session',
          listPath: runtime.getListPath().absolute,
          outputRoot: runtime.getOutputRoot().absolute,
        };
      },
    }),
  );
}

type ToolSyncOutcome =
  | { kind: 'background'; jobId: string }
  | { error: string }
  | {
      kind: 'completed';
      discovered: number;
      queued: number;
      duplicates: number;
      excluded: number;
      excludedReasons: string[];
      listPath: string;
      outputRoot: string;
      fetched: boolean;
    };
