/**
 * 二维码交付。
 *
 * 主方案：插件自己开一条**同源 HTTP 路由**，把二维码当静态资源提供；
 * 前端卡片只放一个 `<img>`，再轮询状态。这样绕开了"授权交互接口没有图像通道"
 * 的限制，也避开了跨域问题。
 *
 * 降级方案：把 PNG 写到工作区，告诉用户路径自己打开。零前端依赖。
 *
 * 两条路都实现，由 `pickDelivery()` 按宿主能力挑选。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ScanProgress } from '../definition/service.js';

/** 二维码与扫码状态的共享内存态。路由和文件交付都读它。 */
export class QrState {
  private png: Uint8Array | undefined;
  private phase = 'idle';
  private message = '';
  /** 每次二维码刷新自增 —— 前端用它做 cache-busting，避免浏览器继续显示旧图。 */
  private revision = 0;

  update(progress: ScanProgress): void {
    if (progress.qrPng) {
      this.png = progress.qrPng;
      this.revision += 1;
    }
    this.phase = progress.phase;
    this.message = progress.message;
  }

  get image(): { bytes: Uint8Array; revision: number } | undefined {
    return this.png ? { bytes: this.png, revision: this.revision } : undefined;
  }

  get status(): { phase: string; message: string; revision: number } {
    return { phase: this.phase, message: this.message, revision: this.revision };
  }

  reset(): void {
    this.png = undefined;
    this.phase = 'idle';
    this.message = '';
    this.revision = 0;
  }
}

export interface QrDelivery {
  readonly kind: 'http-route' | 'file' | 'none';
  /** 授权开始时调一次。 */
  begin(): void | Promise<void>;
  /** 每次状态变化时调用。 */
  publish(progress: ScanProgress): void | Promise<void>;
  /** 结束/取消时清理。 */
  end(): void | Promise<void>;
}

/** 把最新二维码写到工作区文件。零前端依赖的降级路径。 */
export class FileQrDelivery implements QrDelivery {
  readonly kind = 'file' as const;
  constructor(private readonly targetPath: string) {}

  async begin(): Promise<void> {
    await mkdir(path.dirname(this.targetPath), { recursive: true });
  }

  async publish(progress: ScanProgress): Promise<void> {
    if (!progress.qrPng) return;
    await writeFile(this.targetPath, progress.qrPng);
  }

  end(): void {
    /* 文件留着，用户可能还没来得及扫 */
  }
}

/** 什么都不做（用于"不要二维码交付"的场景，比如只复用已有会话）。 */
export class NoopQrDelivery implements QrDelivery {
  readonly kind = 'none' as const;
  begin(): void {}
  publish(): void {}
  end(): void {}
}

/**
 * 双通道交付：**同时**更新共享状态（供 HTTP 路由读）和写文件。
 *
 * 为什么两条都做：路由依赖宿主 `webServer` 服务，而那个服务是**异步就绪**的
 * （要靠 `ctx.inject(['webServer'], …)` 等它）。如果路由因为任何原因没挂上，
 * 用户至少还有"打开这个图片"这条路 —— 对一个要扫码的流程来说，
 * 没有退路的失败是不可接受的。
 *
 * 写文件的成本很低（PNG 通常几十 KB），所以不做"检测路由是否可用"这种复杂判断。
 */
export class CompositeQrDelivery implements QrDelivery {
  readonly kind = 'http-route' as const;

  constructor(
    private readonly state: QrState,
    private readonly fileTarget: string,
  ) {}

  async begin(): Promise<void> {
    this.state.reset();
    await mkdir(path.dirname(this.fileTarget), { recursive: true });
  }

  async publish(progress: ScanProgress): Promise<void> {
    this.state.update(progress);
    if (progress.qrPng) {
      await writeFile(this.fileTarget, progress.qrPng);
    }
  }

  end(): void {
    this.state.reset();
  }
}

/** 宿主 webServer 的结构化声明（拿不到类型，只声明用到的方法）。 */
export interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }): () => void;
}

/** 极简的响应对象面。 */
interface ResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string | Uint8Array): void;
}

/**
 * 通过宿主的 HTTP 服务提供二维码与状态。
 *
 * 路由约定：
 *   GET /wechat-mp/qr      → 当前二维码 PNG（带 ETag = revision）
 *   GET /wechat-mp/status  → { phase, message, revision }
 *
 * 注意 `?ts=` 之类的查询串由**前端**加，用来绕过浏览器缓存；服务端只需要
 * 正确带上 `Cache-Control: no-store`。
 */
export function registerQrRoutes(webServer: WebServerLike, state: QrState): () => void {
  const disposeQr = webServer.register({
    kind: 'exact',
    path: '/wechat-mp/qr',
    handler: (_req, res) => {
      const out = res as ResponseLike;
      const image = state.image;
      if (!image) {
        out.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        out.end('还没有二维码，请先在会话里发起扫码授权。\n');
        return;
      }
      out.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(image.bytes.byteLength),
        'Cache-Control': 'no-store',
        ETag: `"qr-${image.revision}"`,
      });
      out.end(image.bytes);
    },
  });

  const disposeStatus = webServer.register({
    kind: 'exact',
    path: '/wechat-mp/status',
    handler: (_req, res) => {
      const out = res as ResponseLike;
      const body = JSON.stringify({ ...state.status, ok: true });
      out.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      out.end(body);
    },
  });

  return () => {
    disposeQr();
    disposeStatus();
  };
}

export interface DeliveryChoice {
  delivery: QrDelivery;
  state: QrState;
  /** 路由的释放函数（如果注册了）。 */
  disposeRoutes?: (() => void) | undefined;
  /** 给用户的一句话提示（放到返回消息里）。 */
  hint: string;
}

/**
 * 挑一条可用的交付通道。
 *
 * 优先 HTTP 路由（体验最好），拿不到 `webServer` 就退回文件。
 */
export function pickDelivery(options: {
  webServer?: WebServerLike | undefined;
  fallbackFilePath: string;
}): DeliveryChoice {
  const state = new QrState();

  if (options.webServer) {
    try {
      const disposeRoutes = registerQrRoutes(options.webServer, state);
      return {
        delivery: {
          kind: 'http-route',
          begin: () => state.reset(),
          publish: (progress) => state.update(progress),
          end: () => state.reset(),
        },
        state,
        disposeRoutes,
        hint: '二维码已就绪：在 dsh 界面里打开扫码卡片，或访问 /wechat-mp/qr。',
      };
    } catch {
      // 路由注册失败（比如路径冲突）就降级
    }
  }

  return {
    delivery: new FileQrDelivery(options.fallbackFilePath),
    state,
    hint: `二维码已写到：${options.fallbackFilePath}（用微信扫描该图片）`,
  };
}
