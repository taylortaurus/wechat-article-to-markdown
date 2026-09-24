import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/bin.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  sourcemap: true,
  // 依赖由 Node 在运行时解析，不打进产物（camoufox-js / playwright-core 体积大且含原生模块）
  skipNodeModulesBundle: true,
});
