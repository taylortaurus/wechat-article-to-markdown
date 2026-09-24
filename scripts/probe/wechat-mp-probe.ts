/**
 * P0 探针：微信公众号后台接口的存活性与契约核验。
 *
 * 这个脚本回答 `docs/wechat-mp-plugin-evaluation.md` 第 15 节里的 P0-1 ~ P0-5、P0-7。
 * 它是**一次性工具**，不是产品代码：不进 `src/`、不进 CI、不进 typecheck
 * （`tsconfig.json` 的 include 只覆盖 src/tests/config）。
 *
 * 用法见同目录 README.md。最常用的一条：
 *
 *   pnpm probe:mp -- --query "公众号昵称"
 *
 * 安全约定（重要）：
 * - 所有产物写到 `scripts/probe/out/`，该目录已在 .gitignore 里。
 * - **token / Cookie 只在内存里流转，绝不打印到终端。**
 * - 落盘的样本分两份：`raw/` 保留原样（含敏感值，仅供本地排错），
 *   `fixtures/` 是脱敏后的，将来可以拷进 `tests/fixtures/`。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const RAW_DIR = path.join(OUT, 'raw');
const FIXTURE_DIR = path.join(OUT, 'fixtures');
const QR_PATH = path.join(OUT, 'qrcode.png');
const SESSION_PATH = path.join(OUT, 'session.json');

const HOST = 'https://mp.weixin.qq.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --------------------------------------------------------------------------- #
// 参数
// --------------------------------------------------------------------------- #

interface Args {
  query?: string;
  fakeid?: string;
  counts: number[];
  pages: number;
  pageDelayMs: number;
  hammer: boolean;
  reuse: boolean;
  pollMs: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  return {
    query: get('query'),
    fakeid: get('fakeid'),
    counts: (get('counts') ?? '5,20,50').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0),
    pages: Number(get('pages') ?? '3'),
    pageDelayMs: Number(get('page-delay') ?? '3000'),
    hammer: has('hammer'),
    reuse: !has('fresh'),
    pollMs: Number(get('poll-interval') ?? '2000'),
    dryRun: has('dry-run'),
  };
}

const args = parseArgs(process.argv.slice(2));

// --------------------------------------------------------------------------- #
// 小工具
// --------------------------------------------------------------------------- #

const results: string[] = [];

function log(msg = ''): void {
  console.log(msg);
}

/** 记录一条结论，最后汇总打印，方便直接誊进结论文档。 */
function record(tag: string, msg: string): void {
  const line = `[${tag}] ${msg}`;
  results.push(line);
  console.log(`  → ${line}`);
}

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function form(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

/** `YYYY-MM-DD HH:mm:ss`（本地时区）。 */
function stamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Cookie 的**唯一**来源。
 *
 * 参考实现踩过的坑（缺陷 A1）：一边让 HttpClientHandler 自动管 Cookie，
 * 一边又在每个请求里手动拼 `Cookie` 头。这里只维护这一个 jar，请求头由它派生。
 */
class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(res: Response): void {
    const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const line of raw) {
      const pair = line.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** 只暴露名字，**不暴露值**，用于日志。 */
  names(): string[] {
    return [...this.jar.keys()].sort();
  }

  get size(): number {
    return this.jar.size;
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.jar);
  }

  static fromJSON(obj: Record<string, string>): CookieJar {
    const j = new CookieJar();
    for (const [k, v] of Object.entries(obj)) j.jar.set(k, v);
    return j;
  }
}

async function mpFetch(
  jar: CookieJar,
  url: string,
  init: RequestInit = {},
): Promise<{ res: Response; text: string }> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Referer: `${HOST}/`,
    Origin: HOST,
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (jar.size > 0) headers.Cookie = jar.header();

  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  jar.absorb(res);
  return { res, text: await res.text() };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// --------------------------------------------------------------------------- #
// 脱敏
// --------------------------------------------------------------------------- #

/** 值要整体替换掉的键（大小写不敏感）。 */
const REDACT_KEYS = new Set([
  'token',
  'cookie',
  'sessionid',
  'nick_name',
  'nickname',
  'head_img',
  'avatar',
  'avatarurl',
  'signature',
  'alias',
  'fakeid',
  'biz',
  'wxid',
  'cover',
  'pic_cdn_url_235_1',
  'pic_cdn_url_16_9',
  'appmsg_token',
  'pass_ticket',
]);

/** 只保留结构、丢掉具体值的键。 */
function sanitizeUrl(value: string): string {
  try {
    const u = new URL(value);
    const segs = u.pathname
      .split('/')
      .map((s) => (/^[A-Za-z0-9_-]{8,}$/.test(s) ? '<ID>' : s))
      .join('/');
    const keys = [...u.searchParams.keys()];
    return `${u.origin}${segs}${keys.length > 0 ? `?${keys.join('&')}` : ''}`;
  } catch {
    return '<URL>';
  }
}

const URL_KEYS = new Set(['url', 'link', 'redirect_url', 'redirecturl']);

function sanitize(value: unknown, keyHint = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, keyHint));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (REDACT_KEYS.has(lower)) out[k] = `<REDACTED:${k}>`;
      else if (URL_KEYS.has(lower) && typeof v === 'string') out[k] = sanitizeUrl(v);
      else out[k] = sanitize(v, lower);
    }
    return out;
  }
  if (typeof value === 'string' && URL_KEYS.has(keyHint)) return sanitizeUrl(value);
  return value;
}

async function saveSample(name: string, rawText: string): Promise<void> {
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(path.join(RAW_DIR, `${name}.txt`), rawText, 'utf8');
  const parsed = safeJson(rawText);
  const body = parsed === undefined ? rawText : JSON.stringify(sanitize(parsed), null, 2);
  await writeFile(path.join(FIXTURE_DIR, `${name}.json`), `${body}\n`, 'utf8');
}

// --------------------------------------------------------------------------- #
// 接口封装
// --------------------------------------------------------------------------- #

interface BaseResp {
  base_resp?: { ret?: number; err_msg?: string };
}

function ret(item: unknown): number | undefined {
  return (item as BaseResp | undefined)?.base_resp?.ret;
}

function errMsg(item: unknown): string | undefined {
  return (item as BaseResp | undefined)?.base_resp?.err_msg;
}

/** 第 1 步：开一个登录会话。 */
async function startlogin(jar: CookieJar): Promise<void> {
  const sessionid = `${Date.now()}${Math.floor(Math.random() * 900) + 100}`;
  const url = `${HOST}/cgi-bin/bizlogin?${qs({ action: 'startlogin' })}`;
  const body = form({
    userlang: 'zh_CN',
    redirect_url: '',
    login_type: '3',
    sessionid,
    token: '',
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  });
  const { res, text } = await mpFetch(jar, url, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  await saveSample('01-startlogin', text);
  log(`  HTTP ${res.status}，cookie 现有 ${jar.size} 项：${jar.names().join(', ') || '(空)'}`);
  log(`  ret=${String(ret(safeJson(text)))}`);
}

/** 第 2 步：取二维码图片。 */
async function getqrcode(jar: CookieJar): Promise<boolean> {
  const url = `${HOST}/cgi-bin/scanloginqrcode?${qs({ action: 'getqrcode', random: String(Math.random()) })}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: `${HOST}/`, Cookie: jar.header() },
    signal: AbortSignal.timeout(20_000),
  });
  jar.absorb(res);
  const buf = new Uint8Array(await res.arrayBuffer());
  await mkdir(OUT, { recursive: true });
  await writeFile(QR_PATH, buf);
  const ok = res.ok && buf.length > 1000 && buf[0] === 0x89 && buf[1] === 0x50;
  log(`  HTTP ${res.status}，${buf.length} 字节，PNG 魔数=${ok ? '是' : '否'}`);
  log(`  已写入：${QR_PATH}`);
  if (ok) record('P0-1', `getqrcode 可用：HTTP 200，返回 ${buf.length} 字节合法 PNG`);
  else record('P0-1', `⚠️ getqrcode 异常：HTTP ${res.status}，${buf.length} 字节，PNG 魔数不匹配`);
  return ok;
}

interface ScanStatus {
  status: number;
  acctSize: number;
  err?: string;
}

/** 第 3 步：轮询扫码状态。这里刻意覆盖全部状态码，用来核验 FrmLogin 的分支表。 */
async function ask(jar: CookieJar): Promise<ScanStatus> {
  const url = `${HOST}/cgi-bin/scanloginqrcode?${qs({
    action: 'ask',
    token: '',
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  })}`;
  const { text } = await mpFetch(jar, url);
  const json = safeJson(text) as { status?: number; acct_size?: number } | undefined;
  return {
    status: json?.status ?? -1,
    acctSize: json?.acct_size ?? 0,
    err: errMsg(json),
  };
}

/** 第 4 步：确认登录，从 `redirect_url` 里取 token。 */
async function bizlogin(jar: CookieJar): Promise<string | undefined> {
  const url = `${HOST}/cgi-bin/bizlogin?${qs({ action: 'login' })}`;
  const body = form({
    userlang: 'zh_CN',
    redirect_url: '',
    cookie_forbidden: '0',
    cookie_cleaned: '0',
    plugin_used: '0',
    login_type: '3',
    token: '',
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  });
  const { text } = await mpFetch(jar, url, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  await saveSample('04-bizlogin', text);
  const json = safeJson(text) as { redirect_url?: string; base_resp?: { ret?: number } } | undefined;
  log(`  ret=${String(json?.base_resp?.ret)}`);
  const redirect = json?.redirect_url ?? '';
  const token = redirect ? (new URL(redirect, HOST).searchParams.get('token') ?? undefined) : undefined;
  if (token) record('P0-1', `bizlogin 可用：从 redirect_url 取到 token（长度 ${token.length}，值不打印）`);
  else record('P0-1', `⚠️ bizlogin 未取到 token：redirect_url ${redirect ? '有值但无 token 参数' : '为空'}`);
  return token;
}

async function getprofile(jar: CookieJar, token: string): Promise<string | undefined> {
  const url = `${HOST}/cgi-bin/account/getprofile?${qs({
    action: 'getprofile',
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
    token,
  })}`;
  const { text } = await mpFetch(jar, url);
  await saveSample('05-getprofile', text);
  const json = safeJson(text) as { nick_name?: string; head_img?: string } | undefined;
  const nickname = json?.nick_name;
  log(`  昵称：${nickname ? `已取到（${nickname.length} 字，值不打印）` : '(空)'}；头像：${json?.head_img ? '有' : '无'}`);
  return nickname;
}

interface Account {
  fakeid: string;
  nickname: string;
  serviceType?: number;
}

async function searchbiz(jar: CookieJar, token: string, query: string, count: number): Promise<unknown> {
  const url = `${HOST}/cgi-bin/searchbiz?${qs({
    action: 'search_biz',
    begin: '0',
    count: String(count),
    query,
    token,
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  })}`;
  const { text } = await mpFetch(jar, url);
  await saveSample(`06-searchbiz-count${count}`, text);
  const json = safeJson(text) as { list?: Account[]; total?: number } | undefined;
  log(`  HTTP 200，ret=${String(ret(json))}，返回 ${json?.list?.length ?? 0} 个号，total=${String(json?.total)}`);
  return json;
}

interface ArticleRow {
  aid?: string;
  appmsgid?: number;
  title?: string;
  link?: string;
  author_name?: string;
  create_time?: number;
  update_time?: number;
  publish_time?: number;
  digest?: string;
  item_show_type?: number;
  is_deleted?: boolean;
  is_pay_subscribe?: number;
}

/** 把 `publish_page` 那三层嵌套字符串剥开。这是契约里最容易写错的地方。 */
function parsePublishPage(json: unknown): { publishCount?: number; totalCount?: number; rows: ArticleRow[] } {
  const outer = json as { publish_page?: string } | undefined;
  const page = typeof outer?.publish_page === 'string' ? safeJson(outer.publish_page) : undefined;
  const p = page as { publish_count?: number; total_count?: number; publish_list?: { publish_info?: string }[] } | undefined;
  const rows: ArticleRow[] = [];
  for (const item of p?.publish_list ?? []) {
    if (typeof item?.publish_info !== 'string') continue;
    const info = safeJson(item.publish_info) as { appmsgex?: ArticleRow[] } | undefined;
    rows.push(...(info?.appmsgex ?? []));
  }
  return { publishCount: p?.publish_count, totalCount: p?.total_count, rows };
}

async function appmsgpublish(
  jar: CookieJar,
  token: string,
  fakeid: string,
  begin: number,
  count: number,
  sampleName?: string,
): Promise<{ rows: ArticleRow[]; totalCount?: number; retVal: number | undefined; err?: string; elapsedMs: number }> {
  const url = `${HOST}/cgi-bin/appmsgpublish?${qs({
    sub: 'list',
    search_field: 'null',
    begin: String(begin),
    count: String(count),
    query: '',
    fakeid,
    type: '101_1',
    free_publish_type: '1',
    sub_action: 'list_ex',
    token,
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  })}`;
  const t0 = Date.now();
  const { text } = await mpFetch(jar, url);
  const elapsedMs = Date.now() - t0;
  if (sampleName) await saveSample(sampleName, text);
  const json = safeJson(text);
  const parsed = parsePublishPage(json);
  return {
    rows: parsed.rows,
    totalCount: parsed.totalCount,
    retVal: ret(json),
    err: errMsg(json),
    elapsedMs,
  };
}

// --------------------------------------------------------------------------- #
// 主流程
// --------------------------------------------------------------------------- #

async function loadSession(): Promise<{ token: string; jar: CookieJar; savedAt: string } | undefined> {
  if (!args.reuse) return undefined;
  try {
    const raw = await readFile(SESSION_PATH, 'utf8');
    const saved = JSON.parse(raw) as { token?: string; cookies?: Record<string, string>; savedAt?: string };
    if (!saved.token || !saved.cookies || !saved.savedAt) {
      log('  已保存的 session 缺字段，视为未授权（这是 A5 的准确教训）');
      return undefined;
    }
    const days = (Date.now() - new Date(saved.savedAt).getTime()) / 86_400_000;
    log(`  发现 ${saved.savedAt} 保存的 session，已过 ${days.toFixed(2)} 天`);
    record('P0-4', `复用 session（保存于 ${saved.savedAt}，距今 ${days.toFixed(2)} 天）`);
    return { token: saved.token, jar: CookieJar.fromJSON(saved.cookies), savedAt: saved.savedAt };
  } catch {
    return undefined;
  }
}

async function saveSession(token: string, jar: CookieJar): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await writeFile(
    SESSION_PATH,
    `${JSON.stringify({ token, cookies: jar.toJSON(), savedAt: stamp() }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  log(`  已保存 session 到 ${SESSION_PATH}（权限 0600，已在 .gitignore 内）`);
}

/** 走完扫码登录四步。 */
async function loginFlow(): Promise<{ token: string; jar: CookieJar }> {
  const jar = new CookieJar();

  log('\n[1/5] startlogin —— 开启登录会话');
  await startlogin(jar);

  log('\n[2/5] getqrcode —— 取二维码');
  if (!(await getqrcode(jar))) throw new Error('取二维码失败，中止');
  log('');
  log('  ┌──────────────────────────────────────────────────────────┐');
  log('  │ 请打开下面的图片，用你（该公众号管理员/运营者）的微信扫码 │');
  log(`  │   open "${QR_PATH}"`);
  log('  │  然后在手机上点确认。这个脚本会自动轮询到状态变化。        │');
  log('  └──────────────────────────────────────────────────────────┘');

  log('\n[3/5] ask —— 轮询扫码状态');
  const seen = new Set<number>();
  const t0 = Date.now();
  let confirmed = false;
  // 二维码大约几分钟过期；给 5 分钟窗口，过期就重新取图。
  while (Date.now() - t0 < 5 * 60_000) {
    const st = await ask(jar);
    const secs = Math.round((Date.now() - t0) / 1000);
    if (!seen.has(st.status)) {
      seen.add(st.status);
      log(`  ${String(secs).padStart(3)}s  首次见到 status=${st.status}  acct_size=${st.acctSize}${st.err ? `  err=${st.err}` : ''}`);
      record('P0-1', `轮询见到 status=${st.status}（acct_size=${st.acctSize}）`);
    }
    if (st.status === 1) {
      confirmed = true;
      log(`  ${String(secs).padStart(3)}s  status=1，已确认`);
      break;
    }
    if (st.status === 2 || st.status === 3) {
      log('  二维码过期，重新取一张');
      await getqrcode(jar);
      log(`  新图已写入 ${QR_PATH}，请重新扫码`);
    }
    if (st.status === 5) throw new Error('status=5：账号未绑定邮箱，终止轮询（核验 FrmLogin 的 case 5 分支）');
    await new Promise((r) => setTimeout(r, args.pollMs));
  }
  if (!confirmed) throw new Error('等待确认超时（5 分钟）');
  record('P0-1', `扫码轮询可用：等待约 ${Math.round((Date.now() - t0) / 1000)} 秒后拿到 status=1`);
  log(`  本轮共观察到 ${seen.size} 种状态值：${[...seen].sort((a, b) => a - b).join(', ')}`);

  log('\n[4/5] bizlogin —— 确认登录并取 token');
  const token = await bizlogin(jar);
  if (!token) throw new Error('未取得 token，中止');

  log('\n[5/5] getprofile —— 取账号信息');
  await getprofile(jar, token);

  await saveSession(token, jar);
  return { token, jar };
}

async function findAccount(token: string, jar: CookieJar): Promise<Account> {
  if (args.fakeid) return { fakeid: args.fakeid, nickname: '(由 --fakeid 指定)' };
  if (!args.query) throw new Error('需要 --query "<公众号昵称>" 或 --fakeid <id>');

  log(`\n[searchbiz] 搜索「${args.query}」`);
  const countsToTry = [...new Set([5, 20])];
  let first: Account | undefined;
  for (const c of countsToTry) {
    const json = (await searchbiz(jar, token, args.query!, c)) as { list?: Account[] } | undefined;
    const n = json?.list?.length ?? 0;
    record('P0-5', `searchbiz count=${c} → 实际返回 ${n} 条`);
    if (first === undefined && json?.list?.[0]) first = json.list[0];
  }
  if (!first) throw new Error('没有搜到任何公众号，换个关键词或直接用 --fakeid');
  log(`  选用第 1 个结果：${first.nickname}（fakeid 长度 ${first.fakeid.length}）`);
  return first;
}

async function probeList(token: string, jar: CookieJar, account: Account): Promise<void> {
  log('\n[appmsgpublish] 列文章');

  // --- P0-3：count 的实际上限 ---
  log(`\n  · count 上限（P0-3）：同一 begin 分别用 ${args.counts.join(' / ')} 请求`);
  for (const c of args.counts) {
    const r = await appmsgpublish(jar, token, account.fakeid, 0, c, `07-appmsgpublish-count${c}`);
    if (r.retVal !== undefined && r.retVal !== 0) {
      record('P0-3', `count=${c} → ret=${r.retVal} ${r.err ?? ''}`);
      continue;
    }
    log(`    count=${c} → 拿到 ${r.rows.length} 篇，total_count=${String(r.totalCount)}，${r.elapsedMs}ms`);
    record('P0-3', `count=${c} → 实际 ${r.rows.length} 篇（total_count=${String(r.totalCount)}）`);
  }

  // --- 字段契约 + 嵌套解析 ---
  const first = await appmsgpublish(jar, token, account.fakeid, 0, args.counts[0] ?? 5, '07-appmsgpublish-begin0');
  if (first.rows.length === 0) {
    record('P0-1', `⚠️ publish_list 解析出 0 篇（ret=${String(first.retVal)}）——要么这个号没发过文章，要么解析链变了`);
    return;
  }
  const keys = [...new Set(first.rows.flatMap((r) => Object.keys(r)))].sort();
  log(`    第 1 页拿到的字段：${keys.join(', ')}`);
  record('P0-1', `appmsgpublish 三层嵌套解析成功，第 1 页 ${first.rows.length} 篇`);
  record('P0-1', `实际字段集合：${keys.join(', ')}`);
  const t = first.rows[0]!;
  record(
    'P0-1',
    `样本：aid 长度=${t.aid?.length ?? 0}，item_show_type=${String(t.item_show_type)}，` +
      `is_deleted=${String(t.is_deleted)}，is_pay_subscribe=${String(t.is_pay_subscribe)}，` +
      `publish_time=${String(t.publish_time)}，update_time=${String(t.update_time)}`,
  );

  // --- P0-4 的间接证据：token 是否已被服务端接受 ---
  record('P0-4', `本次 session 可用（token 被 appmsgpublish 接受，ret=0）`);

  // --- 分页 ---
  log(`\n  · 分页（正常节奏，间隔 ${args.pageDelayMs}ms）`);
  let begin = (args.counts[0] ?? 5);
  for (let page = 1; page <= args.pages; page++) {
    await new Promise((r) => setTimeout(r, args.pageDelayMs));
    const r = await appmsgpublish(jar, token, account.fakeid, begin, args.counts[0] ?? 5);
    log(`    begin=${begin} → ${r.rows.length} 篇，ret=${String(r.retVal)}，${r.elapsedMs}ms`);
    if (r.rows.length === 0) {
      record('P0-1', `翻页到 begin=${begin} 时返回 0 篇（终止条件可用）`);
      break;
    }
    begin += args.counts[0] ?? 5;
  }

  // --- P0-2：频控 ---
  if (args.hammer) {
    log('\n  · 快速翻页试探频控（P0-2）——不发延时，连打 12 次');
    let triggered: { nth: number; ret: number; err?: string } | undefined;
    const t0 = Date.now();
    for (let i = 0; i < 12; i++) {
      const r = await appmsgpublish(jar, token, account.fakeid, 0, 5);
      if (i === 0) log(`    第 1 次 ${r.elapsedMs}ms`);
      if (r.retVal !== undefined && r.retVal !== 0) {
        triggered = { nth: i + 1, ret: r.retVal, err: r.err };
        break;
      }
    }
    const total = Date.now() - t0;
    if (triggered) {
      log(`    第 ${triggered.nth} 次被拒：ret=${triggered.ret} ${triggered.err ?? ''}`);
      record('P0-2', `频控已触发：第 ${triggered.nth} 次连打返回 ret=${triggered.ret}「${triggered.err ?? ''}」，共耗时 ${total}ms`);
      record('P0-2', '→ 说明必须限速；安全间隔需要进一步二分（从「不触发」的间隔往上试）');
    } else {
      log('    12 次连打全部成功（ret=0）');
      record('P0-2', `12 次连打未触发频控（总耗时 ${total}ms，约 ${Math.round(total / 12)}ms/次）——阈值比这个更宽`);
    }
  } else {
    record('P0-2', '未试探频控（加 --hammer 才会做；会快速连打 12 次，注意风控）');
  }
}

/** 用一个便宜的接口验证 token 是否还有效。 */
async function checkTokenAlive(token: string, jar: CookieJar): Promise<boolean> {
  const url = `${HOST}/cgi-bin/searchbiz?${qs({
    action: 'search_biz',
    begin: '0',
    count: '1',
    query: 'a',
    token,
    lang: 'zh_CN',
    f: 'json',
    ajax: '1',
  })}`;
  const { text } = await mpFetch(jar, url);
  const r = ret(safeJson(text));
  if (r === 200003) {
    record('P0-4', '⚠️ 保存的 session 已被服务端拒绝（ret=200003），需要重新扫码');
    return false;
  }
  return r === 0;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  log('=== 微信后台接口探针（P0） ===');
  log(`产物目录：${OUT}`);
  if (args.dryRun) {
    log('\n--dry-run：只列出计划，不发起任何请求\n');
    log('将要调用的端点（按顺序）：');
    log(`  1. POST ${HOST}/cgi-bin/bizlogin?action=startlogin`);
    log(`  2. GET  ${HOST}/cgi-bin/scanloginqrcode?action=getqrcode      → 存到 out/qrcode.png`);
    log(`  3. GET  ${HOST}/cgi-bin/scanloginqrcode?action=ask            → 每 ${args.pollMs}ms 轮询一次，最多 5 分钟`);
    log(`  4. POST ${HOST}/cgi-bin/bizlogin?action=login                 → 取 token`);
    log(`  5. GET  ${HOST}/cgi-bin/account/getprofile?action=getprofile`);
    if (args.fakeid) log(`  6. （跳过搜索，用 --fakeid）`);
    else log(`  6. GET  ${HOST}/cgi-bin/searchbiz?action=search_biz           → query="${args.query ?? '(未指定)'}"，分别用 count=5,20`);
    log(`  7. GET  ${HOST}/cgi-bin/appmsgpublish                          → count=${args.counts.join('/')}；再正常节奏翻 ${args.pages} 页，间隔 ${args.pageDelayMs}ms`);
    if (args.hammer) log(`  7b. 连打 12 次探频控（--hammer 已开，有风控风险）`);
    log('\n请求头：Chrome 120 UA + Referer/Origin = mp.weixin.qq.com；Cookie 由单一 jar 派生');
    log(`复用已保存 session：${args.reuse ? '是（若 token 仍有效则跳过扫码）' : '否（--fresh 强制扫码）'}`);
    if (!args.query && !args.fakeid) log('\n⚠️ 没给 --query 或 --fakeid，真跑会在搜索那一步报错');
    return;
  }
  if (args.hammer) log('⚠️ --hammer 已开启：会快速连打接口，有触发风控的可能');

  let token: string;
  let jar: CookieJar;

  const saved = await loadSession();
  if (saved && (await checkTokenAlive(saved.token, saved.jar))) {
    log('  保存的 session 仍然有效，跳过扫码');
    record('P0-4', '复用的 session 仍然有效（ret=0）');
    token = saved.token;
    jar = saved.jar;
  } else {
    const fresh = await loginFlow();
    token = fresh.token;
    jar = fresh.jar;
  }

  const account = await findAccount(token, jar);
  await probeList(token, jar, account);

  log('\n=== 结论汇总 ===');
  for (const line of results) log(`  ${line}`);

  await writeFile(
    path.join(OUT, 'summary.txt'),
    `${results.join('\n')}\n`,
    'utf8',
  );
  log(`\n结论已写入 ${path.join(OUT, 'summary.txt')}`);
  log(`脱敏样本在 ${FIXTURE_DIR}/，未脱敏的在 ${RAW_DIR}/（两者都已 gitignore）`);
}

main().catch((e: unknown) => {
  console.error(`\n✗ 探针失败：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
