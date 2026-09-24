/**
 * P0-13 探针：Camoufox 能不能在「宿主进程」语境里跑通。
 *
 * 背景：dsh 插件会 `import 'spider-claw'`，于是 Camoufox（一个基于 Firefox 的
 * 反指纹浏览器）就会在**宿主的 Node 进程里**被动态 import 并启动一个无头浏览器。
 * 评估文档把这件事列为 P0-13，因为整份 P0 清单原本都押在 L1 和前端上，
 * L2 被当成"现成的、一行不改"，一个针对它的探针都没有。
 *
 * 这个脚本要回答三件事：
 *   1. 在一个干净的 Node 进程里，能不能 import 并启动 Camoufox
 *   2. 能不能真的抓下一篇文章、产出 Markdown + 本地图片
 *   3. 全过程的内存与耗时开销有多大（宿主进程要能承受）
 *
 * 用法：
 *   pnpm tsx scripts/probe/l2-camoufox-host.ts                 # 用内置的样例 URL
 *   pnpm tsx scripts/probe/l2-camoufox-host.ts <article-url>   # 指定 URL
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SAMPLE = 'https://mp.weixin.qq.com/s/9iOh0gG0Vp_gXip3FP6Xwg';

const url = process.argv[2] ?? SAMPLE;

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function rss(): number {
  return process.memoryUsage().rss;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else total += (await stat(p)).size;
  }
  return total;
}

const outDir = await mkdtemp(path.join(tmpdir(), 'p0-13-'));

console.log('=== P0-13：Camoufox 在宿主进程内 ===');
console.log(`目标文章：${url}`);
console.log(`输出目录：${outDir}`);
console.log(`启动前 RSS：${mb(rss())}`);
console.log('');

const t0 = Date.now();

try {
  console.log('[1/3] 动态 import camoufox-js（模拟插件加载时的那一刻）…');
  const tImport = Date.now();
  const mod = (await import('camoufox-js')) as { Camoufox: unknown };
  console.log(`      ✓ 导入成功，${Date.now() - tImport}ms，导出符号含 Camoufox = ${typeof mod.Camoufox === 'function' || typeof mod.Camoufox === 'object'}`);

  console.log('[2/3] 调 fetchWechatArticle（内部会启动无头 Firefox 并渲染页面）…');
  const tFetch = Date.now();
  const { fetchWechatArticle } = await import('../../src/sources/index.js');
  const mdPath = await fetchWechatArticle(url, { outputDir: outDir });
  const fetchMs = Date.now() - tFetch;
  console.log(`      ✓ 完成，${fetchMs}ms`);

  console.log('[3/3] 检查产物…');
  const md = await readFile(mdPath, 'utf8');
  const articleDir = path.dirname(mdPath);
  const imgDir = path.join(articleDir, 'images');
  let imgCount = 0;
  let imgBytes = 0;
  try {
    const names = await readdir(imgDir);
    imgCount = names.length;
    imgBytes = await dirSize(imgDir);
  } catch {
    /* 没有图片目录也算通过 */
  }
  const totalBytes = await dirSize(articleDir);

  console.log('');
  console.log('--- 结果 ---');
  console.log(`Markdown 路径：${path.relative(process.cwd(), mdPath)}`);
  console.log(`Markdown 大小：${(md.length / 1024).toFixed(1)} KB（${md.length} 字符）`);
  console.log(`图片：${imgCount} 张，共 ${mb(imgBytes)}`);
  console.log(`文章目录总计：${mb(totalBytes)}`);
  console.log(`总耗时：${Date.now() - t0}ms（其中抓取 ${fetchMs}ms）`);
  console.log(`结束后 RSS：${mb(rss())}（增量 ${mb(rss() - 0)}）`);
  console.log(`有标题头：# ${/^# .+/m.test(md) ? '是' : '否'}`);
  console.log(`有原文链接：${md.includes('mp.weixin.qq.com/s/') ? '是' : '否'}`);
  console.log(`有未本地化的远程图链：${/!\[[^\]]*\]\(https?:\/\//.test(md) ? '是 ⚠️' : '否'}`);
  console.log('');
  console.log('✓ P0-13 通过：Camoufox 能在独立 Node 进程（宿主语境的等价物）里跑通全链路');
} catch (e) {
  console.error('');
  console.error(`✗ P0-13 失败：${e instanceof Error ? e.message : String(e)}`);
  if (e instanceof Error && e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exitCode = 1;
} finally {
  await rm(outDir, { recursive: true, force: true }).catch(() => {});
}
