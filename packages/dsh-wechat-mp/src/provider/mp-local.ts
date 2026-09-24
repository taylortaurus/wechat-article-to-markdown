/**
 * 纯 HTTP 提供方：实现 `WechatMpService`。
 *
 * 这里刻意做对的几件事（都是参考实现踩过的坑）：
 *
 *  - **Cookie 只有一个来源**（缺陷 A1）：只维护一个内存 jar，请求头由它派生，
 *    绝不"自动管理 + 手动拼字符串"两套并存。
 *  - **会话不可变**（缺陷 A2）：拿到新 Cookie 一律 `saveSession(新对象)`，
 *    失效也只是换成 `invalid: true` 的新对象，不原地清字段。
 *  - **不吞错误**：`ret != 0` 一律抛领域错误，不返回空列表。
 *  - **限速与退避**（缺陷 A3）：翻页走 `Throttle`。
 */
import {
  buildAppMsgPublishUrl,
  buildAskScanStatusUrl,
  buildBizLoginBody,
  buildBizLoginUrl,
  buildGetProfileUrl,
  buildGetQrCodeUrl,
  buildSearchBizUrl,
  buildStartLoginBody,
  buildStartLoginUrl,
  DEFAULT_HEADERS,
  FORM_CONTENT_TYPE,
  RET_AUTH_EXPIRED,
} from './endpoints.js';
import {
  MpTransportError,
  MpUnexpectedShapeError,
  throwIfNotOk,
} from './errors.js';
import {
  extractTokenFromRedirect,
  filterArticles,
  isOk,
  parseAccountList,
  parseAppMsgPublish,
  parseMaybeJson,
  parseProfile,
  parseScanStatus,
  readEnvelope,
} from './parse.js';
import { Throttle, withRateLimitRetry, type ThrottleConfig } from './throttle.js';
import {
  invalidateSession,
  isSessionUsable,
  makeSession,
  type AuthorizeResult,
  type ListQuery,
  type ListResult,
  type MpArticle,
  type MpSession,
  type OfficialAccount,
  type ScanStatus,
} from '../definition/types.js';
import { isRateLimited } from './errors.js';
import { WechatMpService } from '../definition/service.js';
import type { AuthorizeOptions, ScanProgress } from '../definition/service.js';
import type { SessionStore } from '../auth/session-store.js';

/** 从"`k=v; k2=v2`"形式的 Cookie 串解析成表。 */
export function parseCookieString(cookie: string): Map<string, string> {
  const jar = new Map<string, string>();
  for (const pair of cookie.split(';')) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    jar.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return jar;
}

export function serializeCookieJar(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 把响应的 `set-cookie` 合并进 jar。 */
export function absorbSetCookie(jar: Map<string, string>, headers: Headers): void {
  const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const raw = typeof getSetCookie === 'function' ? getSetCookie.call(headers) : [];
  for (const line of raw) {
    const first = line.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}

export interface MpLocalProviderOptions {
  sessionStore: SessionStore;
  throttle?: Partial<ThrottleConfig>;
  /** 便于测试注入。 */
  fetchImpl?: typeof fetch;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** 实测出频控码之后由配置注入。 */
  rateLimitCodes?: readonly number[];
  /** 单次请求超时（毫秒）。 */
  requestTimeoutMs?: number;
}

export class MpLocalProvider extends WechatMpService {
  private session: MpSession | undefined;
  private readonly store: SessionStore;
  private readonly throttle: Throttle;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly rateLimitCodes: readonly number[] | undefined;
  private readonly requestTimeoutMs: number;

  constructor(options: MpLocalProviderOptions) {
    super();
    this.store = options.sessionStore;
    this.throttle = new Throttle(options.throttle ?? {}, {
      sleep: options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
    });
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.rateLimitCodes = options.rateLimitCodes;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  }

  override getSession(): MpSession | undefined {
    return this.session;
  }

  /** 从存储里恢复会话（插件启动时调一次）。 */
  async restore(): Promise<MpSession | undefined> {
    const loaded = await this.store.load();
    this.session = isSessionUsable(loaded) ? loaded : undefined;
    return this.session;
  }

  /**
   * 保存新会话 —— **整体替换，绝不原地改字段**（缺陷 A2 的修法）。
   */
  private async saveSession(next: MpSession): Promise<void> {
    this.session = next;
    await this.store.save(next);
  }

  override async clearSession(): Promise<void> {
    this.session = undefined;
    await this.store.clear();
  }

  /** 标记失效：换成 invalid 的新对象，并落盘。 */
  private async markInvalid(reason: string): Promise<void> {
    if (!this.session) return;
    const next = invalidateSession(this.session, reason);
    await this.saveSession(next);
  }

  /**
   * 发一个请求：把会话里的 Cookie 作为**唯一来源**附上，收完响应再合并 set-cookie。
   *
   * 返回解析后的 JSON（不是 JSON 就抛 `MpUnexpectedShapeError`）。
   */
  private async requestJson(
    url: string,
    context: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...DEFAULT_HEADERS,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new MpTransportError(`${context} 网络请求失败：${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      throw new MpTransportError(`${context} 返回 HTTP ${response.status}`);
    }

    // 会话 Cookie 的唯一更新点
    if (!this.session) {
      // 登录流程还没有会话，用一次性 jar 由调用方自行处理（见 requestRaw）
      throw new MpUnexpectedShapeError(`${context}：尚未建立会话`);
    }
    const jar = parseCookieString(this.session.cookie);
    const before = serializeCookieJar(jar);
    absorbSetCookie(jar, response.headers);
    const after = serializeCookieJar(jar);
    if (after !== before) {
      await this.saveSession({ ...this.session, cookie: after });
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MpUnexpectedShapeError(`${context} 的响应不是 JSON（前 120 字符：${text.slice(0, 120)}）`);
    }

    // 统一在这里识别登录失效 —— 单一收口
    const envelope = readEnvelope(json);
    if (envelope.ret === RET_AUTH_EXPIRED) {
      await this.markInvalid(context);
        throwIfNotOk(envelope, { context, ...(this.rateLimitCodes ? { rateLimitCodes: this.rateLimitCodes } : {}) });
    }
    return json;
  }

  /** 受保护的 GET（带限速与频控退避）。 */
  private async guardedGet(url: string, context: string): Promise<unknown> {
    return withRateLimitRetry(this.throttle, () => this.requestJson(url, context), isRateLimited);
  }

  // ------------------------------------------------------------------------- #
  // 登录四步
  // ------------------------------------------------------------------------- #

  /** 打开一个登录会话，并用一个本地 jar 承接 Cookie（此时还没有正式会话）。 */
  private async beginLoginSession(): Promise<Map<string, string>> {
    const url = buildStartLoginUrl();
    const init: RequestInit = {
      method: 'POST',
      body: buildStartLoginBody(this.now(), Math.floor(Math.random() * 900) + 100),
      headers: { 'Content-Type': FORM_CONTENT_TYPE },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: { ...DEFAULT_HEADERS, ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new MpTransportError(`开启登录会话失败：${error instanceof Error ? error.message : String(error)}`);
    }

    const jar = new Map<string, string>();
    absorbSetCookie(jar, response.headers);
    return jar;
  }

  /** 取二维码 PNG 字节。 */
  private async fetchQrCode(jar: Map<string, string>): Promise<Uint8Array> {
    const url = buildGetQrCodeUrl(Math.random());
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { ...DEFAULT_HEADERS, Cookie: serializeCookieJar(jar) },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new MpTransportError(`获取二维码失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new MpTransportError(`获取二维码返回 HTTP ${response.status}`);
    absorbSetCookie(jar, response.headers);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // PNG 魔数校验：拿到的不是图片就早点报错，别让用户对着一个空文件扫
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
      throw new MpUnexpectedShapeError(`二维码响应不是 PNG（${bytes.length} 字节）`);
    }
    return bytes;
  }

  /** 轮询一次扫码状态。 */
  private async askScanStatus(jar: Map<string, string>): Promise<ScanStatus> {
    const url = buildAskScanStatusUrl();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { ...DEFAULT_HEADERS, Cookie: serializeCookieJar(jar) },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new MpTransportError(`查询扫码状态失败：${error instanceof Error ? error.message : String(error)}`);
    }
    absorbSetCookie(jar, response.headers);
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MpUnexpectedShapeError(`扫码状态响应不是 JSON：${text.slice(0, 120)}`);
    }
    return parseScanStatus(json);
  }

  /** 确认登录，拿 token。 */
  private async confirmLogin(jar: Map<string, string>): Promise<{ token: string; cookie: string }> {
    const url = buildBizLoginUrl();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        body: buildBizLoginBody(),
        headers: {
          ...DEFAULT_HEADERS,
          'Content-Type': FORM_CONTENT_TYPE,
          Cookie: serializeCookieJar(jar),
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new MpTransportError(`确认登录失败：${error instanceof Error ? error.message : String(error)}`);
    }
    absorbSetCookie(jar, response.headers);

    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MpUnexpectedShapeError(`确认登录响应不是 JSON：${text.slice(0, 120)}`);
    }

    const envelope = readEnvelope(json);
    throwIfNotOk(envelope, {
      context: '确认登录',
      ...(this.rateLimitCodes ? { rateLimitCodes: this.rateLimitCodes } : {}),
    });

    const record = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
    const token = extractTokenFromRedirect(record['redirect_url']);
    if (!token) {
      throw new MpUnexpectedShapeError('确认登录成功但没能从 redirect_url 里取到 token');
    }
    return { token, cookie: serializeCookieJar(jar) };
  }

  override async authorize(options: AuthorizeOptions = {}): Promise<AuthorizeResult> {
    if (!options.force) {
      const restored = this.session ?? (await this.restore());
      if (isSessionUsable(restored)) {
        return { status: 'already_authorized', credentialSource: this.store.source };
      }
    }

    const jar = await this.beginLoginSession();
    const report = (progress: ScanProgress): void => options.onProgress?.(progress);

    /** 取一张新二维码并通知观察者。 */
    const refreshQr = async (): Promise<void> => {
      const png = await this.fetchQrCode(jar);
      report({ phase: 'waiting', message: '请使用微信扫描二维码', qrPng: png });
    };

    try {
      await refreshQr();

      // 轮询。两处刻意的设计：
      //  1) 不在回调里重入 —— 这里本来就是串行的 `await` 循环，天然不重入（修 A4）
      //  2) 用「二维码过期就重取」而不是重开会话
      const deadline = this.now() + 5 * 60_000;
      for (;;) {
        if (options.signal?.aborted) return { status: 'cancelled', credentialSource: this.store.source };
        if (this.now() > deadline) {
          throw new MpUnexpectedShapeError('等待扫码确认超时（5 分钟）');
        }

        const status = await this.askScanStatus(jar);
        report({ phase: status.phase, message: status.message });

        if (status.phase === 'confirmed') break;
        if (status.phase === 'no-email') {
          throw new MpUnexpectedShapeError('该账号未绑定邮箱，无法完成登录（status=5）');
        }
        if (status.phase === 'expired') {
          await refreshQr();
        }
        if (status.phase === 'error') {
          throw new MpUnexpectedShapeError(`扫码失败：${status.message}`);
        }

        await (options.signal
          ? new Promise<void>((resolve) => setTimeout(resolve, 2000))
          : new Promise<void>((resolve) => setTimeout(resolve, 2000)));
      }

      const { token, cookie } = await this.confirmLogin(jar);
      await this.saveSession(makeSession(token, cookie, formatLocalDateTime(this.now())));

      // 拿昵称（失败不影响授权成功）
      let nickname: string | undefined;
      try {
        const profile = await this.requestJson(buildGetProfileUrl(token), '获取账号信息');
        nickname = parseProfile(profile).nickname || undefined;
      } catch {
        nickname = undefined;
      }

      report({ phase: 'confirmed', message: nickname ? `已登录：${nickname}` : '已登录' });
      return { status: 'authorized', credentialSource: this.store.source, ...(nickname ? { nickname } : {}) };
    } catch (error) {
      // 授权失败不留半成品会话
      if (error instanceof Error && /未绑定邮箱|超时/.test(error.message)) {
        await this.markInvalid(error.message);
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------------- #
  // 业务接口
  // ------------------------------------------------------------------------- #

  /** 取一个可用会话，否则抛登录失效。 */
  private requireSession(context: string): MpSession {
    const session = this.session;
    if (!isSessionUsable(session)) {
      throw new MpUnexpectedShapeError(`${context} 需要先扫码授权（当前没有可用会话）`);
    }
    return session;
  }

  override async searchAccounts(keyword: string, limit = 5): Promise<OfficialAccount[]> {
    const session = this.requireSession('搜索公众号');
    const count = Math.max(1, Math.min(limit, 20));
    const json = await this.guardedGet(
      buildSearchBizUrl(session.token, keyword, 0, count),
      '搜索公众号',
    );
    if (!isOk(json)) {
      throwIfNotOk(readEnvelope(json), {
        context: '搜索公众号',
        ...(this.rateLimitCodes ? { rateLimitCodes: this.rateLimitCodes } : {}),
      });
    }
    return parseAccountList(json).slice(0, limit);
  }

  /** 拉一页文章（不做筛选）。 */
  private async fetchArticlePage(
    session: MpSession,
    query: ListQuery,
    begin: number,
  ): Promise<{ articles: MpArticle[]; totalCount?: number }> {
    const count = query.count ?? 20;
    const json = await this.guardedGet(
      buildAppMsgPublishUrl({
        token: session.token,
        fakeid: query.fakeid,
        begin,
        count,
        ...(query.keyword !== undefined ? { keyword: query.keyword } : {}),
      }),
      '列文章',
    );

    const envelope = readEnvelope(json);
    if (envelope.ret !== 0) {
      throwIfNotOk(envelope, {
        context: '列文章',
        ...(this.rateLimitCodes ? { rateLimitCodes: this.rateLimitCodes } : {}),
      });
    }

    const parsed = parseAppMsgPublish(json);
    return {
      articles: parsed.articles,
      ...(parsed.totalCount === undefined ? {} : { totalCount: parsed.totalCount }),
    };
  }

  override async listArticles(query: ListQuery): Promise<ListResult> {
    const session = this.requireSession('列文章');

    const pageSize = query.count ?? 20;
    const limit = Math.max(1, query.limit ?? 100);
    const sinceBegin = query.begin ?? 0;

    const collected: MpArticle[] = [];
    let begin = sinceBegin;
    let pagesFetched = 0;
    let totalCount: number | undefined;
    let truncated = false;

    // 硬性页数上限：宁可少拿，也不要把账号送进风控
    const maxPages = 200;

    while (pagesFetched < maxPages) {
      const page = await this.fetchArticlePage(session, query, begin);
      pagesFetched += 1;
      if (page.totalCount !== undefined) totalCount = page.totalCount;

      if (page.articles.length === 0) break;

      collected.push(...page.articles);
      begin += pageSize;

      // 边拉边筛，够量就停（避免为了 limit=20 把整号拉一遍）
      if (filterArticles(collected, query).length >= limit) {
        truncated = true;
        break;
      }
      // 服务端已经给完了
      if (totalCount !== undefined && begin >= totalCount) break;
    }

    const filtered = filterArticles(collected, query);
    return {
      articles: filtered.slice(0, limit),
      ...(totalCount === undefined ? {} : { totalCount }),
      truncated: truncated || filtered.length > limit,
      pagesFetched,
    };
  }
}

/** `YYYY-MM-DD HH:mm:ss`（本地时区）。 */
export function formatLocalDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export { parseMaybeJson };
