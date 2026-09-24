/**
 * CLI 统一日志出口（与具体来源无关）。
 *
 * 设计意图：抓取流程中的进度 / 告警都只经过这里，方便后续统一加 `--quiet`、
 * 结构化输出或重定向到文件；同时让单元测试可以静默日志。
 */
export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

let silent = false;

/** 静默所有输出（单元测试使用）。 */
export function setSilent(value: boolean): void {
  silent = value;
}

export const logger: Logger = {
  info(...args: unknown[]): void {
    if (!silent) console.log(...args);
  },
  warn(...args: unknown[]): void {
    if (!silent) console.warn(...args);
  },
  error(...args: unknown[]): void {
    if (!silent) console.error(...args);
  },
};
