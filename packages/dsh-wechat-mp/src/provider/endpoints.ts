/**
 * 所有微信后台端点的**唯一**落点。
 *
 * 这是故意的：微信改版时，需要动的只有这一个文件。业务代码只调 `buildXxxUrl()`
 * 这类函数，不自己拼 URL。
 *
 * 端点、参数名、状态码全部来自参考实现的源码（`WeChatMpService.cs`），逐行核过。
 * 注意：配套那篇文章里写的 `appmsg?action=list_ex` 与这里用的 `appmsgpublish`
 * **不是同一条**端点，返回结构也不同 —— 以源码为准。
 */

export const WECHAT_HOST = 'https://mp.weixin.qq.com';

/** 后台接口的公共请求头。出处：`WeChatMpService.cs:24,36-38`。 */
export const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: `${WECHAT_HOST}/`,
  Origin: WECHAT_HOST,
};

/** 表单请求的 Content-Type。 */
export const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

// --------------------------------------------------------------------------- #
// 返回值里的业务码
// --------------------------------------------------------------------------- #

/**
 * 已知的 `base_resp.ret` 取值。
 *
 * 只有 0 和 200003 是从源码里读到的；**频控码至今没测出来**（评估文档 P0-2），
 * 所以这里不猜，靠 `unknownRateLimitCodes` 留白，由实测后补。
 */
export const RET_OK = 0;
export const RET_AUTH_EXPIRED = 200003;

/** 拼查询串。 */
export function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

/** 拼表单体。 */
export function body(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

// --------------------------------------------------------------------------- #
// 登录四步（出处：WeChatMpService.cs:99-285）
// --------------------------------------------------------------------------- #

/**
 * 第 1 步：开启登录会话。
 *
 * `sessionid` 是「毫秒时间戳 + 3 位随机数」，出处 `WeChatMpService.cs:103`。
 * 它必须由调用方传入，方便测试注入固定值。
 */
export function buildStartLoginUrl(): string {
  return `${WECHAT_HOST}/cgi-bin/bizlogin?${query({ action: 'startlogin' })}`;
}

export function buildStartLoginBody(nowMs: number, randomSeed: number): URLSearchParams {
  return body({
    userlang: 'zh_CN',
    redirect_url: '',
    login_type: '3',
    sessionid: `${nowMs}${String(randomSeed).padStart(3, '0')}`,
    token: '',
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  });
}

/** 第 2 步：取二维码图片（返回 PNG 字节）。 */
export function buildGetQrCodeUrl(random: number): string {
  return `${WECHAT_HOST}/cgi-bin/scanloginqrcode?${query({
    action: 'getqrcode',
    random: String(random),
  })}`;
}

/** 第 3 步：轮询扫码状态。 */
export function buildAskScanStatusUrl(): string {
  return `${WECHAT_HOST}/cgi-bin/scanloginqrcode?${query({
    action: 'ask',
    token: '',
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  })}`;
}

/** 第 4 步：确认登录。响应里带 `redirect_url`，token 藏在它的查询串里。 */
export function buildBizLoginUrl(): string {
  return `${WECHAT_HOST}/cgi-bin/bizlogin?${query({ action: 'login' })}`;
}

export function buildBizLoginBody(): URLSearchParams {
  return body({
    userlang: 'zh_CN',
    redirect_url: '',
    cookie_forbidden: '0',
    cookie_cleaned: '0',
    plugin_used: '0',
    login_type: '3',
    token: '',
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  });
}

// --------------------------------------------------------------------------- #
// 登录后的业务端点
// --------------------------------------------------------------------------- #

/** 取账号信息（昵称、头像）。出处 `WeChatMpService.cs:290-330`。 */
export function buildGetProfileUrl(token: string): string {
  return `${WECHAT_HOST}/cgi-bin/account/getprofile?${query({
    action: 'getprofile',
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
    token,
  })}`;
}

/** 搜索公众号。出处 `WeChatMpService.cs:364-420`。 */
export function buildSearchBizUrl(token: string, keyword: string, begin = 0, count = 5): string {
  return `${WECHAT_HOST}/cgi-bin/searchbiz?${query({
    action: 'search_biz',
    begin: String(begin),
    count: String(count),
    query: keyword,
    token,
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  })}`;
}

export interface AppMsgPublishParams {
  token: string;
  fakeid: string;
  begin: number;
  count: number;
  /** 服务端关键词检索。给了就切到 search 模式。 */
  keyword?: string;
}

/**
 * 列文章（后台的「发表记录」接口）。出处 `WeChatMpService.cs:425-487`。
 *
 * 返回体里的 `publish_page` 是一个**被转义的 JSON 字符串**，还要再解析两层，
 * 见 `parse.ts` 的 `parsePublishPage`。
 */
export function buildAppMsgPublishUrl(params: AppMsgPublishParams): string {
  const searching = typeof params.keyword === 'string' && params.keyword.length > 0;
  return `${WECHAT_HOST}/cgi-bin/appmsgpublish?${query({
    sub: searching ? 'search' : 'list',
    search_field: searching ? '7' : 'null',
    begin: String(params.begin),
    count: String(params.count),
    query: params.keyword ?? '',
    fakeid: params.fakeid,
    type: '101_1',
    free_publish_type: '1',
    sub_action: 'list_ex',
    token: params.token,
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  })}`;
}

// --------------------------------------------------------------------------- #
// 扫码状态码（出处：FrmLogin.cs:118-163 的完整 switch）
// --------------------------------------------------------------------------- #

/**
 * 状态码 → 语义。
 *
 * 评估文档初版只列了 0/1/3/4/6，**漏了 2 和 5**：
 *  - `2` 和 `3` 都是「二维码过期」（源码里是同一个 case 分支）
 *  - `5` 是「账号未绑定邮箱」，要**终止轮询**而不是当成过期
 */
export const SCAN_STATUS = {
  WAITING: 0,
  CONFIRMED: 1,
  EXPIRED_A: 2,
  EXPIRED_B: 3,
  SCANNED_A: 4,
  NO_EMAIL: 5,
  SCANNED_B: 6,
} as const;
