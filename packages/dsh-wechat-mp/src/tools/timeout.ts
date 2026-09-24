/**
 * 超时保护。
 *
 * **为什么必须有**：实测踩过一次很尴尬的情况 —— 浏览器进程被环境杀掉之后，
 * spider-claw 的 `fetchWechatArticle` 会一直等 `#js_content`，**永远不返回**。
 * 于是工具调用永远不结束，界面卡在「深度求索中…」，用户**连取消都点不动**。
 *
 * `spider-claw` 的 `FetchOptions` 目前只接受 `outputDir` / `proxy`，**没有 signal**，
 * 所以没法真正中止底层浏览器。能做的是：**保证调用方一定拿得回控制权**，
 * 并给出可操作的错误信息（而不是静默挂死）。
 *
 * 这属于"宁可报错，也不要让用户对着转圈等"的取舍。
 */
import { MpTransportError } from '../provider/errors.js';

export interface TimeoutOptions {
  /** 超时毫秒数。 */
  timeoutMs: number;
  /** 调用方的取消信号（`exec.signal`）。 */
  signal?: AbortSignal | undefined;
  /** 超时时抛出的错误信息。 */
  onTimeoutMessage: string;
}

/**
 * 给一个 Promise 加超时与取消。
 *
 * 注意：**超时不会真正终止底层工作**（底层没有 signal 接口）。它的作用是
 * 让调用方立刻拿到结果并把话说清楚。底层那个浏览器进程会在它自己的生命周期里结束，
 * 如果发现残留可以用 `pkill -f camoufox` 清理。
 */
export async function withTimeout<T>(
  work: Promise<T>,
  options: TimeoutOptions,
): Promise<T> {
  const { timeoutMs, signal, onTimeoutMessage } = options;

  if (signal?.aborted === true) {
    throw new MpTransportError('操作已被取消。');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new MpTransportError(onTimeoutMessage));
    }, timeoutMs);
    // 不要因为这一个定时器把事件循环钉住
    timer.unref?.();

    if (signal) {
      onAbort = () => reject(new MpTransportError('操作已被取消。'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 超时/失败时给用户的可操作建议。
 *
 * 从实测出发：最常见的原因是**浏览器起不来**（受限的执行环境会杀掉它派生的浏览器进程），
 * 表现就是"卡住不动、没有任何报错"。所以直接把诊断命令写进消息里。
 */
export function describeFetchFailure(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  return [
    base,
    '',
    '常见原因与自查：',
    '1) 浏览器无法启动或被环境杀掉 —— 表现是卡住不动且无报错。',
    '   在本机终端跑一次诊断（它会明确告诉你浏览器能不能用）：',
    '   ./node_modules/.bin/tsx scripts/probe/l2-camoufox-host.ts',
    '2) 页面结构变了或需要登录 —— 换一篇文章试试，看是不是单篇的问题。',
    '3) 网络/代理问题 —— 试试把插件配置里的 proxy 改成 "env" 或直连。',
  ].join('\n');
}
