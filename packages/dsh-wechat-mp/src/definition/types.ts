/**
 * 领域类型。
 *
 * 字段集来自参考实现的 `ArticleInfo.cs` / `OfficialAccountInfo.cs`（逐行读过），
 * 命名改成 TS 习惯的 camelCase。这不是"照抄 C# 的类型"，而是把那份逆向出来的
 * **字段契约**用本生态的表达方式重新声明一遍。
 */

/** 公众号（对应 C# 的 `OfficialAccountInfo`）。 */
export interface OfficialAccount {
  /** 公众号唯一标识，后续列文章要用它。 */
  fakeid: string;
  nickname: string;
  alias: string;
  /** 圆形头像地址。 */
  avatarUrl: string;
  /** 公众号简介。 */
  signature: string;
  /** 0=订阅号，1=服务号，2=企业号。 */
  serviceType: number;
}

/** 文章类型（`item_show_type`）的语义。 */
export type ItemShowType = 'article' | 'image' | 'video' | 'other';

export function classifyItemShowType(value: number | undefined): ItemShowType {
  switch (value) {
    case 10:
      return 'article';
    case 66:
      return 'image';
    case 62:
      return 'video';
    default:
      return 'other';
  }
}

/** 一篇文章的元数据（列表里拿到的就是这些，**不含正文**）。 */
export interface MpArticle {
  /** 后台的文章 id。比 URL 更稳定的去重键。 */
  aid: string;
  /** 图文消息 id（一次群发可能含多篇）。 */
  appmsgid: number;
  title: string;
  /** 永久链接，形如 `https://mp.weixin.qq.com/s/xxxx`。 */
  link: string;
  authorName: string;
  /** `YYYY-MM-DD HH:mm:ss`（UTC+8）。取不到就是空串。 */
  publishTime: string;
  createTimeUnix: number;
  updateTimeUnix: number;
  publishTimeUnix: number;
  digest: string;
  cover: string;
  picCdnUrl2351: string;
  picCdnUrl169: string;
  /** 1 表示原创。 */
  copyrightStat: number;
  copyrightType: number;
  isOriginal: boolean;
  itemShowType: ItemShowType;
  /** 原文里的数值，保留以便排查。 */
  rawItemShowType: number;
  /** 是否付费订阅 —— **必须在清单里就带出来**，否则抓取侧无从设防。 */
  isPaySubscribe: boolean;
  isDeleted: boolean;
  albumNames: string[];
}

/** 列文章的查询条件（对应 C# 的 `ArticleQueryOptions`，6 个维度）。 */
export interface ListQuery {
  fakeid: string;
  /** 服务端关键词检索（`sub=search&search_field=7`）。 */
  keyword?: string;
  /** 起始页偏移，用于手动翻页。 */
  begin?: number;
  /** 每页条数。 */
  count?: number;
  /** 发布时间下界（含），`YYYY-MM-DD`。本地过滤。 */
  since?: string;
  /** 发布时间上界（含），`YYYY-MM-DD`。本地过滤。 */
  until?: string;
  /** 只要原创。 */
  originalOnly?: boolean;
  /** 按合集名筛选。 */
  albumName?: string;
  /** 是否包含已删除的文章，默认 false。 */
  includeDeleted?: boolean;
  /** 最多返回多少条（防止一次拉太多）。 */
  limit?: number;
}

/** 概览统计。 */
export interface ListResult {
  articles: MpArticle[];
  /** 服务端报告的总数（如果有）。 */
  totalCount?: number;
  /** 是否因为 `limit` 被截断。 */
  truncated: boolean;
  /** 实际请求了多少页。 */
  pagesFetched: number;
}

/** 扫码轮询状态。语义已按 `FrmLogin.cs:118-163` 的完整分支表校正。 */
export type ScanPhase =
  | 'waiting' // 0
  | 'scanned' // 4 / 6
  | 'confirmed' // 1
  | 'expired' // 2 / 3
  | 'no-email' // 5：账号未绑定邮箱，要终止
  | 'error';

export interface ScanStatus {
  phase: ScanPhase;
  /** 原始状态码，便于排查。 */
  raw: number;
  /** `acct_size`：4/6 时用来区分「请在手机上确认」与「没有可用账号」。 */
  acctSize: number;
  /** 面向用户的中文提示。 */
  message: string;
  errMsg?: string;
}

/**
 * 会话（不可变）。
 *
 * 参考实现的缺陷 A2 是「可变单例会话」：`_token`/`_cookie` 是实例字段，且在业务方法里
 * 被直接置空。我们改成**不可变对象 + 整体替换**：失效不是把字段清空，而是换成一个
 * 标记为无效的新对象。这样已经发出的请求不会被中途改写。
 */
export interface MpSession {
  readonly token: string;
  /** 后台会话 Cookie（单一来源，不另存第二份字符串）。 */
  readonly cookie: string;
  /** 保存时间，`YYYY-MM-DD HH:mm:ss`。 */
  readonly savedAt: string;
  /** 是否已被判定失效（收到 200003 时置位）。 */
  readonly invalid: boolean;
}

/** 生成一个有效会话。 */
export function makeSession(token: string, cookie: string, savedAt: string): MpSession {
  return { token, cookie, savedAt, invalid: false };
}

/**
 * 标记会话失效 —— **返回新对象，不改原对象**。
 * 这是 A2 的回归测试所保护的行为。
 */
export function invalidateSession(session: MpSession, _reason: string): MpSession {
  return { ...session, invalid: true };
}

/**
 * 会话是否可以直接用。
 *
 * 注意这里刻意**不**用本地时钟判断过期 —— 参考实现的缺陷 A5/A6 就是拿一个硬编码的
 * 7 天在本地判过期。有效性只由这两件事决定：
 *  1. 字段完整（缺字段一律视为未配置）；
 *  2. 还没被服务端的 `200003` 打回。
 */
export function isSessionUsable(session: MpSession | undefined): session is MpSession {
  if (!session) return false;
  if (session.invalid) return false;
  if (typeof session.token !== 'string' || session.token.length === 0) return false;
  if (typeof session.cookie !== 'string') return false;
  if (typeof session.savedAt !== 'string' || session.savedAt.length === 0) return false;
  return true;
}

/** 扫码授权的结果。 */
export interface AuthorizeResult {
  status: 'authorized' | 'already_authorized' | 'cancelled';
  nickname?: string;
  /** 凭据来源，便于排查（`credentials` | `file` | `fresh`）。 */
  credentialSource: string;
}

/** 一篇文章抓取完成后的结果（复用 spider-claw 的产物）。 */
export interface FetchResult {
  markdownPath: string;
  title: string;
  author: string;
  publishTime: string;
  imageCount: number;
  /** 防护判定：疑似试读页 / 非图文类。 */
  guard: GuardVerdict;
}

/** 输出防护的判定结果。见 `output/guard.ts`。 */
export interface GuardVerdict {
  /** 疑似付费试读页，正文不完整。 */
  isLikelyPaywall: boolean;
  reason?: string;
}
