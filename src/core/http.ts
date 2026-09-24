/**
 * HTTP 客户端：统一代理配置、字符集解码与超时。
 *
 * 代理语义（与 Python 版保持一致，但实现更简）：
 * - `direct`（默认）：**不读任何代理环境变量**。Node 的 fetch/undici 默认就不解析
 *   `HTTP_PROXY` 等变量，因此「直连」天然干净，不存在 Python httpx 那种
 *   "构造 Client 时就因畸形 NO_PROXY（如 ::1/128）抛 InvalidURL" 的问题；
 * - `env`：使用 undici 的 `EnvHttpProxyAgent` 读取 `HTTP(S)_PROXY` / `NO_PROXY`；
 *   构造前先净化 `NO_PROXY`（IPv6 CIDR → 去掉掩码），仍失败则告警并降级为直连；
 * - 其它字符串：视为显式代理 URL。
 */
import {
  EnvHttpProxyAgent,
  ProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
} from 'undici';

import { logger } from './logger.js';

/** 代理配置：直连 / 读取环境变量 / 显式代理 URL。 */
export type ProxyConfig = 'direct' | 'env' | (string & {});

const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'] as const;
/** IPv6 CIDR（如 ::1/128）——部分 HTTP 客户端无法解析带掩码的 IPv6。 */
const IPV6_CIDR_RE = /^([0-9A-Fa-f:]*:[0-9A-Fa-f:]+)\/\d+$/;

/**
 * 净化 NO_PROXY：`::1/128` → `::1`。
 *
 * 其它条目（IPv4 CIDR、域名、通配符 `*`、`*.local` 等）原样保留。
 */
export function cleanNoProxy(value: string): string {
  const parts: string[] = [];
  for (const raw of (value ?? '').split(',')) {
    const host = raw.trim();
    if (!host) continue;
    const matched = IPV6_CIDR_RE.exec(host);
    parts.push(matched?.[1] ?? host);
  }
  return parts.join(',');
}

/** 在「净化后的 NO_PROXY」环境下同步执行构造逻辑，退出时还原环境变量。 */
function withCleanedNoProxy<T>(fn: () => T): T {
  const saved = NO_PROXY_KEYS.map((key) => [key, process.env[key]] as const);
  for (const [key, value] of saved) {
    if (value) {
      const cleaned = cleanNoProxy(value);
      if (cleaned !== value) process.env[key] = cleaned;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export interface DispatcherResolution {
  /** `undefined` 表示使用 undici 默认 dispatcher（即直连）。 */
  dispatcher: Dispatcher | undefined;
  /** 是否因为代理配置不可用而回退到直连。 */
  degraded: boolean;
  reason?: string;
}

/** 根据代理配置构造 dispatcher；任何解析失败都降级为直连而不是抛错。 */
export function resolveDispatcher(proxy: ProxyConfig = 'direct'): DispatcherResolution {
  if (proxy === 'direct') return { dispatcher: undefined, degraded: false };
  try {
    if (proxy === 'env') {
      return { dispatcher: withCleanedNoProxy(() => new EnvHttpProxyAgent()), degraded: false };
    }
    return { dispatcher: new ProxyAgent(proxy), degraded: false };
  } catch (e) {
    return { dispatcher: undefined, degraded: true, reason: (e as Error).message };
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** 便捷设置 Referer（部分站点图片 / 文章有防盗链）。 */
  referer?: string;
  timeoutMs?: number;
}

export interface RawResponse {
  bytes: Uint8Array;
  contentType: string | null;
  status: number;
}

/**
 * 按 `Content-Type` → `<meta charset>` → UTF-8 的顺序解码响应体。
 *
 * 说明：undici 的 `Response.text()` 恒定按 UTF-8 解码，会读乱 GBK 等旧编码的
 * 静态博客；这里显式嗅探字符集，行为对齐 Python 版 httpx 的 `r.text`。
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  const sniff = new TextDecoder('utf-8').decode(bytes.subarray(0, 2048));
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1];
  const charset = (fromHeader ?? fromMeta ?? 'utf-8').toLowerCase();
  if (charset === 'utf-8' || charset === 'utf8') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // 未知字符集：退回 UTF-8，绝不因解码细节中断抓取
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** 轻量 HTTP 客户端（基于 undici fetch，自带 redirect / 超时 / 代理）。 */
export class HttpClient {
  readonly proxy: ProxyConfig;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(proxy: ProxyConfig = 'direct') {
    this.proxy = proxy;
    const resolved = resolveDispatcher(proxy);
    this.dispatcher = resolved.dispatcher;
    if (resolved.degraded) {
      logger.warn(`  ⚠ 代理配置无法解析（${resolved.reason}），本次回退为直连`);
    }
  }

  private buildInit(options: RequestOptions): Parameters<typeof undiciFetch>[1] {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.referer) headers['Referer'] = options.referer;
    return {
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    };
  }

  async get(url: string, options: RequestOptions = {}): Promise<RawResponse> {
    const res = await undiciFetch(url, this.buildInit(options));
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type'),
      status: res.status,
    };
  }

  /** 抓取文本（自动按响应头 / meta 嗅探字符集）。 */
  async getText(url: string, options: RequestOptions = {}): Promise<string> {
    const { bytes, contentType } = await this.get(url, options);
    return decodeBody(bytes, contentType);
  }
}
