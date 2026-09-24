/**
 * 凭据存储。
 *
 * 按「宿主原生优先」的原则：**优先用 dsh 的 `ctx.credentials`**，只有它不可用时
 * 才退回自己写文件。这个顺序是有理由的 —— 原生实现带了跨进程互斥，
 * 而我们自己的插件将来很可能被多个会话同时用。
 *
 * 两条路都必须修掉参考实现的缺陷 A5：读出来之后**显式校验字段完整性**，
 * 缺字段一律当作"未配置"，而不是让它带着一个看起来有效的假象继续跑。
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isSessionUsable, makeSession, type MpSession } from '../definition/types.js';

export interface SessionStore {
  /** 凭据来源标识，用于排查与展示。 */
  readonly source: string;
  load(): Promise<MpSession | undefined>;
  save(session: MpSession): Promise<void>;
  clear(): Promise<void>;
}

/**
 * dsh 的凭据服务（结构化声明）。
 *
 * 这里不用 `Context` 上的类型，而是就地声明形状：因为在本机开发环境里拿不到
 * `@deepseek-ai/dsh-credentials` 的类型。声明只覆盖用到的四个方法，形状来自
 * `packages/credentials/credentials/src/index.ts` 的 JSDoc。
 */
interface CredentialProviderLike {
  resolve(ref: string): Promise<{ value: string } | undefined>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

/** 我们占用的凭据引用名（POSIX 环境变量风格）。 */
export const SESSION_CREDENTIAL_REF = 'DSH_WECHAT_MP_SESSION';

function serialize(session: MpSession): string {
  return JSON.stringify({
    token: session.token,
    cookie: session.cookie,
    savedAt: session.savedAt,
    invalid: session.invalid,
  });
}

/**
 * 反序列化 + **显式校验**。
 *
 * 这是 A5 的准确版本：`LoginCredential` 用属性初始化器给了 `ExpireTime = Now+7d`，
 * 于是缺字段时反序列化**保留**了那个默认值 —— 结果是老文件被"反向续命"，
 * 而不是像初稿以为的那样永远过期。无论症状朝哪个方向，正确的做法都一样：
 * **字段不全就当没配置过。**
 */
export function deserializeSession(raw: string): MpSession | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;
  const token = record['token'];
  const cookie = record['cookie'];
  const savedAt = record['savedAt'];

  if (typeof token !== 'string' || token.length === 0) return undefined;
  if (typeof cookie !== 'string' || cookie.length === 0) return undefined;
  if (typeof savedAt !== 'string' || savedAt.length === 0) return undefined;

  const session = makeSession(token, cookie, savedAt);
  return record['invalid'] === true ? { ...session, invalid: true } : session;
}

/** 用 dsh 原生凭据服务。 */
export class CredentialsSessionStore implements SessionStore {
  readonly source = 'credentials';

  constructor(private readonly provider: CredentialProviderLike) {}

  async load(): Promise<MpSession | undefined> {
    const resolved = await this.provider.resolve(SESSION_CREDENTIAL_REF);
    if (!resolved || resolved.value.length === 0) return undefined;
    const session = deserializeSession(resolved.value);
    return isSessionUsable(session) ? session : undefined;
  }

  async save(session: MpSession): Promise<void> {
    await this.provider.set(SESSION_CREDENTIAL_REF, serialize(session));
  }

  async clear(): Promise<void> {
    await this.provider.unset(SESSION_CREDENTIAL_REF);
  }
}

/**
 * 自己写文件的降级方案。
 *
 * 文件权限 0600。注意这里**不做任何"过期时间"的推断** —— 有效性只由服务端的
 * `200003` 决定（见 `definition/types.ts` 的 `isSessionUsable`）。
 */
export class FileSessionStore implements SessionStore {
  readonly source = 'file';

  constructor(private readonly sessionPath: string) {}

  async load(): Promise<MpSession | undefined> {
    try {
      const raw = await readFile(this.sessionPath, 'utf8');
      const session = deserializeSession(raw);
      return isSessionUsable(session) ? session : undefined;
    } catch {
      return undefined;
    }
  }

  async save(session: MpSession): Promise<void> {
    await mkdir(path.dirname(this.sessionPath), { recursive: true });
    await writeFile(this.sessionPath, `${serialize(session)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async clear(): Promise<void> {
    await unlink(this.sessionPath).catch(() => {});
  }
}

/**
 * 选一个可用的存储：原生优先，拿不到就退回文件。
 *
 * @param ctxLike 宿主上下文（用结构化读取，避免依赖本地拿不到的类型）
 */
export function pickSessionStore(ctxLike: unknown, sessionPath: string): SessionStore {
  const credentials = readCredentials(ctxLike);
  if (credentials) return new CredentialsSessionStore(credentials);
  return new FileSessionStore(sessionPath);
}

/**
 * 读宿主的凭据服务（可选）。
 *
 * **必须走 `ctx.get('credentials')`**：cordis 的 `Context` 是 Proxy，直接读
 * `ctx.credentials` 在没声明 `inject` 时会**抛错**（`cannot get property
 * "credentials" without inject`）。这个坑实测踩过 —— 而且它被 `apply` 的兜底
 * try/catch 吞掉之后，表现是"插件装上了但一个工具都没有"，非常难查。
 */
function readCredentials(ctxLike: unknown): CredentialProviderLike | undefined {
  if (typeof ctxLike !== 'object' || ctxLike === null) return undefined;
  const get = (ctxLike as { get?: (name: string) => unknown }).get;
  if (typeof get !== 'function') return undefined;

  const candidate = get.call(ctxLike, 'credentials');
  if (typeof candidate !== 'object' || candidate === null) return undefined;

  const provider = candidate as Record<string, unknown>;
  if (
    typeof provider['resolve'] === 'function' &&
    typeof provider['set'] === 'function' &&
    typeof provider['unset'] === 'function'
  ) {
    return candidate as CredentialProviderLike;
  }
  return undefined;
}
