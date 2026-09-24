/**
 * 浏览器半的插件入口。
 *
 * 契约**逐字对着宿主版本（0.1.2-rc.1）里的真实样例核过** ——
 * 依据 `@deepseek-ai/dsh-client-ui-tool/lib/client.js` 与
 * `@deepseek-ai/dsh-client-ui-skill/lib/client.js` 里能跑的注册代码：
 *
 * ```js
 * const xToolview = {
 *   name: 'x-toolview',
 *   inject: ['slots'],                       // 注意：是服务名，不是包名
 *   apply(ctx) {
 *     ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
 *       { name: 'tool.call.toolview', key: '<工具名>', locale: NS }, Row));
 *   },
 * };
 * exports.apply = apply;
 * exports.inject = inject;
 * ```
 *
 * 要点：
 *  1. 工厂返回值是**插件面** `{ name?, inject: ['slots'], apply }`；
 *  2. `inject` 里写的是**服务名** `'slots'`；
 *  3. `slots.inject` 的回调是**普通箭头函数**（早前我写成生成器函数，虽然也能跑，
 *     但既然官方样例都是箭头函数，就跟它保持一致，少一个变量）；
 *  4. cell 的寻址键是 **`key`**，值就是 wire tool name 的字面量。
 *
 * 这里**不传 `locale`**：官方样例传它是因为要在卡片里做 i18n，我们的卡片文案是
 * 固定中文，没必要为此引入 `ctx.locale` 的依赖。
 */
import type { Context } from '@deepseek-ai/cordis';

import { QrCard } from './qr-card.js';
import { OutputPanel } from './panel.js';
import { WechatMpSettings } from './settings-panel.js';

/** 必须与 Node 侧 `defineTool` 的名字**逐字一致** —— 分发就是按这个名字找 card。 */
export const AUTHORIZE_TOOL = 'wechat_mp_authorize';
export const OUTPUT_INFO_TOOL = 'wechat_output_info';

/** 设置页里我们这个 section 的 id。 */
export const SETTINGS_SECTION_ID = 'wechat-mp';

export const name = 'wechat-mp-client';

/** 服务名，不是包名。 */
export const inject = ['slots'];

export function apply(ctx: Context): void {
  const slots = ctx.slots;
  // 注册表还没就绪时安静退出，不要抛 —— 抛了会让整个客户端半加载失败，
  // 连"只是没有卡片"这种可降级状态都保不住。
  if (!slots) return;

  slots.inject('tool.call.toolview', () =>
    slots.register({ name: 'tool.call.toolview', key: AUTHORIZE_TOOL }, QrCard),
  );

  slots.inject('tool.call.toolview', () =>
    slots.register({ name: 'tool.call.toolview', key: OUTPUT_INFO_TOOL }, OutputPanel),
  );

  // ---- 可视化配置工作台：设置页里的一个 section ----
  // 注册形态照抄宿主自己的样例（dsh-client-ui-agent-preset 的 settings.section）：
  //   { name, id, order, label, inject }
  // label 用返回字面量的函数，避免引入 ctx.locale 依赖。
  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: SETTINGS_SECTION_ID,
        order: 60,
        label: () => '微信抓取',
      },
      WechatMpSettings,
    ),
  );
}

export { QrCard, OutputPanel, WechatMpSettings };
export default { name, inject, apply };
