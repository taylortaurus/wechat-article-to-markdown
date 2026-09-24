/**
 * 宿主提供模块的**环境声明（开发期 shim）**。
 *
 * 为什么需要它：`@deepseek-ai/*` 这些包在**运行时由 dsh 宿主提供**（本包已把它们
 * 声明为 `peerDependencies`），但当前开发环境里拿不到它们的类型声明（既没发布到
 * 可访问的 registry，本机也没有可安装的副本）。没有这份声明，`tsc` 会因为找不到
 * 模块而报错。
 *
 * 这份声明**故意只覆盖本插件实际用到的部分**，不是对 dsh 全套 API 的复刻。
 * 每一条的形状都是从 dsh 官方文档或官方源码里核过的，出处写在各自注释里。
 *
 * 一旦这些包可以正常安装（或宿主提供了官方类型包），**删掉这个文件、改用真实依赖**
 * 即可，`src/` 下的源码一行都不用改。
 */

declare module '@deepseek-ai/cordis' {
  /** 工具执行上下文里的信号 —— 只承诺取消语义。 */
  export interface ExecSignalLike {
    readonly aborted: boolean;
    addEventListener(type: 'abort', listener: () => void): void;
  }

  /**
   * 执行身份（`defineTool` 的 `execute(args, exec)` 第二个参数）。
   * 依据：`/reference/cookbook/adding-a-tool` 的「execute() 约定的规则」——
   * `callId`/`name`/`arguments`/`agent`/`token`/`signal` 全程不可变。
   */
  export interface ToolExec {
    readonly name: string;
    readonly callId: string;
    readonly signal: AbortSignal;
    readonly agent: AgentLike;
    readonly token: string;
  }

  /** 活跃 agent 的最小面。 */
  export interface AgentLike {
    /** 追加持久化上下文，下一次模型请求会看到它。 */
    inject(payload: { content: string; source: { kind: 'plugin'; plugin: string } }): void;
    /**
     * 会话的绝对工作目录（"validated absolute cwd"）。
     * 依据 `@deepseek-ai/dsh-agent` 的 `lib/types/*.d.ts`。
     * 这是「产物该落到哪」最可靠的一级 —— 实测只靠进程 cwd 会落错地方。
     */
    cwd?: string;
    /** 会话 id。用来向 `workspaceRegistry` 反查工作区。 */
    sessionId?: string;
  }

  /** 后台任务的钩子。依据 `packages/jobs/jobs/src/types.ts` 的 `JobHooks`。 */
  export interface JobHooks {
    /** 请求终止：必须同步、幂等，并最终 settle `done`。 */
    cancel(reason?: string): void;
    /** 生产方**释放资源后** resolve，不得 reject。 */
    done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>;
    /** 消费自上次调用以来产生的输出（可选）。 */
    readOutput?(): string;
  }

  /** 任务启动声明。依据 `JobStart`：**`run` 无参数、同步返回 `JobHooks`**。 */
  export interface JobStart {
    kind: string;
    label: string;
    owner?: AgentLike;
    run(): JobHooks;
  }

  /** `ctx.tools` 的最小面。 */
  export interface ToolsService {
    register(tool: unknown): unknown;
  }

  /** `ctx.jobs` 的最小面。 */
  export interface JobsService {
    start(decl: JobStart): Promise<{ id: string }>;
    kill(id: string, caller?: AgentLike, reason?: string): 'requested' | 'already-finished';
  }

  /** `ctx.authorization` 的最小面。依据 `credentials/authorization/src/index.ts`。 */
  export interface AuthorizationService {
    registerFlow(flow: unknown): () => void;
    begin(request: {
      key: string;
      method?: string;
      interaction: unknown;
      signal?: AbortSignal;
    }): Promise<{ status: 'authorized' | 'cancelled' }>;
  }

  /** 结构化 index 注入行 / 路由注册。依据 `/reference/subsystems/web-server`。 */
  export interface WebServerService {
    register(route: {
      kind: 'exact' | 'prefix';
      path: string;
      handler: (req: unknown, res: unknown) => void | Promise<void>;
    }): () => void;
  }

  /**
   * 客户端插槽注册表。依据宿主版本（0.1.2-rc.1）里 `dsh-client-ui-tool` 与
   * `dsh-client-ui-skill` 的 `lib/client.js` 实际用法：
   *
   * ```js
   * ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
   *   { name: 'tool.call.toolview', key: '<工具名>', locale: NS }, Row));
   * ```
   *
   * 回调可以是普通箭头函数（返回注册结果的释放函数），也可以是生成器函数 ——
   * 两种官方都有，所以返回类型放宽成 `unknown`。
   */
  export interface SlotsService {
    inject(key: string, install: () => unknown): () => void;
    register(cell: Record<string, unknown>, component: unknown): () => void;
  }

  /**
   * 插件上下文。
   *
   * **注意**：这是有意写窄的。真实 `Context` 上还有很多服务（`sessions`、`agents`、
   * `terminals`、`sandbox`……），本插件用不到就不声明。要用新的服务时在这里补一条，
   * 并注明它的出处。
   */
  export interface Context {
    /**
     * 安全地读一个服务。
     *
     * **这一条是踩出来的**：cordis 的 `Context` 是 Proxy，读一个**没有在 `inject` 里
     * 声明的服务会直接抛错** —— `cannot get property "x" without inject`。
     * 所以"试探性地访问 `ctx.foo` 看看有没有"这种写法会让插件加载直接失败（实测时
     * 把整个 dsh web 都带崩了）。
     *
     * `ctx.get(name)` 才对：没有就返回 `undefined`。
     * 依据：宿主自带插件 `dsh-client-ui-skill/lib/client.js` 里的
     * `const inputTriggers = ctx.get("inputTriggers");`。
     */
    get(name: string): unknown;

    /**
     * 挂一个**带依赖的子插件**：列出的服务就绪后才会调用 `callback`，而且回调里
     * 可以**直接读**那些服务（因为已经注入）。
     *
     * **这是处理"可选依赖"的正确工具** —— 不要用 `ctx.get()` 在 `apply` 里抢时机，
     * 那时异步就绪的服务（比如 `webServer`）通常还是 `undefined`，会静默降级。
     * 实测踩过：二维码路由因此没挂上，对外表现为 404。
     *
     * 依据 cordis `Context.inject` 的实现：
     * `inject(inject, callback) { return this.plugin({ inject, apply: callback, ... }) }`
     */
    inject(inject: string[], callback: (ctx: Context) => void): unknown;

    /** `inject: ['tools']` 声明的服务，可以直接读。 */
    readonly tools: ToolsService;
    /**
     * 客户端半用的插槽注册表。**只有在 `inject: ['slots']` 的客户端上下文里才能读**；
     * Node 半不要去碰它（服务名不同、且没声明会抛）。
     */
    readonly slots?: SlotsService;
    /** 注册副作用；返回释放函数。卸载时自动清理是本框架的核心约定。 */
    effect(effect: () => void | (() => void) | Generator<unknown>): () => void;
    /** 挂载一个子插件。 */
    plugin(plugin: unknown): unknown;
  }

  /** 服务基类：`super(ctx, 'serviceName')` 注册到 context 上。 */
  export abstract class Service {
    protected constructor(ctx: Context, name: string);
  }
}

declare module '@deepseek-ai/dsh-tools' {
  import type { ToolExec } from '@deepseek-ai/cordis';

  /** 参数声明（DSL 形式）。 */
  export interface ParameterSpec {
    type: 'string' | 'number' | 'boolean' | 'integer' | 'array' | 'object';
    required?: boolean;
    description?: string;
    items?: ParameterSpec;
  }

  /** 规范值的 schema（宽松声明，够用即可）。 */
  export type ValueSchema = Record<string, unknown>;

  /** 面向模型的内容块。 */
  export interface ContentBlock {
    type: 'text';
    text: string;
  }

  /** 工具定义。依据 `/develop/basic/tool` 与 `/reference/cookbook/adding-a-tool`。 */
  export interface ToolDefinition<A, V> {
    name: string;
    description: string;
    parameters: Record<string, ParameterSpec>;
    output: {
      schema: ValueSchema;
      render: (args: A, value: V) => ContentBlock[];
      presentationMeta?: (args: A, value: V) => Record<string, unknown>;
    };
    execute: (args: A, exec: ToolExec) => Promise<V>;
  }

  /**
   * 声明一个工具。框架会在 `execute` 前按 `parameters` 校验并推导 `args` 类型，
   * `execute` 只返回符合 `output.schema` 的**规范 JSON 值**。
   */
  export function defineTool<A, V>(definition: ToolDefinition<A, V>): unknown;
}

declare module '@deepseek-ai/schemastery' {
  /**
   * Schemastery 的最小面。
   *
   * 各方法返回 `any` 是有意的：真实的 Schemastery 是**链式泛型**的，用环境声明
   * 精确复刻它没有收益（只会让 shim 变成一份需要维护的仿制品）。这里只需要让
   * `Schema.object({...}).default(...)` 这类写法能通过类型检查。
   */
  interface SchemaFactory {
    string(): any;
    number(): any;
    boolean(): any;
    array(inner: any): any;
    object(shape: Record<string, any>): any;
    union(values: readonly any[]): any;
  }

  const Schema: SchemaFactory;
  export default Schema;
}

/**
 * React 的最小面（**只给浏览器半用**）。
 *
 * 为什么不用真的 `@types/react`：本机环境里没有可安装的副本，而为它硬编码
 * pnpm store 里的版本化路径会让 tsconfig 变得脆弱、换台机器就崩。
 *
 * 这里只声明组件实际用到的那几个 API。运行时 React 由宿主提供 ——
 * 它在平台的**冻结模块表**里（`packages/client/web/src/platform.ts` 的
 * `PLATFORM_MODULES` 第一项就是 `react`），客户端 bundle 通过 `require('react')` 拿到。
 * 等 `@types/react` 可以正常安装时，删掉这一段、改用真实依赖即可。
 */
declare module 'react' {
  export type ReactNode = unknown;
  export interface CSSProperties {
    [key: string]: string | number | undefined;
  }
  export interface ReactElement {
    readonly type: unknown;
    readonly props: Record<string, unknown>;
    readonly key: string | null;
  }
  export function createElement(
    type: unknown,
    props?: (Record<string, unknown> & { key?: string | number; style?: CSSProperties }) | null,
    ...children: unknown[]
  ): ReactElement;
  export function useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  const React: { createElement: typeof createElement };
  export default React;
}

/**
 * 客户端插槽组件拿到的 props。
 *
 * 依据 `/reference/subsystems/slots` 与 `ui-tool` 源码：注册到
 * `tool.call.toolview` 的组件通过**推导出的 props** 接收数据，
 * 绝不会拿到 `ctx`。这里只声明我们要用的那几个。
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** 运行时 props 的宽松声明（真实的 `PropsRuntime<K>` 是按键推导的）。 */
  export type PropsRuntime<K extends string> = Record<string, unknown> & {
    /** 当前所在会话的 id（`session` scope 提供）。 */
    sessionId?: string;
    /** 取共享视图状态的选择器。 */
    useStore?: <S>(selector: (state: unknown) => S) => S;
  };
}
