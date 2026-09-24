/**
 * spider-claw 命令行入口：统一路由到各来源（source）的抓取能力。
 *
 * 路由规则：
 * - 显式 `--source` 优先于 URL 自动识别；
 * - 未指定 `--source` 时按 URL 域名自动识别来源；
 * - 列表模式下每条可带 `source` 字段，缺省则自动识别、再回退 wechat（向后兼容）。
 */
import path from 'node:path';

import { Command, Option } from 'commander';

import type { ProxyConfig } from './core/http.js';
import { logger } from './core/logger.js';
import {
  UrlListFormatError,
  UrlListNotFoundError,
  loadUrlList,
  now,
  saveUrlList,
  type UrlListItem,
} from './core/urlList.js';
import type { Source } from './sources/base.js';
import { BlogSource, discoverFromSitemap } from './sources/blog.js';
import { BY_NAME, detectSource } from './sources/index.js';
import { VERSION } from './version.js';

/** 已经带上 `❌` 前缀、可直接展示给用户的错误。 */
export class CliError extends Error {}

const SOURCE_NAMES = [...BY_NAME.keys()];

function defaultOutputDir(): string {
  return path.join(process.cwd(), 'output');
}

function defaultListFile(): string {
  return path.join(process.cwd(), 'url-list.json');
}

/** 解析来源：显式 `--source` > URL 自动识别（失败即报错）。 */
export function resolveSource(url: string, sourceName?: string): Source {
  if (sourceName) {
    const source = BY_NAME.get(sourceName);
    if (!source) {
      throw new CliError(`❌ 未知 source: ${sourceName}；可选: ${SOURCE_NAMES.join(', ')}`);
    }
    return source;
  }
  const detected = detectSource(url);
  if (!detected) {
    throw new CliError(
      `❌ 无法从 URL 识别来源: ${url}\n` +
        `   已支持: ${SOURCE_NAMES.join(', ')}；可用 --source 显式指定`,
    );
  }
  return detected;
}

/**
 * 按 url-list.json 遍历爬取，已 done 的跳过，结果回写文件以支持续爬。
 *
 * 去重键为 `(source, articleId)`，同来源下同篇文章（含不同追踪参数、重复列出）
 * 只爬一次。
 *
 * @returns 失败条数（调用方据此决定退出码）。
 */
export async function runList(
  listPath: string,
  outputDir: string,
  proxy: ProxyConfig,
): Promise<number> {
  const items = await loadUrlList(listPath);
  if (items.length === 0) {
    logger.info('📋 列表为空，没有待爬取的 URL。');
    return 0;
  }

  const cwd = process.cwd();
  const total = items.length;
  let done = 0;
  let skipped = 0;
  let failed = 0;
  const seen = new Set<string>();

  for (const [index, item] of items.entries()) {
    const ordinal = index + 1;
    const url = typeof item.url === 'string' ? item.url : '';
    if (!url) continue;

    // 解析来源：优先 item.source，其次 URL 自动识别，最后回退 wechat
    let source: Source | undefined;
    if (item.source) {
      source = BY_NAME.get(item.source);
      if (!source) {
        logger.error(`  ❌ [${ordinal}/${total}] 未知 source: ${item.source}`);
        item.status = 'failed';
        item.error = `未知 source: ${item.source}`;
        item.updated_at = now();
        failed += 1;
        await saveUrlList(listPath, items);
        continue;
      }
    } else {
      source = detectSource(url) ?? BY_NAME.get('wechat');
    }
    if (!source) continue;

    const key = `${source.name}:${source.articleId(url)}`;
    if (seen.has(key)) {
      logger.info(`⏭️  [${ordinal}/${total}] 重复 URL，跳过: ${url}`);
      skipped += 1;
      continue;
    }

    if (item.status === 'done') {
      logger.info(`⏭️  [${ordinal}/${total}] 已爬取，跳过: ${url}`);
      skipped += 1;
      seen.add(key);
      continue;
    }

    const norm = source.normalize(url);
    if (norm !== url) logger.info('ℹ️  已自动清理 URL 中的转义字符 / HTML 实体。');
    logger.info(`🔜  [${ordinal}/${total}] 开始 [${source.name}]: ${norm}`);
    try {
      const mdPath = await source.fetch(norm, { outputDir, proxy });
      item.status = 'done';
      item.source = source.name;
      item.output = path.relative(cwd, mdPath) || mdPath;
      item.updated_at = now();
      delete item.error;
      done += 1;
    } catch (e) {
      logger.error(`  ❌ 抓取失败: ${(e as Error).message}`);
      item.status = 'failed';
      item.error = (e as Error).message;
      item.updated_at = now();
      failed += 1;
    }

    seen.add(key);
    // 每条处理后写回，保证中断也能续爬
    await saveUrlList(listPath, items);
  }

  logger.info(`\n🏁 完成：成功 ${done} / 跳过 ${skipped} / 失败 ${failed}（共 ${total}）`);
  return failed;
}

/** 从站点地图发现博客文章，合并进 url-list.json 后复用列表续爬逻辑。 */
export async function runSitemap(
  sitemapUrl: string,
  outputDir: string,
  proxy: ProxyConfig,
): Promise<number> {
  const blog = new BlogSource();
  const config = blog.configFor(sitemapUrl);
  const pathPrefix = config.listPathFilter ?? null;

  const urls = await discoverFromSitemap(sitemapUrl, { pathPrefix, proxy });
  if (urls.length === 0) {
    logger.info('🗺  站点地图中未发现可爬取的博客文章。');
    return 0;
  }
  logger.info(`🗺  站点地图发现 ${urls.length} 篇博客文章。`);

  // 合并进 url-list.json（按 (source, articleId) 去重，支持续爬）
  const listPath = defaultListFile();
  let items: UrlListItem[] = [];
  try {
    items = await loadUrlList(listPath);
  } catch (e) {
    if (!(e instanceof UrlListNotFoundError)) throw e;
    items = [];
  }

  const existing = new Set(
    items.filter((it) => it.url).map((it) => `${it.source ?? ''}:${blog.articleId(it.url)}`),
  );
  let added = 0;
  for (const url of urls) {
    const key = `blog:${blog.articleId(url)}`;
    if (existing.has(key)) continue;
    items.push({ url, source: 'blog' });
    existing.add(key);
    added += 1;
  }
  await saveUrlList(listPath, items);
  logger.info(`➕ 新增 ${added} 条到 ${listPath}（已存在则跳过），开始爬取…`);

  return runList(listPath, outputDir, proxy);
}

/** 单条抓取。 */
export async function runSingle(
  url: string,
  sourceName: string | undefined,
  outputDir: string,
  proxy: ProxyConfig,
): Promise<void> {
  const source = resolveSource(url, sourceName);
  const norm = source.normalize(url);
  if (norm !== url) logger.info('ℹ️  已自动清理 URL 中的转义字符 / HTML 实体。');
  await source.fetch(norm, { outputDir, proxy });
}

export interface CliOptions {
  url?: string;
  output?: string;
  list?: string;
  source?: string;
  proxy?: boolean;
  fromSitemap?: string;
}

/** 命令行定义与执行调度。 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('spider-claw')
    .description('多源文章抓取 & Markdown 转换工具 (spider-claw)')
    .version(VERSION, '-V, --version')
    .argument('[url]', '单个文章 URL；留空则按 --list 指定的 JSON 列表遍历爬取')
    .option('-o, --output <dir>', `输出目录 (默认: ${defaultOutputDir()})`)
    .option('--list <file>', `待爬取 URL 列表 JSON (默认: ${defaultListFile()})`)
    .addOption(
      new Option('--source <name>', '显式指定来源（覆盖 URL 自动识别）').choices(SOURCE_NAMES),
    )
    .option(
      '--proxy',
      '图片下载走环境代理（默认直连，忽略 ALL_PROXY/HTTPS_PROXY 等环境变量）',
      false,
    )
    .option(
      '--from-sitemap <sitemapUrl>',
      '从站点地图批量发现博客文章并爬取（自动按站点规则过滤，并写入 url-list.json 续爬）',
    )
    .action(async (url: string | undefined, options: CliOptions) => {
      await execute({ ...options, url });
    });

  return program;
}

/** 按参数选择执行模式（站点地图 / 单条 / 列表）。 */
export async function execute(options: CliOptions): Promise<void> {
  const outputDir = options.output ?? defaultOutputDir();
  const listPath = options.list ?? defaultListFile();
  const proxy: ProxyConfig = options.proxy ? 'env' : 'direct';

  // 站点地图批量模式
  if (options.fromSitemap) {
    const failed = await runSitemap(options.fromSitemap, outputDir, proxy);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  // 单条模式
  if (options.url) {
    await runSingle(options.url, options.source, outputDir, proxy);
    return;
  }

  // 列表模式
  const failed = await runList(listPath, outputDir, proxy);
  if (failed > 0) process.exitCode = 1;
}

/** 解析 argv 并执行（供测试直接调用）。 */
export async function run(argv: string[] = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}

/** 进程入口：统一错误出口与退出码。 */
export async function main(): Promise<void> {
  try {
    await run(process.argv);
  } catch (e) {
    if (e instanceof CliError) {
      // CliError 的文案自带 ❌ 前缀与换行缩进
      logger.error(e.message);
    } else if (e instanceof UrlListNotFoundError || e instanceof UrlListFormatError) {
      logger.error(`❌ ${e.message}`);
    } else {
      logger.error(`❌ 抓取失败: ${(e as Error).message}`);
    }
    process.exitCode = 1;
  }
}
