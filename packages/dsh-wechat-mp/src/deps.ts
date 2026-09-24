/**
 * 运行时依赖容器：把配置、提供方、以及**解析好的绝对路径**装在一起，
 * 供各工具共享。
 *
 * 关键设计：输出根目录**解析一次就固定下来**，之后所有写入都用它，
 * 避免中途工作目录变化导致文件散到两个地方。用户通过界面改目录时走
 * `setOutputRoot()`，它会把新值记进内存（并在可用时交给 dsh 的设置子系统持久化）。
 */
import { resolveSessionWorkspace } from './output/workspace.js';
import { ConfigStore, configPathFor, type ConfigPatch } from './output/config-store.js';
import { normalizeConfig } from './config.js';
import {
  resolveListPath,
  resolveOutputRoot,
  resolveSessionPath,
  type ResolvedPath,
} from './output/root.js';
import type { Config } from './config.js';
import type { WechatMpService } from './definition/service.js';

export interface RuntimeInit {
  config: Config;
  provider: WechatMpService;
  /** dsh 的工作区目录。宿主没提供时用进程 cwd。 */
  workspaceRoot?: string | undefined;
  cwd?: string;
}

export class Runtime {
  config: Config;
  readonly provider: WechatMpService;
  readonly workspaceRoot: string | undefined;
  readonly cwd: string;

  private outputRootOverride: string | undefined;
  /** 当前会话的工作目录（每次工具执行时刷新）。 */
  private sessionWorkspace: string | undefined;
  private cachedOutputRoot: ResolvedPath;
  private cachedListPath: ResolvedPath;
  sessionPath: string;

  constructor(init: RuntimeInit) {
    this.config = init.config;
    this.provider = init.provider;
    this.workspaceRoot = init.workspaceRoot;
    this.cwd = init.cwd ?? process.cwd();

    this.cachedOutputRoot = this.computeOutputRoot();
    this.cachedListPath = this.computeListPath();
    this.sessionPath = resolveSessionPath({
      cwd: this.cwd,
      ...(this.workspaceRoot === undefined ? {} : { workspaceRoot: this.workspaceRoot }),
    });
    this.configStore = new ConfigStore(configPathFor(this.sessionPath));
  }

  private readonly configStore: ConfigStore;

  /** 读取界面覆盖值（启动时用）。 */
  loadPersistedConfig(): Promise<ConfigPatch> {
    return this.configStore.load();
  }

  /**
   * 在界面上修改配置并持久化。
   *
   * 写盘的是"用户的覆盖值"，应用的是合并结果 —— 两件事都做，
   * 这样重启后依然生效，而且界面上重新打开时能看到当前值。
   */
  async updateConfig(patch: ConfigPatch): Promise<Config> {
    await this.configStore.save(patch);
    this.config = normalizeConfig({ ...this.config, ...patch });
    this.cachedOutputRoot = this.computeOutputRoot();
    this.cachedListPath = this.computeListPath();
    return this.config;
  }

  /** 当前生效的配置（已含界面覆盖值与安全下限）。 */
  getConfig(): Config {
    return this.config;
  }

  /** 拿回控制权用的：应用持久化覆盖值（启动时调）。 */
  applyPersisted(patch: ConfigPatch): void {
    if (Object.keys(patch).length === 0) return;
    this.config = normalizeConfig({ ...this.config, ...patch });
    this.cachedOutputRoot = this.computeOutputRoot();
    this.cachedListPath = this.computeListPath();
  }

  private computeOutputRoot(): ResolvedPath {
    return resolveOutputRoot({
      explicit: this.outputRootOverride,
      configured: this.config.outputRoot,
      sessionWorkspace: this.sessionWorkspace,
      workspaceRoot: this.workspaceRoot,
      cwd: this.cwd,
    });
  }

  private computeListPath(): ResolvedPath {
    return resolveListPath({
      configured: this.config.listPath,
      // 清单跟着会话工作区走，避免"清单在 A、输出在 B"
      workspaceRoot: this.sessionWorkspace ?? this.workspaceRoot,
      cwd: this.cwd,
    });
  }

  /**
   * 采纳当前会话的工作目录。
   *
   * 每次工具执行前调一次（由注册层统一包在 `execute` 外面，不靠每个工具自觉）。
   * 为什么需要：默认只按进程 cwd 会让产物落到 dsh 的启动目录，而不是用户在界面上
   * 选的工作区 —— 实测踩过，用户会以为文件丢了。
   *
   * 只在**用户没有显式指定**输出目录时才生效（显式设置优先级更高）。
   */
  adoptSessionWorkspace(ctx: unknown, agent: unknown): void {
    const resolved = resolveSessionWorkspace(ctx, agent);
    if (resolved === undefined || resolved === this.sessionWorkspace) return;

    this.sessionWorkspace = resolved;
    if (this.outputRootOverride === undefined) {
      this.cachedOutputRoot = this.computeOutputRoot();
    }
    this.cachedListPath = this.computeListPath();
    // 会话目录变了，凭据文件也跟着走
    this.sessionPath = resolveSessionPath({
      cwd: this.cwd,
      ...(this.sessionWorkspace ?? this.workspaceRoot) === undefined
        ? {}
        : { workspaceRoot: this.sessionWorkspace ?? this.workspaceRoot },
    });
  }

  /** 当前的输出根目录（已解析为绝对路径）。 */
  getOutputRoot(): ResolvedPath {
    return this.cachedOutputRoot;
  }

  /** 当前的列表文件路径（已解析为绝对路径）。 */
  getListPath(): ResolvedPath {
    return this.cachedListPath;
  }

  /**
   * 改输出根目录。
   *
   * 界面面板和 `wechat_set_output_root` 工具**共用这一个实现**，
   * 避免两处逻辑不一致。
   */
  setOutputRoot(dir: string | undefined): ResolvedPath {
    this.outputRootOverride = dir !== undefined && dir.trim().length > 0 ? dir.trim() : undefined;
    this.cachedOutputRoot = this.computeOutputRoot();
    return this.cachedOutputRoot;
  }

  /** 抓正文时用的代理策略，透传给 spider-claw。 */
  get proxy(): string {
    return this.config.proxy;
  }
}
