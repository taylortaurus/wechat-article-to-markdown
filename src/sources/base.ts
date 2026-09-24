/**
 * 所有来源的抽象基类：统一接口，新增来源只需实现这几个方法。
 *
 * 与 Python 版的对齐关系：
 * - `normalize` → `normalize`；
 * - `match` → `match`；
 * - `article_id` → `articleId`（JS 习惯用驼峰）；
 * - `fetch(url, output_dir, no_proxy)` → `fetch(url, { outputDir, proxy })`：
 *   把原来的布尔 `no_proxy` 换成显式的 `ProxyConfig`（'direct' | 'env' | 代理 URL），
 *   语义更清晰，也避免「布尔取反」造成的误读。
 */
import type { ProxyConfig } from '../core/http.js';

export interface FetchOptions {
  /** 输出目录，默认 `<cwd>/output`。 */
  outputDir?: string;
  /** 代理配置，默认 'direct'（忽略代理环境变量）。 */
  proxy?: ProxyConfig;
}

export abstract class Source {
  /** 来源标识，用于 `--source` 与 url-list 的 `source` 字段。 */
  abstract readonly name: string;

  /** 清理 URL（默认原样返回，微信等可覆盖）。 */
  normalize(url: string): string {
    return url;
  }

  /** 该来源是否能处理此 URL（用于自动识别）。 */
  abstract match(url: string): boolean;

  /** 文章的规范化去重键（不含来源前缀）。 */
  abstract articleId(url: string): string;

  /** 抓取单篇文章，返回生成的 Markdown 文件路径。 */
  abstract fetch(url: string, options?: FetchOptions): Promise<string>;
}
