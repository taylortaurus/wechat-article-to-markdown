/**
 * 限速：修复参考实现的缺陷 A3（翻页只等 100 毫秒、无退避、不识别频控）。
 *
 * 设计要点：
 *  - **时钟与 sleep 可注入**，所以退避序列能在单测里用假时钟精确验证；
 *  - 每次请求前调 `acquire()`，它会按当前退避档位等待；
 *  - 收到频控时调 `penalize()` 抬高退避，成功后 `relax()` 逐步回落；
 *  - 有上限，避免退避到天荒地老。
 */

/** 退避与间隔配置。默认值偏保守 —— 频控的风险是不对称的。 */
export interface ThrottleConfig {
  /** 每次请求之间的基准间隔（毫秒）。 */
  baseDelayMs: number;
  /** 退避倍数。 */
  backoffFactor: number;
  /** 单次等待的上限（毫秒）。 */
  maxDelayMs: number;
  /** 连续频控多少次后放弃。 */
  maxRetries: number;
}

export const DEFAULT_THROTTLE: ThrottleConfig = {
  // 参考实现只有 100ms，风险极高；这里默认 3 秒。
  baseDelayMs: 3000,
  backoffFactor: 2,
  maxDelayMs: 60_000,
  maxRetries: 3,
};

/** 可注入的运行时依赖，便于测试。 */
export interface ThrottleRuntime {
  sleep(ms: number): Promise<void>;
}

const realRuntime: ThrottleRuntime = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class Throttle {
  private readonly config: ThrottleConfig;
  private readonly runtime: ThrottleRuntime;
  private consecutiveRateLimits = 0;
  private totalWaits = 0;

  constructor(config: Partial<ThrottleConfig> = {}, runtime: ThrottleRuntime = realRuntime) {
    this.config = { ...DEFAULT_THROTTLE, ...config };
    this.runtime = runtime;
  }

  /** 当前这一轮的退避档位（1 表示无退避）。 */
  get level(): number {
    return this.consecutiveRateLimits + 1;
  }

  /** 本次应该等多久。 */
  currentDelayMs(): number {
    const raw = this.config.baseDelayMs * this.config.backoffFactor ** this.consecutiveRateLimits;
    return Math.min(raw, this.config.maxDelayMs);
  }

  /** 已发生的等待次数（用于观测）。 */
  get waits(): number {
    return this.totalWaits;
  }

  /** 请求前等待。 */
  async acquire(): Promise<number> {
    const delay = this.currentDelayMs();
    this.totalWaits += 1;
    await this.runtime.sleep(delay);
    return delay;
  }

  /** 成功一次 —— 退避档位回落一档（不完全清零，避免抖动）。 */
  relax(): void {
    if (this.consecutiveRateLimits > 0) this.consecutiveRateLimits -= 1;
  }

  /**
   * 被频控一次 —— 抬高退避。
   * @returns 是否还有重试预算。
   */
  penalize(): boolean {
    this.consecutiveRateLimits += 1;
    return this.consecutiveRateLimits <= this.config.maxRetries;
  }

  /** 是否已经把重试预算用完。 */
  get exhausted(): boolean {
    return this.consecutiveRateLimits > this.config.maxRetries;
  }

  /** 重置（新一轮任务开始时调用）。 */
  reset(): void {
    this.consecutiveRateLimits = 0;
    this.totalWaits = 0;
  }

  /** 把配置里生效的值暴露出去，便于在错误信息里提示用户调哪个开关。 */
  get effective(): ThrottleConfig {
    return { ...this.config };
  }
}

/**
 * 带退避重试的执行包装。
 *
 * 只对**频控**做重试；登录失效和业务错误立刻抛出（重试没有意义）。
 */
export async function withRateLimitRetry<T>(
  throttle: Throttle,
  operation: () => Promise<T>,
  isRateLimited: (error: unknown) => boolean,
): Promise<T> {
  for (;;) {
    await throttle.acquire();
    try {
      const result = await operation();
      throttle.relax();
      return result;
    } catch (error) {
      if (!isRateLimited(error)) throw error;
      if (!throttle.penalize()) throw error;
    }
  }
}
