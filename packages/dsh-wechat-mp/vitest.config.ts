import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * 插件自己的单测配置。
 *
 * `spider-claw` 被解析到它**已构建的产物**（`dist/index.js`），与 tsconfig 的
 * 类型解析（`dist/index.d.ts`）保持一致 —— 消费一个构建好的包，而不是把兄弟包的
 * 源码拉进来编译。
 */
const siblingDist = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      'spider-claw': siblingDist,
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
