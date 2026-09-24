/** 来源（source）注册表：已实现的与占位 stub 都在此登记。 */
import { Source } from './base.js';
import { BlogSource } from './blog.js';
import { TwitterSource } from './twitter.js';
import { WechatSource } from './wechat.js';

export { Source, type FetchOptions } from './base.js';
export { StubSource } from './stub.js';
export { TwitterSource } from './twitter.js';
export { WechatSource, fetchArticle as fetchWechatArticle } from './wechat.js';
export { BlogSource, fetchArticle as fetchBlogArticle } from './blog.js';

/** 所有来源（顺序即自动识别的优先级）。 */
export const SOURCES: readonly Source[] = [
  new WechatSource(),
  new TwitterSource(),
  new BlogSource(),
];

/** 来源标识 → 来源实例。 */
export const BY_NAME: ReadonlyMap<string, Source> = new Map(
  SOURCES.map((source) => [source.name, source]),
);

/** 按 URL 域名自动识别来源，未命中返回 `undefined`。 */
export function detectSource(url: string): Source | undefined {
  return SOURCES.find((source) => source.match(url));
}
