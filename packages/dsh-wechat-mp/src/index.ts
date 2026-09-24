/**
 * 插件入口。
 *
 * 定位（评估文档第 2 节）：**三个入口 + 两条链路**。
 *  - E1 单链接 / E2 列表：走 spider-claw 的抓取链路，**不需要登录**
 *  - E3 账号：走本插件新增的枚举链路，**只有这一段需要扫码**
 *
 * E3 的产物就是 E2 的输入（都写在 `url-list.json`），所以这里是"喂料器 + 消费者"
 * 的关系，不是三条平行链路。
 */
import type { Context } from '@deepseek-ai/cordis';

import { Config as ConfigSchema, DEFAULT_CONFIG, normalizeConfig, type Config } from './config.js';
import { Runtime } from './deps.js';
import { FileSessionStore, pickSessionStore } from './auth/session-store.js';
import { CompositeQrDelivery, QrState, registerQrRoutes, type WebServerLike } from './auth/delivery.js';
export { registerConfigRoutes } from './tools/config-routes.js';
export { ConfigStore, configPathFor, parseConfigPatch, CONFIG_FILENAME } from './output/config-store.js';
import { MpLocalProvider } from './provider/mp-local.js';
import { registerSingleEntryTools } from './tools/entry-single.js';
import { registerListEntryTools } from './tools/entry-list.js';
import { registerAccountEntryTools } from './tools/entry-account.js';
import { registerOutputConfigTools } from './tools/output-config.js';
import { withNormalizedSchemas } from './tools/normalize-schema.js';
import { registerConfigRoutes } from './tools/config-routes.js';

export const name = 'wechat-mp';

/** 依赖工具注册表就绪。 */
export const inject = ['tools'];

/** 导出配置 schema，宿主会用它校验 `cordis.yml` 里的 `config:`。 */
export { ConfigSchema as Config };

/**
 * 安全地读一个**可选**服务。
 *
 * **必须走 `ctx.get(name)`，不能写 `ctx[name]`。**
 * cordis 的 `Context` 是 Proxy，读一个没有在 `inject` 里声明的服务会**直接抛**
 * `cannot get property "x" without inject` —— 而插件 `apply` 抛错会让**整个 dsh 进程
 * 启动失败**（实测确认过：web 起不来）。`ctx.get()` 对缺失的服务返回 `undefined`。
 */
function optionalService<T>(ctx: unknown, key: string): T | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined;
  const get = (ctx as { get?: (name: string) => unknown }).get;
  if (typeof get !== 'function') return undefined;
  const value = get.call(ctx, key);
  return value === undefined || value === null ? undefined : (value as T);
}

/**
 * 插件入口。
 *
 * **外面包了一层 try/catch**：实测发现，`apply` 里任何未捕获的异常都会让**整个 dsh
 * 进程起不来**（不是只有本插件失效）。对一个"只是加几个工具"的插件来说，这个代价
 * 完全不成比例，所以这里选择"大声记录、但不抛出"。
 */
export function apply(ctx: Context, rawConfig: Config): void {
  try {
    applyInner(ctx, rawConfig);
  } catch (error) {
    reportInitFailure(ctx, error);
  }
}

/** 尽力把初始化失败吼出来 —— 但不能因为记录日志再抛一次。 */
function reportInitFailure(ctx: unknown, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const message = `[dsh-wechat-mp] 插件初始化失败，本插件的工具与界面卡片都不会可用。原因：${detail}`;
  try {
    const logger = optionalService<{ error?: (msg: string) => void }>(ctx, 'logger');
    if (logger && typeof logger.error === 'function') {
      logger.error(message);
      return;
    }
  } catch {
    /* logger 也拿不到就直接往控制台写 */
  }
  console.error(message);
}

function applyInner(ctx: Context, rawConfig: Config): void {
  // 以默认值为基底合并用户配置。宿主在加载时已经按 schema 校验并填过默认值，
  // 这里再兜一次，保证直接以库方式调用时也拿到完整配置。
  const config = normalizeConfig({ ...DEFAULT_CONFIG, ...(rawConfig ?? ({} as Config)) });

  // 输出根目录的默认值来自运行时环境（dsh 的工作区目录，退化为进程 cwd），
  // 绝不在这里写死绝对路径。
  const cwd = process.cwd();
  const workspaceRoot = readWorkspaceRoot(ctx);

  const sessionPath = resolveSessionPathSafely(workspaceRoot, cwd);
  const sessionStore = pickSessionStore(ctx, sessionPath);

  const provider = new MpLocalProvider({
    sessionStore,
    throttle: {
      baseDelayMs: config.pageDelayMs,
      backoffFactor: config.backoffFactor,
      maxDelayMs: config.maxBackoffMs,
      maxRetries: config.maxRetries,
    },
    requestTimeoutMs: config.requestTimeoutMs,
    ...(config.rateLimitCodes.length > 0 ? { rateLimitCodes: config.rateLimitCodes } : {}),
  });

  const runtime = new Runtime({
    config,
    provider,
    workspaceRoot,
    cwd,
  });

  // 恢复上次的登录态。不阻塞 apply —— 失败也不影响插件可用。
  void provider.restore().catch(() => undefined);

  // ---- 二维码交付：双通道（HTTP 路由 + 落文件）----
  //
  // 路由依赖宿主的 `webServer` 服务，而它是**异步就绪**的。所以必须在 `apply` 里用
  // `ctx.inject(['webServer'], …)` 等它 —— **不能**在这一刻用 `ctx.get('webServer')` 抢，
  // 那时它通常还是 undefined，结果就是路由静默没挂上（对外表现为 404）。这个坑实测踩过。
  const qrState = new QrState();
  const qrFilePath = `${runtime.getOutputRoot().absolute}/.dsh-wechat-mp/qrcode.png`;
  const delivery = new CompositeQrDelivery(qrState, qrFilePath);

  ctx.inject(['webServer'], (injected) => {
    try {
      const webServer = (injected as unknown as { webServer: WebServerLike }).webServer;
      const disposeQr = registerQrRoutes(webServer, qrState);
      // 配置读写路由：可视化配置工作台的后端（GET/POST /wechat-mp/config）
      const disposeConfig = registerConfigRoutes(webServer, { runtime });
      injected.effect(() => () => {
        disposeQr();
        disposeConfig();
      });
    } catch {
      // 路由挂不上不影响插件可用 —— 落文件那条通道还在。
    }
  });

  // 应用"界面上改过的"配置覆盖（优先级高于 cordis.yml，低于工具显式参数）
  void runtime
    .loadPersistedConfig()
    .then((patch) => runtime.applyPersisted(patch))
    .catch(() => undefined);

  // ---- 三个入口的工具 ----
  //
  // 包一层 `withNormalizedSchemas`：dsh 要求显式对象节点必须声明
  // `additionalProperties`，漏一个就会让整个插件加载失败。这一层在注册前
  // 统一补齐，避免"某个工具漏个字段导致全盘挂掉"。
  const registryCtx = {
    tools: withNormalizedSchemas(
      ctx.tools as { register(tool: unknown): unknown },
      // 每次工具执行前刷新"当前会话的工作目录"。
      // 缺了这一步，产物会落到 dsh 的启动目录而不是用户选的工作区（实测踩过）。
      (exec) => runtime.adoptSessionWorkspace(ctx, (exec as { agent?: unknown } | undefined)?.agent),
    ),
  };

  registerOutputConfigTools(registryCtx, {
    runtime,
    // 懒解析：工具**执行时**服务一定已就绪，这时读才可靠
    resolveSettingsScope: () => optionalService(ctx, 'settingsScope'),
  });

  registerSingleEntryTools(registryCtx, { runtime });
  registerListEntryTools(registryCtx, { runtime });

  registerAccountEntryTools(registryCtx, {
    runtime,
    resolveJobs: () => optionalService(ctx, 'jobs'),
    resolveDelivery: () => delivery,
  });

  // 插件卸载时收尾（二维码状态清掉；文件留着，用户可能还没来得及扫）
  ctx.effect(() => () => {
    void delivery.end();
  });
}

/**
 * 尽量读一个工作区目录；读不到就返回 undefined（由 `Runtime` 退化到 cwd）。
 *
 * 同样**只能通过 `ctx.get()`**，不能试探性地读 `ctx.workspaceRoot` —— 那会抛错并
 * 拖垮整个 dsh 启动（这个坑实测踩过）。
 *
 * 宿主可能把工作区暴露成不同的服务名，所以逐个用 `get()` 试；都不是字符串就放弃，
 * 交给 cwd 兜底。**不猜、不硬编码。**
 */
function readWorkspaceRoot(ctx: unknown): string | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined;
  const get = (ctx as { get?: (name: string) => unknown }).get;
  if (typeof get !== 'function') return undefined;

  const candidates = ['workspaceRoot', 'workspace', 'cwd'];
  for (const key of candidates) {
    const value = get.call(ctx, key);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function resolveSessionPathSafely(workspaceRoot: string | undefined, cwd: string): string {
  const base = workspaceRoot ?? cwd;
  return `${base}/.dsh-wechat-mp/session.json`;
}

// ---- 库式导出，便于单测直接构造 ----
export { Runtime } from './deps.js';
export { MpLocalProvider } from './provider/mp-local.js';
export { FileSessionStore, pickSessionStore, deserializeSession } from './auth/session-store.js';
export {
  CompositeQrDelivery,
  FileQrDelivery,
  NoopQrDelivery,
  QrState,
  pickDelivery,
  registerQrRoutes,
} from './auth/delivery.js';
export { normalizeConfig, ConfigSchema, DEFAULT_CONFIG };
export * from './definition/types.js';
export type { AuthorizeOptions, ScanProgress } from './definition/service.js';
export { WechatMpService } from './definition/service.js';
export * as endpoints from './provider/endpoints.js';
export {
  extractTokenFromRedirect,
  filterArticles,
  parseAccountList,
  parseAppMsgPublish,
  parseMaybeJson,
  parseProfile,
  parseScanStatus,
  readEnvelope,
  toMpArticle,
  unpackPublishPage,
} from './provider/parse.js';
export {
  MpAuthExpiredError,
  MpBusinessError,
  MpRateLimitedError,
  MpTransportError,
  MpUnexpectedShapeError,
  describeErrorForModel,
  isAuthExpired,
  isRateLimited,
  throwIfNotOk,
} from './provider/errors.js';
export { Throttle, withRateLimitRetry, DEFAULT_THROTTLE } from './provider/throttle.js';
export { articleDirectory, sanitizeSegment, markdownFileName } from './output/layout.js';
export { resolveListPath, resolveOutputRoot, describeOrigin } from './output/root.js';
export { acquireListLock, withListLock, ListLockTimeoutError, lockPathFor } from './output/list-lock.js';
export { bodyCharCount, inspectContent, shouldQueueForFetch } from './output/guard.js';
export { articleToListItem, dedupKeyOf, mergeArticlesIntoList, summarizeList } from './output/url-list.js';
