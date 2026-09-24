/**
 * 工作台的配置读写路由。
 *
 * 这两条路由是**可视化配置工作台的后端**：界面面板（`settings.section` 里的表单）
 * 通过它们读当前值、保存修改。
 *
 * `GET  /wechat-mp/config` → 当前配置 + 各路径的来源
 * `POST /wechat-mp/config` → 修改（只收白名单字段），落盘并即时生效
 *
 * **关于安全**：宿主对非 index 资产不做鉴权，所以 POST 是暴露在本机回环上的。
 * 两道防线：
 *  1. 只收自定义头 `x-dsh-wechat-mp-client: 1` —— 跨站表单发不了自定义头，
 *     而我们不返回任何 CORS 头，预检必然失败，浏览器会拦掉跨站写；
 *  2. 只落盘到本机工作区，不改 cordis.yml。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Runtime } from '../deps.js';
import { describeOrigin } from '../output/root.js';
import { parseConfigPatch, type ConfigPatch } from '../output/config-store.js';
import { MpWechatError } from '../provider/errors.js';

/** 客户端必须带的头。 */
const CLIENT_HEADER = 'x-dsh-wechat-mp-client';
const MAX_BODY_BYTES = 8 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

/** 读取并解析请求体（限长，防呆）。 */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new MpWechatError(`请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim().length === 0) return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new MpWechatError('请求体必须是 JSON 对象'));
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new MpWechatError('请求体不是合法 JSON'));
      }
    });
    req.on('error', () => reject(new MpWechatError('读取请求体失败')));
  });
}

/**
 * 只挑出白名单内、类型正确的字段。
 *
 * 直接复用 `parseConfigPatch`（单一实现）—— 这里曾经手写了一份 switch，
 * 把 `outputRoot`/`listPath` 这类**字符串字段**静默丢掉了（测试抓到的真 bug）。
 */
function pickEditable(input: Record<string, unknown>): ConfigPatch {
  return parseConfigPatch(JSON.stringify(input));
}

export interface ConfigRoutesOptions {
  runtime: Runtime;
}

/**
 * 注册配置读写路由。
 *
 * 依据宿主类型：`handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>`，
 * 即标准 Node HTTP 语义（可读 body、可自己写响应）。
 */
export function registerConfigRoutes(
  webServer: { register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void },
  options: ConfigRoutesOptions,
): () => void {
  const { runtime } = options;

  const disposeConfig = webServer.register({
    kind: 'exact',
    path: '/wechat-mp/config',
    handler: async (req, res) => {
      if (req.method === 'GET') {
      const config = runtime.getConfig();
      const output = runtime.getOutputRoot();
      const list = runtime.getListPath();
      sendJson(res, 200, {
        ok: true,
        config,
        paths: {
          outputRoot: output.absolute,
          outputOrigin: describeOrigin(output.origin),
          listPath: list.absolute,
          listOrigin: describeOrigin(list.origin),
          sessionPath: runtime.sessionPath,
        },
      });
      return;
    }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '请用 POST' });
        return;
      }
      // 防跨站写：浏览器跨站发不了自定义头，而我们不发 CORS 头，预检必失败
      if (req.headers[CLIENT_HEADER] !== '1') {
        sendJson(res, 403, { ok: false, error: '缺少客户端标识头' });
        return;
      }

      try {
        const body = await readJsonBody(req);
        const patch = pickEditable(body);
        if (Object.keys(patch).length === 0) {
          sendJson(res, 400, { ok: false, error: '没有可识别的字段（或类型不对）' });
          return;
        }
        const config = await runtime.updateConfig(patch);
        const output = runtime.getOutputRoot();
        const list = runtime.getListPath();
        sendJson(res, 200, {
          ok: true,
          config,
          paths: {
            outputRoot: output.absolute,
            outputOrigin: describeOrigin(output.origin),
            listPath: list.absolute,
            listOrigin: describeOrigin(list.origin),
            sessionPath: runtime.sessionPath,
          },
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  return () => {
    disposeConfig();
  };
}
