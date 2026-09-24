/**
 * 双半包的构建配置。
 *
 * 两份产物：
 *  1. **Node 半** → `lib/index.js`（ESM）。宿主相关模块与 `spider-claw` 都是 external，
 *     它们由宿主/依赖树提供。
 *  2. **浏览器半** → `lib/client.js`。形态必须严格是"闭包工厂"：
 *
 *     window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     ……CJS 正文……
 *     return module.exports; } });
 *
 * 这层壳是从官方预设 `packages/client/tsdown.client.ts` 的 `banner`/`footer` 逐字读来的。
 * 官方那个预设本身**没有发布成 npm 包**（官方 cookbook 原话："没有已发布的预设暴露该包，
 * 因此本仓库之外的包得自行复刻同样的输出格式"），所以我们自己复刻。
 *
 * 关键约束：**外部依赖只允许平台冻结的那 9 个说明符**，其余一切必须内联 ——
 * `require()` 一个不在模块表里的包会在运行时直接抛错。
 */
import { defineConfig } from 'tsup';

/** 包名要同时写进 `__ModuleLoader__.load` 的 id 与包内其它地方，保持一致。 */
const PACKAGE_ID = 'dsh-wechat-mp';

/**
 * 平台的**冻结模块表**（`packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES`）。
 *
 * 逐字照抄，**几项就是几项** —— 评估文档初版把这份 9 项清单写成了"10 项"，是数错了。
 * （同文件里的 `PRELOADED_CLIENT_EXTERNALS` 是空数组，不算在内。）
 */
const PLATFORM_MODULES: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

/** Node 半由宿主（或依赖树）提供的模块。 */
const HOST_MODULES: readonly string[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-jobs',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-authorization',
  '@deepseek-ai/schemastery',
];

/** 闭包工厂的头（对应官方预设的 `banner` + `intro`）。 */
const CLIENT_BANNER =
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, ` +
  'factory: (require) => {\n' +
  'var module = { exports: {} }; var exports = module.exports;';

/** 闭包工厂的尾（对应官方预设的 `footer`）。 */
const CLIENT_FOOTER = 'return module.exports; } });';

export default defineConfig([
  // ------------------------------------------------------------------------- #
  // Node 半
  // ------------------------------------------------------------------------- #
  {
    name: `${PACKAGE_ID}/node`,
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: 'lib',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...HOST_MODULES, 'spider-claw'],
    // 不打包，只转译 —— 依赖都靠 external 解析，避免把宿主的东西复制进来
    skipNodeModulesBundle: true,
  },

  // ------------------------------------------------------------------------- #
  // 浏览器半
  // ------------------------------------------------------------------------- #
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    outDir: 'lib',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...PLATFORM_MODULES],
    banner: { js: CLIENT_BANNER },
    footer: { js: CLIENT_FOOTER },
    // cjs 默认会输出 .cjs，这里固定成 client.js（与 package.json 的 exports 一致）
    outExtension: () => ({ js: '.js' }),
    // 保证入口文件名就是 client.js，不额外加哈希/后缀
    splitting: false,
  },
]);
