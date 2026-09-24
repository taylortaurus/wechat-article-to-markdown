/**
 * 输出目录的查询与设置。
 *
 * 这个工具和界面面板**共用 `Runtime.setOutputRoot()` 这一份实现**，
 * 避免"界面里改的和工具改的不一致"。
 *
 * 关于持久化：`cordis.yml` 是用户手写的文件，插件**不该**去改它。所以配置项只提供
 * 默认值；用户在界面/工具里改的值优先交给 dsh 的设置子系统保存（原生优先），
 * 拿不到设置服务时只活在本次运行的内存里，并在返回值里如实说明。
 */


import { describeOrigin } from '../output/root.js';
import { defineTool } from './schema.js';
import type { Runtime } from '../deps.js';

/** 设置子系统的结构化声明（拿不到类型，只声明用到的方法）。 */
interface SettingsScopeLike {
  update?(values: Record<string, unknown>): void | Promise<void>;
}

export interface OutputConfigDeps {
  runtime: Runtime;
  /**
   * 懒解析设置作用域：**在工具执行时**才去读服务。
   *
   * 不能在 `apply` 时读 —— 那时服务可能还没就绪（会拿到 undefined，静默丢掉持久化能力）。
   * 也不能在 `apply` 里用 `ctx.get()` 抢；这正是实测踩过的坑。
   */
  resolveSettingsScope?: (() => SettingsScopeLike | undefined) | undefined;
}

export function registerOutputConfigTools(
  ctx: { tools: { register(tool: unknown): unknown } },
  deps: OutputConfigDeps,
): void {
  const { runtime } = deps;

  ctx.tools.register(
    defineTool<{ dir: string }, { outputRoot: string; origin: string; persisted: boolean; note: string; error?: string }>({
      name: 'wechat_set_output_root',
      description:
        '设置下载产物写到哪个目录。传空字符串表示恢复默认（当前工作区下的 output/）。' +
        '该设置对三个入口（单篇、列表、账号枚举）都生效。',
      parameters: {
        dir: { type: 'string', required: true, description: '绝对路径或相对工作区的路径；空串表示恢复默认' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            outputRoot: { type: 'string' },
            origin: { type: 'string' },
            persisted: { type: 'boolean' },
            note: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.error) return [{ type: 'text', text: value.error }];
          return [
            {
              type: 'text',
              text: [
                `输出根目录已设为：${value.outputRoot}`,
                `（${value.origin}）`,
                value.persisted ? '已交给宿主设置子系统保存。' : value.note,
              ].join('\n'),
            },
          ];
        },
      },
      async execute(args) {
        const resolved = runtime.setOutputRoot(args.dir);

        let persisted = false;
        let note = '未能持久化：本次运行期间有效，重启后回到配置里的默认值。';
        const scope = deps.resolveSettingsScope?.();
        if (scope && typeof scope.update === 'function') {
          try {
            await scope.update({ outputRoot: args.dir });
            persisted = true;
            note = '已交给宿主设置子系统保存。';
          } catch {
            /* 落回内存态 */
          }
        }

        return {
          outputRoot: resolved.absolute,
          origin: describeOrigin(resolved.origin),
          persisted,
          note,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool<
      Record<string, never>,
      {
        outputRoot: string;
        outputOrigin: string;
        listPath: string;
        listOrigin: string;
        sessionPath: string;
        layout: string;
        pageDelayMs: number;
        configuredOutputRoot: string;
        usingFallback: boolean;
      }
    >({
      name: 'wechat_output_info',
      description: '查看当前的输出目录、清单路径、落盘布局与限速配置。排查"文件写到哪去了"时先看这个。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: {
            outputRoot: { type: 'string' },
            outputOrigin: { type: 'string' },
            listPath: { type: 'string' },
            listOrigin: { type: 'string' },
            sessionPath: { type: 'string' },
            layout: { type: 'string' },
            pageDelayMs: { type: 'number' },
            configuredOutputRoot: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const lines = [
            `输出根目录：${value.outputRoot}`,
            `  （来源：${value.outputOrigin}）`,
            `清单文件：${value.listPath}`,
            `  （来源：${value.listOrigin}）`,
            `凭据文件：${value.sessionPath}`,
            `落盘布局：${value.layout}`,
            `翻页间隔：${value.pageDelayMs} 毫秒`,
            `配置里的 outputRoot：${value.configuredOutputRoot || '(空，用默认)'}`,
          ];
          if (value.usingFallback) {
            lines.push(
              '',
              '⚠️ 注意：当前用的是 **dsh 进程的启动目录**，一般不是你项目的目录。',
              `想改到项目里就直接说，例如「把输出目录设成 <你的项目路径>/output」，` +
                '我会调 wechat_set_output_root；也可以改插件配置里的 outputRoot 做长期默认。',
            );
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute() {
        const output = runtime.getOutputRoot();
        const list = runtime.getListPath();
        return {
          outputRoot: output.absolute,
          outputOrigin: describeOrigin(output.origin),
          listPath: list.absolute,
          listOrigin: describeOrigin(list.origin),
          sessionPath: runtime.sessionPath,
          layout: runtime.config.layout,
          pageDelayMs: runtime.config.pageDelayMs,
          configuredOutputRoot: runtime.config.outputRoot,
          // `cwd` 意味着"用的是 dsh 进程的启动目录"，通常不是用户想要的项目目录。
          // 把它标出来，好让**任何**模型都能顺口提醒用户去改。
          usingFallback: output.origin === 'cwd',
        };
      },
    }),
  );
}
