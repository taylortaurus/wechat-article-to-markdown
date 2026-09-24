/**
 * 插件配置（Schemastery）。
 *
 * 遵循 dsh 的设计原则：「**凡是不同部署可能采用不同值的参数，都必须做成配置字段**」。
 * 检验标准是——能不能在 `cordis.yml` 里改掉它而不动代码。
 *
 * 特别地，**输出根目录不许写死**（用户明确要求）：默认值由运行时环境决定
 * （工作区目录），这里只提供一个可选覆盖。
 */
import Schema from '@deepseek-ai/schemastery';

export interface Config {
  /**
   * 输出根目录。
   *
   * 留空 = 用当前 dsh 工作区下的 `output/`。**不要**在这里写绝对路径当作默认值 ——
   * 默认必须来自运行时环境，否则换台机器就错。
   */
  outputRoot: string;
  /** 落盘布局。`flat` 是 spider-claw 现有的行为；`byAccountDate` 借鉴参考实现。 */
  layout: 'flat' | 'byAccountDate';
  /** `url-list.json` 的路径。留空 = 工作区根目录下的 `url-list.json`。 */
  listPath: string;
  /** 枚举翻页的基准间隔（毫秒）。**默认 3 秒，不要调低。** */
  pageDelayMs: number;
  /** 频控退避倍数。 */
  backoffFactor: number;
  /** 单次退避上限（毫秒）。 */
  maxBackoffMs: number;
  /** 频控最多重试几次。 */
  maxRetries: number;
  /** 列文章时每页请求多少条。 */
  listPageSize: number;
  /** 单次枚举最多产出多少条（硬上限，防止把账号送进风控）。 */
  maxArticles: number;
  /** 单个 HTTP 请求的超时（毫秒）。 */
  requestTimeoutMs: number;
  /**
   * 单篇抓取的超时（毫秒）。
   *
   * **不能省**：浏览器被环境杀掉时底层会无限等下去，没有这个守卫用户会看到
   * 界面永远卡在「深度求索中」而且点不动取消。
   */
  fetchTimeoutMs: number;
  /** 批量抓取的整体上限（毫秒）。列表很长时按需调大。 */
  listTimeoutMs: number;
  /** 抓正文时的代理策略，透传给 spider-claw。 */
  proxy: string;
  /**
   * 频控的 `ret` 码。
   *
   * **默认为空是有意的**：源码里只见过 0 和 200003，凭空猜码号会把正常错误误判成频控。
   * 等 P0-2 实测出真值后填进来。
   */
  rateLimitCodes: number[];
  /** 枚举完成后是否立刻接着抓正文。默认关 —— 把两个耗时动作分开便于中断。 */
  fetchAfterSync: boolean;
}

/** 默认值。`normalizeConfig` 以它为基底合并用户配置。 */
export const DEFAULT_CONFIG: Config = {
  outputRoot: '',
  layout: 'flat',
  listPath: '',
  pageDelayMs: 3000,
  backoffFactor: 2,
  maxBackoffMs: 60_000,
  maxRetries: 3,
  listPageSize: 20,
  maxArticles: 500,
  requestTimeoutMs: 20_000,
  fetchTimeoutMs: 120_000,
  listTimeoutMs: 1_800_000,
  proxy: 'direct',
  rateLimitCodes: [],
  fetchAfterSync: false,
};

/**
 * 给宿主用的 schema。
 *
 * 类型标成 `unknown` 是因为 Schemastery 的真实类型在本机拿不到（见 `dsh-shim.d.ts`）；
 * 宿主会按 `cordis.yml` 的 `config:` 校验并填充默认值，这里的形状必须与
 * `Config` 接口一一对应。
 */
export const Config: unknown = Schema.object({
  outputRoot: Schema.string().default('').description('输出根目录；留空则用当前工作区下的 output/'),
  layout: Schema.union(['flat', 'byAccountDate']).default('flat').description('落盘布局'),
  listPath: Schema.string().default('').description('url-list.json 路径；留空则用工作区根目录下的同名文件'),
  pageDelayMs: Schema.number().default(3000).description('枚举翻页间隔（毫秒），默认 3000'),
  backoffFactor: Schema.number().default(2).description('频控退避倍数'),
  maxBackoffMs: Schema.number().default(60_000).description('单次退避上限（毫秒）'),
  maxRetries: Schema.number().default(3).description('频控最大重试次数'),
  listPageSize: Schema.number().default(20).description('列文章每页条数'),
  maxArticles: Schema.number().default(500).description('单次枚举的最大条数（硬上限）'),
  requestTimeoutMs: Schema.number().default(20_000).description('单请求超时（毫秒）'),
  fetchTimeoutMs: Schema.number().default(120_000).description('单篇抓取超时（毫秒），默认 120000'),
  listTimeoutMs: Schema.number().default(1_800_000).description('批量抓取整体上限（毫秒），默认 1800000'),
  proxy: Schema.string().default('direct').description("抓正文的代理策略：'direct' | 'env' | 代理地址"),
  rateLimitCodes: Schema.array(Schema.number()).default([]).description('频控的 ret 码（实测后填）'),
  fetchAfterSync: Schema.boolean().default(false).description('枚举完是否立刻抓正文'),
});

/** 配置的最小值保护：即使有人在 cordis.yml 里传了 0 也不会把账号打爆。 */
export function normalizeConfig(raw: Config): Config {
  return {
    ...raw,
    pageDelayMs: Math.max(1000, raw.pageDelayMs),
    backoffFactor: Math.max(1.1, raw.backoffFactor),
    maxBackoffMs: Math.max(1000, raw.maxBackoffMs),
    maxRetries: Math.max(0, Math.min(10, raw.maxRetries)),
    listPageSize: Math.max(1, Math.min(50, raw.listPageSize)),
    maxArticles: Math.max(1, Math.min(5000, raw.maxArticles)),
    requestTimeoutMs: Math.max(1000, raw.requestTimeoutMs),
    fetchTimeoutMs: Math.max(10_000, raw.fetchTimeoutMs),
    listTimeoutMs: Math.max(60_000, raw.listTimeoutMs),
  };
}
