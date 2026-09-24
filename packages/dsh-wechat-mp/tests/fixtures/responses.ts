/**
 * 响应样本。
 *
 * **为什么是 `.ts` 而不是 `.json`**：`appmsgpublish` 的响应里有**两层被转义的 JSON
 * 字符串**（`publish_page` 和 `publish_list[].publish_info`）。手写 `.json` 要把它们
 * 双重转义，既难写又容易写错，而写错的样本会让单测永远"通过"。
 * 用 `JSON.stringify` 现场构造，字符串在哪一层一目了然。
 *
 * 这些样本是按参考实现的**字段契约**造的合成数据（契约来自 `ArticleInfo.cs` /
 * `ApiResponseModels.cs`），**不是真实抓取**（真实抓取要先扫码，见 P0-1）。
 * 等 P0-1 跑通拿到真实响应后，把这里的值换成真实值即可，结构不用动。
 */

export interface RawArticleShape {
  aid: string;
  appmsgid: number;
  title: string;
  link: string;
  author_name: string;
  create_time: number;
  update_time: number;
  publish_time: number;
  digest: string;
  cover: string;
  pic_cdn_url_235_1: string;
  pic_cdn_url_16_9: string;
  copyright_stat: number;
  copyright_type: number;
  item_show_type: number;
  is_pay_subscribe: number;
  is_deleted: boolean;
  appmsg_album_infos: { album_id: number; title: string }[];
}

/** 一篇正常的图文（原创）。 */
export const articleOriginal: RawArticleShape = {
  aid: '2247483001',
  appmsgid: 100000001,
  title: '测试文章：原创图文',
  link: 'https://mp.weixin.qq.com/s/TESTAAAA',
  author_name: '测试公众号',
  create_time: 1758000000,
  update_time: 1758000100,
  publish_time: 1758000000,
  digest: '这是摘要一',
  cover: 'https://mmbiz.qpic.cn/cover1',
  pic_cdn_url_235_1: 'https://mmbiz.qpic.cn/c1_235',
  pic_cdn_url_16_9: 'https://mmbiz.qpic.cn/c1_169',
  copyright_stat: 1,
  copyright_type: 1,
  item_show_type: 10,
  is_pay_subscribe: 0,
  is_deleted: false,
  appmsg_album_infos: [{ album_id: 11, title: '合集甲' }],
};

/**
 * 一篇 **`publish_time` 为 0** 的文章 —— 用来验证回退到 `update_time`
 * （参考实现 `ArticleInfo.cs:75` 的行为）。
 */
export const articleNoPublishTime: RawArticleShape = {
  ...articleOriginal,
  aid: '2247483002',
  appmsgid: 100000002,
  title: '测试文章：没有发布时间',
  link: 'https://mp.weixin.qq.com/s/TESTBBBB',
  publish_time: 0,
  copyright_stat: 0,
  copyright_type: 0,
  item_show_type: 62,
  appmsg_album_infos: [],
};

/** 一篇已删除的付费订阅文章。 */
export const articleDeletedPaid: RawArticleShape = {
  ...articleOriginal,
  aid: '2247483003',
  appmsgid: 100000003,
  title: '测试文章：已删除的付费文',
  link: 'https://mp.weixin.qq.com/s/TESTCCCC',
  is_pay_subscribe: 1,
  is_deleted: true,
};

/** 中间层：一次群发里的图文列表。 */
function publishInfoOf(articles: RawArticleShape[]): string {
  return JSON.stringify({ appmsgex: articles });
}

/** 第二层：`publish_page`（字符串化后的样子）。 */
export function buildPublishPage(
  groups: RawArticleShape[][],
  counts: { publishCount: number; totalCount: number } = { publishCount: groups.length, totalCount: groups.length },
): string {
  return JSON.stringify({
    publish_count: counts.publishCount,
    total_count: counts.totalCount,
    publish_list: groups.map((group, index) => ({
      publish_type: 9,
      publish_info: publishInfoOf(group),
      seq: index,
    })),
  });
}

/** 完整响应：`publish_page` 是**被转义的 JSON 字符串**。 */
export function buildAppMsgPublishResponse(
  groups: RawArticleShape[][],
  counts?: { publishCount: number; totalCount: number },
  ret = 0,
  errMsg = 'ok',
): unknown {
  return {
    base_resp: { ret, err_msg: errMsg },
    publish_page: buildPublishPage(groups, counts),
  };
}

/** 一页正常的响应：3 篇文章，分两组群发。 */
export const appmsgpublishOk = buildAppMsgPublishResponse(
  [[articleOriginal], [articleNoPublishTime, articleDeletedPaid]],
  { publishCount: 2, totalCount: 42 },
);

/** 空页（用来验证翻页终止）。 */
export const appmsgpublishEmpty = buildAppMsgPublishResponse([], { publishCount: 0, totalCount: 0 });

/** 中间层 JSON 非法 —— 验证解析器不炸。 */
export const appmsgpublishBadInner: unknown = {
  base_resp: { ret: 0, err_msg: 'ok' },
  publish_page: JSON.stringify({
    publish_count: 1,
    total_count: 1,
    publish_list: [{ publish_type: 9, publish_info: '这不是 JSON{{{' }],
  }),
};

/** 业务错误。 */
export const appmsgpublishAuthExpired: unknown = {
  base_resp: { ret: 200003, err_msg: 'invalid session' },
  publish_page: '',
};

/** 频控（码号是占位的 —— 真实码号要等 P0-2 实测）。 */
export const appmsgpublishRateLimited: unknown = {
  base_resp: { ret: 200013, err_msg: 'freq control' },
  publish_page: '',
};

/** `searchbiz` 的正常返回。 */
export const searchbizOk: unknown = {
  base_resp: { ret: 0, err_msg: 'ok' },
  total: 2,
  list: [
    {
      fakeid: 'MzIxMDAwMDAwMQ==',
      nickname: '测试公众号',
      alias: 'test_mp',
      round_head_img: 'https://mmbiz.qpic.cn/head1',
      signature: '这是一个测试号',
      service_type: 0,
    },
    {
      fakeid: 'MzIxMDAwMDAwMg==',
      nickname: '另一个号',
      alias: '',
      round_head_img: 'https://mmbiz.qpic.cn/head2',
      signature: '第二个',
      service_type: 1,
    },
    // 没有 fakeid 的条目 —— 应当被丢弃
    { nickname: '坏条目', alias: '', round_head_img: '', signature: '', service_type: 0 },
  ],
};

/** 扫码状态：覆盖源码里出现过的全部状态码。 */
export const scanStatuses: { raw: number; acctSize: number; note: string }[] = [
  { raw: 0, acctSize: 0, note: '等待扫描' },
  { raw: 4, acctSize: 1, note: '已扫码，待确认' },
  { raw: 6, acctSize: 1, note: '已扫码，待确认（另一个码）' },
  { raw: 4, acctSize: 0, note: '已扫码但没有可用账号' },
  { raw: 1, acctSize: 1, note: '已确认' },
  { raw: 2, acctSize: 0, note: '过期（初版文档漏了这个）' },
  { raw: 3, acctSize: 0, note: '过期' },
  { raw: 5, acctSize: 0, note: '账号未绑定邮箱（初版文档漏了这个）' },
  { raw: 99, acctSize: 0, note: '未知' },
];

export function scanStatusResponse(raw: number, acctSize: number): unknown {
  return { base_resp: { ret: 0, err_msg: '' }, status: raw, acct_size: acctSize };
}

/** `bizlogin` 成功返回：token 藏在 redirect_url 里。 */
export const bizloginOk: unknown = {
  base_resp: { ret: 0, err_msg: 'ok' },
  redirect_url: '/cgi-bin/home?t=home/index&lang=zh_CN&token=1862390040',
};

/** `getprofile` 返回。 */
export const profileOk: unknown = {
  base_resp: { ret: 0, err_msg: 'ok' },
  nick_name: '测试公众号',
  head_img: 'https://mmbiz.qpic.cn/head1',
};

/** 一段"正常长度"的 Markdown（用来验证防护不误报）。 */
export const markdownHealthy = `# 一篇正常的文章

> 作者: 测试公众号
> 发布时间: 2026-09-21 21:25:00
> 原文链接: https://mp.weixin.qq.com/s/TESTAAAA

---

${'这是正文的第一段，讲了足够的细节。'.repeat(20)}

![图](images/img_001.png)

${'第二段继续展开论述，篇幅看起来很正常。'.repeat(20)}
`;

/** 一段"试读页"式的 Markdown：很短，且带付费墙特征词。 */
export const markdownPaywalled = `# 付费文章

> 作者: 测试公众号
> 发布时间: 2026-09-21 21:25:00
> 原文链接: https://mp.weixin.qq.com/s/TESTCCCC

---

这是试读部分，只有一小段。
购买后可阅读全文。
`;

/** 一段"渲染失败"式的 Markdown：几乎没有正文。 */
export const markdownEmpty = `# 空文章

> 作者: 测试公众号
> 发布时间: 2026-09-21 21:25:00
> 原文链接: https://mp.weixin.qq.com/s/TESTDDDD

---
`;
