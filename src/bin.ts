#!/usr/bin/env node
/**
 * 可执行入口：`spider-claw` 命令。
 *
 * 单独成文件（而不是放在 `cli.ts` 里）是为了让 `src/index.ts` 可以安全地被当成
 * 库导入而不会顺手执行一次抓取。
 */
import { main } from './cli.js';

await main();
