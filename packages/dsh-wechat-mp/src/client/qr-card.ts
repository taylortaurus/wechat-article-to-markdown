/**
 * 扫码卡片：注册到 `tool.call.toolview`，键就是工具名 `wechat_mp_authorize`。
 *
 * 为什么是"卡片主动去拉"而不是"宿主推给卡片"：注册方在**工具还在执行中**时只能拿到
 * 工具名、原始参数、会话工作目录；结果内容要等 `tool/result` 配对之后才有，而且
 * 注册方**不依赖** `presentCall` / `presentResult`。二维码恰恰是"执行中途才有"的数据，
 * 所以只能由卡片自己轮询宿主那条同源路由。
 *
 * 两个必须写对的细节：
 *  1. `<img>` 要带 cache-busting —— 二维码刷新后 URL 不变，浏览器会继续显示旧图；
 *  2. 组件必须是纯的，不做 IO 之外的事；所有状态来自 `useState` + 轮询。
 */
import { createElement as h, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

/** 与宿主侧路由约定一致（见 `src/auth/delivery.ts`）。 */
export const QR_ROUTE = '/wechat-mp/qr';
export const STATUS_ROUTE = '/wechat-mp/status';

/** 轮询间隔。本机回环地址，这个频率的开销可以忽略。 */
const POLL_INTERVAL_MS = 1500;

interface QrStatus {
  phase: string;
  message: string;
  revision: number;
}

/** 把 phase 翻译成给用户看的中文。 */
function phaseLabel(phase: string): string {
  switch (phase) {
    case 'idle':
      return '正在准备二维码…';
    case 'waiting':
      return '请用微信扫描二维码';
    case 'scanned':
      return '已扫码，请在手机上确认';
    case 'confirmed':
      return '已确认，正在登录';
    case 'expired':
      return '二维码已过期，正在刷新';
    case 'no-email':
      return '账号未绑定邮箱，无法登录';
    case 'error':
      return '出错了';
    default:
      return phase;
  }
}

/** 从宿主状态路由拉一次。失败不抛，交给调用方降级。 */
async function fetchStatus(signal: AbortSignal): Promise<QrStatus | undefined> {
  try {
    const response = await fetch(STATUS_ROUTE, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return undefined;
    return (await response.json()) as QrStatus;
  } catch {
    return undefined;
  }
}

const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '8px',
  },
  qrBox: {
    padding: '10px',
    border: '1px solid var(--color-border-tertiary, rgba(0,0,0,.15))',
    borderRadius: '10px',
    background: '#fff',
    lineHeight: '0',
  },
  qr: {
    width: '200px',
    height: '200px',
    display: 'block',
  },
  message: {
    fontSize: '13px',
    lineHeight: '1.6',
  },
  hint: {
    fontSize: '12px',
    opacity: '0.7',
  },
} as const;

/**
 * 卡片组件。
 *
 * props 由 `ui-tool` 的 card model 从 `ToolCallBlock` 派生（参数 / 内容 / 元数据），
 * 这里不需要用上，但保留签名以便将来在 pending 期展示额外信息。
 */
export function QrCard(_props: Record<string, unknown>): ReactElement {
  const [status, setStatus] = useState<QrStatus>({ phase: 'idle', message: '', revision: 0 });
  const [reachable, setReachable] = useState<boolean>(true);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      const next = await fetchStatus(controller.signal);
      if (stopped) return;
      if (next === undefined) {
        setReachable(false);
      } else {
        setReachable(true);
        setStatus((prev) =>
          prev.phase === next.phase && prev.revision === next.revision ? prev : next,
        );
      }
      // 递归 setTimeout 而不是 setInterval：慢请求不会堆积（与宿主侧的轮询写法一致）
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    let timer = setTimeout(() => void tick(), 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  if (!reachable) {
    return h(
      'div',
      { style: styles.wrap },
      h('div', { style: styles.message }, '扫码服务暂时不可用。'),
      h(
        'div',
        { style: styles.hint },
        '可能插件还没注册路由，或者本次授权已经结束。详细内容可以看工具的返回结果。',
      ),
    );
  }

  // revision 参与 URL —— 二维码刷新后强制浏览器重新取图
  const src = `${QR_ROUTE}?v=${status.revision}`;

  return h(
    'div',
    { style: styles.wrap },
    h(
      'div',
      { style: styles.qrBox },
      h('img', { style: styles.qr, src, alt: '微信扫码登录二维码' }),
    ),
    h('div', { style: styles.message }, phaseLabel(status.phase)),
    h('div', { style: styles.hint }, '扫码后请在手机上点确认。这个卡片会自动更新状态。'),
  );
}

export default QrCard;
