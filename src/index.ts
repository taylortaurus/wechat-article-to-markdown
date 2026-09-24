/**
 * spider-claw 库入口（同时被 `src/cli.ts` 复用）。
 *
 * 分层：
 * - `core/`：来源无关的能力（HTTP/代理、图片下载、Markdown 转换、url-list、日志、文本工具）；
 * - `sources/`：各来源实现（wechat / blog / twitter stub）与注册表；
 * - `cli.ts`：命令行入口。
 */
export {
  HttpClient,
  cleanNoProxy,
  decodeBody,
  resolveDispatcher,
  type DispatcherResolution,
  type ProxyConfig,
  type RawResponse,
  type RequestOptions,
} from './core/http.js';
export {
  IMAGE_CONCURRENCY,
  downloadAllImages,
  inferImageExt,
  resolveImgUrl,
  type DownloadImagesOptions,
} from './core/images.js';
export { logger, setSilent, type Logger } from './core/logger.js';
export {
  CODE_BLOCK_PLACEHOLDER,
  buildMarkdown,
  convertToMarkdown,
  replaceImageUrls,
  type ArticleMeta,
  type CodeBlock,
} from './core/markdown.js';
export {
  collapseWhitespace,
  escapeRegExp,
  toSafeTitle,
  unescapeHtmlEntities,
} from './core/text.js';
export {
  UrlListFormatError,
  UrlListNotFoundError,
  loadUrlList,
  now,
  saveUrlList,
  type UrlListItem,
} from './core/urlList.js';

export {
  BLOG_SITES,
  BlogSource,
  DEFAULT_BLOG_CONFIG,
  discoverFromSitemap,
  extractWithReadability,
  fetchArticle as fetchBlogArticle,
  fetchHtml as fetchBlogHtml,
  looksLikeDate,
  parseDate,
  parseSitemap,
  type BlogSiteConfig,
  type ExtractedArticle,
} from './sources/blog.js';
export { StubSource } from './sources/stub.js';
export { TwitterSource } from './sources/twitter.js';
export {
  WechatSource,
  fetchArticle as fetchWechatArticle,
  extractMetadata,
  extractPublishTime,
  formatTimestamp,
  normalizeWechatUrl,
  processContent,
  type ProcessedContent,
  type WechatMetadata,
} from './sources/wechat.js';
export { BY_NAME, SOURCES, Source, detectSource, type FetchOptions } from './sources/index.js';

export { CliError, buildProgram, execute, run, runList, runSingle, runSitemap } from './cli.js';
export { VERSION } from './version.js';
