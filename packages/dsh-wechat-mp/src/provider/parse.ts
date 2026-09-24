/**
 * 响应解析：**全是纯函数**，不碰 IO，因此可以完全离线单测。
 *
 * 这是整份方案里最该被测试保护的一段。它要处理的坑：
 *
 *  1. `publish_page` 是一个**被转义的 JSON 字符串**，要再 `JSON.parse` 一次；
 *  2. 里面的 `publish_list[].publish_info` **又是一个字符串**，还要再解析一次；
 *  3. `publish_time` 可能为 0，这时要回退到 `update_time`（`ArticleInfo.cs:75`）；
 *  4. 字段随时可能缺 —— 微信对不同账号会返回不同形状，**只做可选处理，不做强解构**。
 *
 * 出处：参考实现 `ArticleService.cs:128-154`（解析链）、`ArticleInfo.cs:14-153`（字段集）。
 */
import { formatTimestamp } from 'spider-claw';

import {
  classifyItemShowType,
  type ItemShowType,
  type ListQuery,
  type MpArticle,
  type OfficialAccount,
  type ScanPhase,
  type ScanStatus,
} from '../definition/types.js';
import { RET_OK, SCAN_STATUS } from './endpoints.js';

// --------------------------------------------------------------------------- #
// 基础读值
// --------------------------------------------------------------------------- #

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 安全地取一个字符串字段；非字符串一律当作空串。 */
function str(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

/** 安全地取一个数字字段；取不到给 0。 */
function num(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** 宽容地判真：`true` / `1` / `"1"` 都算真。 */
function bool(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  if (value === true) return true;
  if (value === 1) return true;
  if (value === '1') return true;
  return false;
}

/**
 * 宽容解析 JSON 字符串。
 *
 * 微信有些字段是**被转义的 JSON 字符串**，但也偶有直接给对象的情形，
 * 所以统一走这个函数：是对象就直接用，是字符串就尝试解析，都不行就返回 undefined。
 */
export function parseMaybeJson(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// --------------------------------------------------------------------------- #
// 统一信封
// --------------------------------------------------------------------------- #

export interface Envelope {
  ret: number;
  errMsg: string;
}

/** 读取公共信封 `{ base_resp: { ret, err_msg } }`（`ApiResponseModels.cs:17-24`）。 */
export function readEnvelope(json: unknown): Envelope {
  const root = isRecord(json) ? json : {};
  const base = isRecord(root['base_resp']) ? root['base_resp'] : {};
  const ret = num(base, 'ret');
  const errMsg = str(base, 'err_msg');
  return { ret, errMsg };
}

/** 是否成功。 */
export function isOk(json: unknown): boolean {
  return readEnvelope(json).ret === RET_OK;
}

// --------------------------------------------------------------------------- #
// 扫码状态
// --------------------------------------------------------------------------- #

/**
 * 解析扫码轮询响应。
 *
 * 分支语义照 `FrmLogin.cs:118-163` 抄全：`0` 待扫；`1` 已确认；`2`/`3` 过期（**同一个分支**）；
 * `4`/`6` 已扫码，且要看 `acct_size` 区分「请在手机上确认」与「没有可用账号」；
 * `5` 账号未绑定邮箱（要终止轮询）。
 */
export function parseScanStatus(json: unknown): ScanStatus {
  const root = isRecord(json) ? json : {};
  /**
   * `status` **缺失**时不能当成 0。
   *
   * 0 的语义是"等待扫描"，而响应里根本没有这个字段意味着形状不对 ——
   * 如果按 0 处理，轮询会一直转下去、既不报错也不刷新二维码，用户看到的就是"卡住"。
   * 这里把它归到 `-1`，走 default 分支变成明确错误。
   */
  const rawStatus = root['status'];
  const raw = rawStatus === undefined || rawStatus === null ? -1 : num(root, 'status');
  const acctSize = num(root, 'acct_size');
  const errMsg = readEnvelope(json).errMsg || undefined;

  let phase: ScanPhase;
  let message: string;

  switch (raw) {
    case SCAN_STATUS.WAITING:
      phase = 'waiting';
      message = '请使用微信扫描二维码';
      break;
    case SCAN_STATUS.CONFIRMED:
      phase = 'confirmed';
      message = '已确认，正在登录';
      break;
    case SCAN_STATUS.EXPIRED_A:
    case SCAN_STATUS.EXPIRED_B:
      phase = 'expired';
      message = '二维码已过期，正在刷新';
      break;
    case SCAN_STATUS.SCANNED_A:
    case SCAN_STATUS.SCANNED_B:
      // 这一支必须看 acct_size —— 初版文档漏掉了这个区分。
      if (acctSize >= 1) {
        phase = 'scanned';
        message = '已扫码，请在手机上确认';
      } else {
        phase = 'error';
        message = '没有可用账号';
      }
      break;
    case SCAN_STATUS.NO_EMAIL:
      phase = 'no-email';
      message = '账号未绑定邮箱';
      break;
    default:
      phase = 'error';
      message = errMsg ? `错误：${errMsg}` : `未知状态码 ${raw}`;
      break;
  }

  return { phase, raw, acctSize, message, ...(errMsg ? { errMsg } : {}) };
}

/** 终态：不需要再轮询。 */
export function isTerminalScanPhase(phase: ScanPhase): boolean {
  return phase === 'confirmed' || phase === 'no-email' || (phase === 'error' && true);
}

// --------------------------------------------------------------------------- #
// 登录
// --------------------------------------------------------------------------- #

/**
 * 从 `redirect_url` 里取 token。出处 `WeChatMpService.cs:257-273`。
 *
 * 这个 URL 可能是相对的（`/cgi-bin/home?token=xxx&lang=zh_CN`），所以给个基地址兜底。
 */
export function extractTokenFromRedirect(redirectUrl: unknown, base = 'https://mp.weixin.qq.com'): string | undefined {
  if (typeof redirectUrl !== 'string' || redirectUrl.length === 0) return undefined;
  try {
    const url = new URL(redirectUrl, base);
    const token = url.searchParams.get('token');
    return token && token.length > 0 ? token : undefined;
  } catch {
    // 退一步：手工切查询串（URL 可能畸形到 new URL 抛错）
    const qIndex = redirectUrl.indexOf('?');
    if (qIndex < 0) return undefined;
    for (const pair of redirectUrl.slice(qIndex + 1).split('&')) {
      const [key, ...rest] = pair.split('=');
      if (key === 'token' && rest.length > 0) {
        const value = rest.join('=');
        return value.length > 0 ? decodeURIComponent(value) : undefined;
      }
    }
    return undefined;
  }
}

/** 取账号信息。出处 `WeChatMpService.cs:290-330`（字段 `nick_name` / `head_img`）。 */
export function parseProfile(json: unknown): { nickname: string; avatarUrl: string } {
  const root = isRecord(json) ? json : {};
  return { nickname: str(root, 'nick_name'), avatarUrl: str(root, 'head_img') };
}

// --------------------------------------------------------------------------- #
// 搜索公众号
// --------------------------------------------------------------------------- #

/** 解析 `searchbiz` 的返回（`ApiResponseModels.cs:29-36`）。 */
export function parseAccountList(json: unknown): OfficialAccount[] {
  const root = isRecord(json) ? json : {};
  const list = Array.isArray(root['list']) ? root['list'] : [];
  const accounts: OfficialAccount[] = [];

  for (const item of list) {
    if (!isRecord(item)) continue;
    const fakeid = str(item, 'fakeid');
    const nickname = str(item, 'nickname');
    // 没有 fakeid 就没法列文章，直接丢
    if (fakeid.length === 0) continue;
    accounts.push({
      fakeid,
      nickname,
      alias: str(item, 'alias'),
      avatarUrl: str(item, 'round_head_img'),
      signature: str(item, 'signature'),
      serviceType: num(item, 'service_type'),
    });
  }
  return accounts;
}

// --------------------------------------------------------------------------- #
// 列文章：三层嵌套解析
// --------------------------------------------------------------------------- #

/** 解析中间层 `publish_page`，拿到还没映射的文章原始对象。 */
export function unpackPublishPage(publishPage: unknown): {
  publishCount?: number;
  totalCount?: number;
  raw: Record<string, unknown>[];
} {
  const page = parseMaybeJson(publishPage);
  if (!page) return { raw: [] };

  const list = Array.isArray(page['publish_list']) ? page['publish_list'] : [];
  const raw: Record<string, unknown>[] = [];

  for (const item of list) {
    if (!isRecord(item)) continue;
    // 第三层：publish_info 又是一个 JSON 字符串
    const info = parseMaybeJson(item['publish_info']);
    if (!info) continue;
    const appmsgex = info['appmsgex'];
    if (!Array.isArray(appmsgex)) continue;
    for (const article of appmsgex) {
      if (isRecord(article)) raw.push(article);
    }
  }

  const publishCount = page['publish_count'];
  const totalCount = page['total_count'];
  return {
    ...(typeof publishCount === 'number' ? { publishCount } : {}),
    ...(typeof totalCount === 'number' ? { totalCount } : {}),
    raw,
  };
}

/**
 * 把一个原始文章对象映射成领域对象。
 *
 * 关键容错：
 *  - `publish_time` 为 0 时回退到 `update_time`（`ArticleInfo.cs:75`）
 *  - 所有字段都可能缺，一律给默认值
 *  - `is_pay_subscribe` / `item_show_type` **必须带出来**，抓取侧要据此设防
 */
export function toMpArticle(raw: Record<string, unknown>): MpArticle {
  const createTimeUnix = num(raw, 'create_time');
  const updateTimeUnix = num(raw, 'update_time');
  const publishTimeUnixRaw = num(raw, 'publish_time');
  const publishTimeUnix = publishTimeUnixRaw > 0 ? publishTimeUnixRaw : updateTimeUnix;

  const copyrightStat = num(raw, 'copyright_stat');
  const copyrightType = num(raw, 'copyright_type');
  const rawItemShowType = num(raw, 'item_show_type');

  const albumInfos = Array.isArray(raw['appmsg_album_infos']) ? raw['appmsg_album_infos'] : [];
  const albumNames: string[] = [];
  for (const album of albumInfos) {
    if (!isRecord(album)) continue;
    const title = str(album, 'title');
    if (title.length > 0) albumNames.push(title);
  }

  return {
    aid: str(raw, 'aid'),
    appmsgid: num(raw, 'appmsgid'),
    title: str(raw, 'title'),
    link: str(raw, 'link'),
    authorName: str(raw, 'author_name'),
    publishTime: publishTimeUnix > 0 ? formatTimestamp(publishTimeUnix) : '',
    createTimeUnix,
    updateTimeUnix,
    publishTimeUnix,
    digest: str(raw, 'digest'),
    cover: str(raw, 'cover'),
    picCdnUrl2351: str(raw, 'pic_cdn_url_235_1'),
    picCdnUrl169: str(raw, 'pic_cdn_url_16_9'),
    copyrightStat,
    copyrightType,
    isOriginal: copyrightStat === 1 && copyrightType === 1,
    itemShowType: classifyItemShowType(rawItemShowType),
    rawItemShowType,
    isPaySubscribe: bool(raw, 'is_pay_subscribe'),
    isDeleted: bool(raw, 'is_deleted'),
    albumNames,
  };
}

export interface ParsedAppMsgPublish {
  articles: MpArticle[];
  totalCount?: number;
  publishCount?: number;
}

/** 解析 `appmsgpublish` 的完整响应。 */
export function parseAppMsgPublish(json: unknown): ParsedAppMsgPublish {
  const root = isRecord(json) ? json : {};
  const page = unpackPublishPage(root['publish_page']);
  const articles = page.raw.map(toMpArticle);
  return {
    articles,
    ...(page.totalCount === undefined ? {} : { totalCount: page.totalCount }),
    ...(page.publishCount === undefined ? {} : { publishCount: page.publishCount }),
  };
}

// --------------------------------------------------------------------------- #
// 本地筛选
// --------------------------------------------------------------------------- #

function dayPrefix(value: string): string {
  return value.slice(0, 10);
}

/**
 * 按 `ListQuery` 做**本地**筛选。
 *
 * 注意 `keyword` 是**服务端**检索参数，不在这里处理 —— 这里只处理服务端不支持的那几个维度
 * （时间区间、原创、合集、已删除）。
 */
export function filterArticles(articles: MpArticle[], query: ListQuery): MpArticle[] {
  let result = articles;

  if (!query.includeDeleted) {
    result = result.filter((a) => !a.isDeleted);
  }
  if (query.originalOnly === true) {
    result = result.filter((a) => a.isOriginal);
  }
  if (query.since !== undefined && query.since.length > 0) {
    const since = query.since;
    result = result.filter((a) => a.publishTime.length > 0 && dayPrefix(a.publishTime) >= since);
  }
  if (query.until !== undefined && query.until.length > 0) {
    const until = query.until;
    result = result.filter((a) => a.publishTime.length > 0 && dayPrefix(a.publishTime) <= until);
  }
  if (query.albumName !== undefined && query.albumName.length > 0) {
    const needle = query.albumName.toLowerCase();
    result = result.filter((a) => a.albumNames.some((n) => n.toLowerCase().includes(needle)));
  }

  return result;
}

/** 文章类型的中文标签，用于日志和 render。 */
export const ITEM_SHOW_TYPE_LABEL: Record<ItemShowType, string> = {
  article: '图文',
  image: '图片',
  video: '视频',
  other: '其他',
};
