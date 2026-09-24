/**
 * 错误映射：把微信后台的 `ret` 码翻译成**有语义的领域错误**。
 *
 * 这里刻意与参考实现反着做：它只要 `ret != 0` 就记一条 warning 然后返回空列表
 * （`OfficialAccountService.cs:75-79`、`ArticleService.cs:122-126`），于是**错误被吞成了
 * 空结果** —— 调用方没法区分「这个号没有文章」和「接口挂了」。我们一律抛错。
 */

/** 所有本插件错误的基类。 */
export class MpWechatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * 登录失效（`ret === 200003`）。
 *
 * 这是**被动过期**的唯一判据 —— 不看本地时钟。CI/调用方见到它就该提示用户重新授权。
 */
export class MpAuthExpiredError extends MpWechatError {
  constructor(context: string, errMsg?: string) {
    super(`登录已失效（${context}）。请重新执行扫码授权。${errMsg ? ` 服务端提示：${errMsg}` : ''}`);
  }
}

/**
 * 触发频控 / 请求过快。
 *
 * **注意**：频控的真实错误码至今没测出来（评估文档 P0-2），所以这个类目前只能由
 * `RateLimitCodes` 里配置的码触发。在实测之前不要凭猜测往里加码。
 */
export class MpRateLimitedError extends MpWechatError {
  readonly ret: number;
  constructor(ret: number, context: string, errMsg?: string) {
    super(`请求过于频繁（${context}，ret=${ret}）。${errMsg ? ` 服务端提示：${errMsg}` : ''}`);
    this.ret = ret;
  }
}

/** 其他业务错误：把 `ret` 和 `errMsg` 原样带出来，不要吞。 */
export class MpBusinessError extends MpWechatError {
  readonly ret: number;
  readonly context: string;
  constructor(ret: number, context: string, errMsg: string) {
    super(`${context} 失败：ret=${ret}${errMsg ? ` ${errMsg}` : ''}`);
    this.ret = ret;
    this.context = context;
  }
}

/** 网络/传输层问题（非业务码）。 */
export class MpTransportError extends MpWechatError {}

/** 响应形状不符合预期（解析不出必要字段）。 */
export class MpUnexpectedShapeError extends MpWechatError {}

/**
 * 需要被当成「频控」的 `ret` 码。
 *
 * 目前是空的：源码里只见过 `0` 和 `200003`，凭空猜码号会把正常错误误判成频控。
 * **等 P0-2 实测出结果后，把码号加到这个集合里**（或由配置注入）。
 */
export const DEFAULT_RATE_LIMIT_CODES: readonly number[] = [];

export interface MapRetOptions {
  /** 这次调用在做什么，用于拼错误信息。 */
  context: string;
  /** 额外的频控码（实测后由配置传入）。 */
  rateLimitCodes?: readonly number[];
}

export interface EnvelopeLike {
  ret: number;
  errMsg: string;
}

/**
 * 按信封判定结果：成功返回，否则抛对应的领域错误。
 *
 * 调用方拿到异常就知道是"真的失败了"，而不是像参考实现那样拿到一个空列表。
 */
export function throwIfNotOk(envelope: EnvelopeLike, options: MapRetOptions): void {
  const { ret, errMsg } = envelope;
  if (ret === 0) return;

  const rateLimitCodes = options.rateLimitCodes ?? DEFAULT_RATE_LIMIT_CODES;
  if (rateLimitCodes.includes(ret)) {
    throw new MpRateLimitedError(ret, options.context, errMsg);
  }
  // 200003 单列：它是"被动过期"的判据
  if (ret === 200003) {
    throw new MpAuthExpiredError(options.context, errMsg);
  }
  throw new MpBusinessError(ret, options.context, errMsg);
}

/** 判断一个异常是不是「登录失效」。 */
export function isAuthExpired(error: unknown): error is MpAuthExpiredError {
  return error instanceof MpAuthExpiredError;
}

/** 判断一个异常是不是「频控」。 */
export function isRateLimited(error: unknown): error is MpRateLimitedError {
  return error instanceof MpRateLimitedError;
}

/** 面向模型的提示语（`render` 里用）。 */
export function describeErrorForModel(error: unknown): string {
  if (error instanceof MpAuthExpiredError) {
    return '登录已失效。请先调用 `wechat_mp_authorize` 重新扫码授权，然后重试刚才的操作。';
  }
  if (error instanceof MpRateLimitedError) {
    return '请求过于频繁被微信拒绝。已自动退避重试；若持续失败，请调大配置里的 `pageDelayMs`（默认 3000 毫秒）。';
  }
  if (error instanceof MpBusinessError) {
    return `微信后台返回业务错误（ret=${error.ret}）：${error.message}`;
  }
  if (error instanceof MpTransportError) {
    return `网络请求失败：${error.message}`;
  }
  if (error instanceof MpUnexpectedShapeError) {
    return `微信返回的结构与预期不符，可能是接口改版：${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
