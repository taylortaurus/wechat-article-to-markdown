/**
 * 服务定义（Service Definition）：抽象接口 + 领域类型。
 *
 * 为什么它是一个抽象类而不是 cordis `Service`：我们目前**只有一个提供方**（纯 HTTP），
 * dsh 官方文档明确说了"不要预防性拆分"。所以这里只留一个**类型层面的接缝** ——
 * 将来真要做第二套提供方（比如有头浏览器），把它提升成注册到 `ctx` 上的 cordis
 * Service 即可，消费方（工具层）几乎不用改。
 */
import type {
  AuthorizeResult,
  ListQuery,
  ListResult,
  MpSession,
  OfficialAccount,
} from './types.js';

export type { AuthorizeResult, ListQuery, ListResult, MpSession, OfficialAccount };

/** 扫码进度的观察者，用于把状态推给界面。 */
export interface ScanProgress {
  phase: string;
  message: string;
  /** 当前二维码图片（PNG 字节）。刷新后是新的一张。 */
  qrPng?: Uint8Array;
}

export interface AuthorizeOptions {
  /** 忽略已保存凭据，强制重新扫码。 */
  force?: boolean;
  /** 进度回调。二维码交付通道用它把图片送出去。 */
  onProgress?: (progress: ScanProgress) => void;
  /** 取消整个授权。 */
  signal?: AbortSignal;
}

/**
 * 微信后台能力的抽象接口。
 *
 * 这里刻意**不包含**"抓正文" —— 那是 spider-claw 的职责，不是本插件的。
 * 本插件只贡献宿主没有的那部分：公众号后台的私有 API。
 */
export abstract class WechatMpService {
  /** 当前会话（不可变）。没有已授权会话时是 undefined。 */
  abstract getSession(): MpSession | undefined;

  /** 扫码授权（走完整四步状态机）。 */
  abstract authorize(options?: AuthorizeOptions): Promise<AuthorizeResult>;

  /** 搜索公众号。 */
  abstract searchAccounts(keyword: string, limit?: number): Promise<OfficialAccount[]>;

  /** 列文章（自动翻页、限速、本地筛选）。 */
  abstract listArticles(query: ListQuery): Promise<ListResult>;

  /** 主动丢弃当前会话（用户退出登录时用）。 */
  abstract clearSession(): Promise<void>;

  /** 这个实例目前是否持有一个可用会话。 */
  hasUsableSession(): boolean {
    const session = this.getSession();
    return session !== undefined && !session.invalid && session.token.length > 0;
  }
}
