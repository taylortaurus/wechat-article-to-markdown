# spider-claw 重构报告：Python → TypeScript

| 项 | 内容 |
| --- | --- |
| 分支 | `dev-dsh-spider-claw`（本地新建，未推送） |
| 基线 | `dev-obsidian`（Python 实现） |
| 目标 | 用 TypeScript/Node.js 生态整体重构，保留命令行形态与既有行为契约 |
| 状态 | 实现完成、可构建、可运行；类型检查 + 79 个离线单测全绿；**微信 live e2e 未在本机执行** |
| 待审阅决策 | ① `legacy/python/` 是否保留 ② 3 项有意行为变更是否接受 ③ 版本号 3.0.0 与 CI/发布配置 |

---

## 0. 审阅速览（TL;DR）

- **做了什么**：把 Python 包 `spider_claw`（13 个文件 / 1298 行）整体重写为 TypeScript
  （`src/`，17 个文件 / 1891 行），命令行入口仍叫 `spider-claw`，参数、输出目录结构、
  `url-list.json` 格式、去重键、退出码全部保持兼容。
- **怎么验证的**：`pnpm typecheck` / `pnpm build` / `pnpm test`（79 用例）全绿；CLI 冒烟
  覆盖单条、列表续爬、失败退出码；**并把同一篇文章分别用 Python 与 TypeScript 实现抓取，
  对产物做 diff —— 正文逐行一致，仅 3 处空白/标题差异**（见 §6.3）。
- **需要你拍板的**：
  1. Python 旧实现已归档到 `legacy/python/`（不参与构建与 CI），确认后可直接删除；
  2. §7 的 4 项有意行为变更（其中「剔除正文里重复的日期标题」是对旧实现与文档不一致的修复）；
  3. CI/发布链路已改为 pnpm + npm（未在本机实跑），发布目标从 PyPI 改为 npm。

---

## 1. 背景与目标

原实现是 Python 包（`pyproject.toml` + `uv`），依赖 `camoufox`（Python 版反检测浏览器）、
`markdownify`、`beautifulsoup4`、`httpx`、`readability-lxml`。本次要求：

1. 在**新分支**上重构，不影响原有分支；
2. 用 **TypeScript 生态与技术栈**重写现有能力；
3. **保持命令行形态**（`spider-claw "URL"` 及全部参数）；
4. 产出重构报告供人工审阅。

明确不在范围内：新增 Twitter 抓取实现（仍为 stub）、新增博客站点、改变输出目录约定、
改变 `url-list.json` 的字段语义。

---

## 2. 交付物清单

### 新增（TypeScript 实现）

```
package.json  pnpm-lock.yaml  pnpm-workspace.yaml  tsconfig.json  tsup.config.ts  vitest.config.ts
src/
  bin.ts cli.ts index.ts version.ts
  core/   http.ts images.ts markdown.ts urlList.ts logger.ts text.ts
  sources/ base.ts index.ts stub.ts twitter.ts wechat.ts blog.ts
  types/  turndown-plugin-gfm.d.ts
tests/
  setup.ts
  unit/  http markdown wechat blog urlList cli version .test.ts
  e2e/   wechat-live.test.ts
docs/  typescript-refactor-report.md   ← 本文
legacy/python/README.md                ← 归档说明
```

### 改动

- `README.md`、`SKILL.md`、`skills/*/SKILL.md`：安装/运行说明改为 Node + pnpm/npm，
  路径与字段名改为 TypeScript 侧（如 `BLOG_SITES` 的驼峰字段）。
- `.gitignore`：新增 `node_modules/`、`dist/`、`coverage/` 等。
- `.github/workflows/{ci,e2e,publish,release}.yml`：Python/uv/PyPI → Node/pnpm/npm。

### 归档（`git mv`，历史完整保留）

`pyproject.toml`、`uv.lock`、`spider_claw/`、`tests/` → `legacy/python/`。
`docs/*-design.md` 保留原位（它们描述的是历史设计，报告中按需引用）。

---

## 3. 技术选型

| 能力 | Python（原） | TypeScript（新） | 选型理由 |
| --- | --- | --- | --- |
| 运行时 | Python ≥ 3.8 | **Node ≥ 22** | 原生 `fetch` / `AbortSignal.timeout`；`camoufox-js`、`undici`、`commander`、`vitest` 均要求 ≥ 22 |
| 包管理 | uv | **pnpm 11**（`pnpm-lock.yaml`） | 与 uv 定位最接近：快、内容寻址存储、锁文件严格 |
| 语言 | Python 3 | **TypeScript 6**（`strict` + `noUncheckedIndexedAccess`） | 全量类型覆盖，公开 API 产出 `.d.ts` |
| HTML 解析 | BeautifulSoup4 | **cheerio 1.2** | jQuery 风格选择器 + 可变更 DOM，最接近 BS4 的用法 |
| 正文兜底提取 | readability-lxml | **@mozilla/readability + jsdom** | Readability 官方 JS 实现；jsdom 是其所依赖的 DOM 环境 |
| HTML → Markdown | markdownify | **turndown 7.2 + turndown-plugin-gfm** | ATX 标题 / `-` 列表 / 围栏代码块 / GFM 表格，与 markdownify 输出最接近 |
| HTTP 客户端 | httpx（含 socks） | **undici fetch**（Node 内置内核） | 原生能力，可直接控制 `dispatcher`（代理）与超时 |
| 代理 | 环境变量 + `NO_PROXY` 净化 | **`undici` 的 `EnvHttpProxyAgent`/`ProxyAgent` + 同一个净化逻辑** | 语义不变，且「直连」不再需要绕过环境变量 |
| 反检测浏览器 | `camoufox`（Python） | **camoufox-js 0.12 + playwright-core 1.60** | Camoufox 的官方 JS 移植（Apify），Playwright 驱动，仍需一次性 `camoufox-js fetch` |
| CLI 框架 | argparse | **commander 15** | `--source` 用 `.choices()` 直接得到参数校验 |
| 构建 | setuptools | **tsup 8**（esbuild + dts） | 单命令产出 `dist/cli.js`（带 shebang）+ `dist/index.js` + `index.d.ts` |
| 开发运行 | `uv run` | **tsx**（`pnpm dev`） | 免构建直跑 TypeScript |
| 测试 | pytest（含 `-m e2e`） | **vitest 5**（`tests/unit` / `tests/e2e` 分目录） | 与 TS 同源，`describe.skipIf` 天然实现「e2e 未配置即跳过」 |

依赖锁定（`package.json`）：`cheerio@1.2.0`、`turndown@7.2.4`、`turndown-plugin-gfm@1.0.2`、
`@mozilla/readability@0.6.0`、`jsdom@27.4.0`、`undici@8.10.2`、`commander@15.0.0`、
`camoufox-js@0.12.0`、`playwright-core@1.60.0`（`camoufox-js` 的 peer 约束是 `<1.61.0`，故显式降级钉住）、
`domhandler@5.0.3`（与 cheerio 同版本，用于统一 DOM 节点类型）。

---

## 4. 模块映射表

| Python | TypeScript | 行数（前 → 后） | 说明 |
| --- | --- | --- | --- |
| `spider_claw/cli.py` | `src/cli.ts` + `src/bin.ts` | 243 → 291 + 10 | 拆分：`cli.ts` 只定义与调度（可被库引用），`bin.ts` 才是可执行入口 |
| `sources/base.py` | `src/sources/base.ts` | 28 → 38 | 抽象基类；`fetch(url, output_dir, no_proxy)` → `fetch(url, { outputDir, proxy })` |
| `sources/wechat.py` | `src/sources/wechat.ts` | 260 → 302 | URL 归一化、元数据、正文预处理、Camoufox 抓取 |
| `sources/blog.py` | `src/sources/blog.ts` | 395 → 544 | 站点配置、日期解析、sitemap、readability 兜底、抓取 |
| `sources/stub.py` | `src/sources/stub.ts` | 22 → 18 | 占位来源 |
| `sources/twitter.py` | `src/sources/twitter.ts` | 9 → 7 | 占位（未实现） |
| `sources/__init__.py` | `src/sources/index.ts` | 23 → 28 | `SOURCES` / `BY_NAME` / `detectSource` |
| `core/http.py` | `src/core/http.ts` | 99 → 161 | dispatcher 解析、`NO_PROXY` 净化、字符集解码、`HttpClient` |
| `core/images.py` | `src/core/images.ts` | 109 → 103 | 并发下载（自研并发池，未引入 p-limit） |
| `core/markdownify_.py` | `src/core/markdown.ts` | 58 → 120 | turndown 服务配置、代码块占位符还原、图片链接替换、头信息拼接 |
| `core/url_list.py` | `src/core/urlList.ts` | 48 → 91 | 读写 + 错误类型化（`UrlListNotFoundError` / `UrlListFormatError`） |
| `core/__init__.py` | `src/core/logger.ts` + `core/text.ts` | 1 → 76 | 日志出口与文本工具（实体解码、安全文件名、空白折叠） |
| `spider_claw/__init__.py` | `src/index.ts` | 3 → 80 | 库入口，统一导出 core/sources/cli |
| — | `src/version.ts` | — | 版本常量（新增），由单测守护与 `package.json` 一致 |

代码量：Python `spider_claw` 1298 行 → TypeScript `src` 1891 行；测试 320 行 → 842 行。
行数增长主要来自类型标注、JSDoc 注释与显式错误处理（非逻辑膨胀）。

---

## 5. 关键设计决策

### 5.1 代理：默认直连，`--proxy` 才读环境变量（语义不变，实现更干净）

Python 的核心痛点写在 `core/http.py` 的注释里：`httpx` 在 `trust_env=True` 时会**在构造
Client 时**把 `NO_PROXY` 转成 mount 规则，用户 `.zshrc` 里常见的 IPv6 CIDR（`::1/128`）
会生成 `all://[::1/128]`，解析时抛 `InvalidURL("Invalid port: ':1'")` —— 连
`httpx.Client(proxy=None)`（"直连"）都会崩。

TypeScript 侧的处理：

- **默认 `direct`**：`undici` 的默认 dispatcher 本身就不读 `HTTP_PROXY`/`NO_PROXY`，
  所以「直连」天然不会踩这个坑 —— 不需要 Python 那样的 `trust_env=False` 兜底；
- **`--proxy` → `env`**：构造 `EnvHttpProxyAgent` 前，先用同一套 `cleanNoProxy()`
  把 `::1/128` 净化成 `::1`（临时改写环境变量，退出即还原）；万一仍然构造失败，
  只打印告警并**降级为直连**，绝不中断抓取；
- 显式代理 URL 非法时同样降级而非抛错。

单测 `tests/unit/http.test.ts` 用真实的畸形 `NO_PROXY` 覆盖了三条路径，并额外断言
「净化不会污染调用方环境变量」。

### 5.2 HTTP 客户端与字符集

`undici` 的 `Response.text()` **恒定按 UTF-8 解码**（忽略 `Content-Type` 里的 charset），
这会读乱 GBK 等旧编码的静态博客（Python 的 `httpx` 会按 charset 解码）。因此新增
`decodeBody()`：按 `Content-Type` → `<meta charset>` → UTF-8 的顺序嗅探并用
`TextDecoder(charset)` 解码，未知字符集时退回 UTF-8 而不是抛错。已有针对性单测。

### 5.3 微信代码块：沿用「占位符」协议

微信把代码渲染成带行号的 `.code-snippet__fix`，无法直接转 Markdown。沿用 Python 的做法：
抽取 `(lang, code)` 后把整块替换成 `<p>CODEBLOCK-PLACEHOLDER-{i}</p>`，转完 Markdown
再还原成围栏代码块 —— 这样 `<pre><code>` 与微信占位符两条路径互不干扰。
`pre > code.language-x` 由 turndown 的 `fencedCodeBlock` 规则补齐语言标识。

### 5.4 列表项输出风格对齐 markdownify

turndown 内置 `listItem` 规则用「三个空格」（`-   甲`）。为贴近 Python 侧 markdownify
的 `- 甲`，仅在 `core/markdown.ts` 内覆盖该规则（单空格前缀 + 2 空格缩进），
并保留有序列表的 `start` 语义。这是**输出格式**层面的对齐，不改变语义。

### 5.5 Camoufox 动态导入

`src/sources/wechat.ts` 里用 `await import('camoufox-js')` 而不是顶层 import：

- 未下载浏览器 / 原生依赖异常时，只影响微信来源，博客来源与全部单测不受牵连；
- 单测无需加载体积巨大的 `playwright-core`，测试启动时间保持在毫秒级。

### 5.6 CLI 分层与退出码

- `cli.ts` 只导出 `buildProgram()` / `execute()` / `runList()` / `runSitemap()` / `runSingle()` /
  `main()`；真正的「执行」放在 `bin.ts`，因此 `src/index.ts` 可以被安全地当库导入而不会
  顺手跑一次抓取。
- 错误分流：`CliError`（文案自带 `❌` 前缀，如来源识别失败）、`UrlListNotFoundError` /
  `UrlListFormatError`（列表文件问题，补 `❌` 前缀）、其余异常统一为
  `❌ 抓取失败: <message>`。
- 退出码保持 Python 语义：任一条抓取失败 → `1`，否则 `0`（列表模式下失败数由
  `runList` 返回，而非直接 `process.exit`，便于测试复用）。

### 5.7 可测试性：给 sitemap 抓取留一个注入点

`parseSitemap` / `discoverFromSitemap` 接受可选的 `fetchText`（默认 `fetchHtml`）。
Python 侧靠 `monkeypatch` 才能离线测嵌套 sitemap；TS 侧改成显式参数注入，
单测在完全不联网的前提下覆盖「sitemap 索引 → 子 sitemap → 过滤 → 去重」全链路。

---

## 6. 行为一致性验证（可复现）

### 6.1 静态检查与单测

```
$ pnpm typecheck      # tsc --noEmit，strict + noUncheckedIndexedAccess，0 错误
$ pnpm test           # vitest：7 files / 79 tests passed
$ pnpm build          # tsup：ESM + dts 成功
  dist/cli.js (带 #!/usr/bin/env node) / dist/index.js / dist/index.d.ts

Test Files  7 passed (7)
     Tests  79 passed (79)
```

覆盖清单见 §11。Python 原测试 4 个文件全部有对应迁移，并新增
`urlList`、`cli`（批量续爬/去重/退出码）、`http.decodeBody`、`version` 等用例。

### 6.2 CLI 冒烟（真实命令与结果）

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| 版本 | `node dist/cli.js --version` | `3.0.0` |
| 帮助 | `node dist/cli.js --help` | 五个参数齐全，`--source` 带 choices 校验 |
| 单条（真实博客） | `node dist/cli.js "https://addyosmani.com/blog/career-advice-age-of-agents/" -o /tmp/sc-smoke` | 产出 `The Agent-Era Career _ AddyOsmani.com.md`，9513 字符 |
| 列表（3 条：正常 + 重复 + stub 失败） | `node dist/cli.js --list url-list.json` | `成功 1 / 跳过 1 / 失败 1`，退出码 `1` |
| 列表回写 | 查看 `url-list.json` | 第 1 条写入 `status/source/output/updated_at`；第 3 条写入 `status: failed` + `error` |
| 续爬 | 再跑一次同一条命令 | `成功 0 / 跳过 2 / 失败 1`（done 与重复均跳过） |
| 列表缺失 | `--list /tmp/not-exist.json` | `❌ 未找到列表文件: ...` + 创建指引，退出码 `1` |
| 源码直跑 | `pnpm exec tsx src/bin.ts --version` | `3.0.0` |

### 6.3 双实现产物 diff（关键证据）

同一篇文章分别用 **Python 实现**（`legacy/python` + 原 venv）与 **TypeScript 实现**抓取，
对生成的 Markdown 做 `diff -u`：

```
https://addyosmani.com/blog/career-advice-age-of-agents/
Python 产物 9534 字符  vs  TypeScript 产物 9513 字符
```

diff 只有 3 处：

1. Python 在 `---` 与正文之间多了 2 个空行（markdownify 输出的前导换行）；
2. Python 正文里保留了 `## July 6, 2026` 这条**重复的日期标题**（见 §7.1）；
3. 文件结尾：Python 多一个空行，TypeScript 统一为「单个换行结尾」。

**除上述三处之外，正文逐行完全一致**（标题、作者、发布时间、原文链接、所有段落、
强调语法、行内链接均相同）。这证明重构在博客来源上做到了行为等价。

> 复现方式见 §10；由于两次抓取之间站点内容可能变化，建议审阅时重跑一次。

---

## 7. 有意的行为变更

以下 4 项是**有意偏离** Python 行为的地方，逐条列出原因与影响，请重点审阅。

### 7.1 剔除正文里重复的日期标题（bug 修复）

- **问题**：`dateIsFirstH2` 的文档意图（`docs/blog-source-design.md` §2）是「把日期写成
  首个 h2 的站点，解析后在正文中剔除，避免顶部重复」。但 Python 的提取顺序是
  元数据 `article:published_time` → `date_selector` → JSON-LD → 首个 h2，且**命中即 return**；
  addyosmani.com 的页面同时存在 `article:published_time` 与日期 h2，于是走了 meta 分支
  直接返回，**h2 从未被剔除** —— 实现与自身文档矛盾，产物顶部出现重复日期。
- **新行为**：当 `dateIsFirstH2: true` 时，**先无条件剔除**「首个 h2 且文本像日期」的节点，
  再按原优先级决定取值（meta 仍然优先于 h2）。取值优先级不变，只修复正文重复。
- **影响**：`addyosmani.com` 的产物少一行 `## July 6, 2026`（正是 §6.3 的第 2 处 diff）。
- **回退**：把 `src/sources/blog.ts` 的 `date()` 中该段逻辑改回「只在需要从 h2 取值时剔除」
  即可（单测 `日期已从 meta 取到，正文里重复的日期 h2 仍会被剔除` 需一并删除）。

### 7.2 正文首尾空行归一 + 文件以单个换行结尾

- **新行为**：`buildMarkdown()` 裁掉正文首尾空行，并保证文件以单个 `\n` 结束。
- **原因**：Python 产物在 `---` 之后多 2 个空行、结尾多 1 个空行，属无意义噪声；
  以换行结尾也是 POSIX 规范。
- **影响**：见 §6.3 的第 1、3 处 diff；对 Markdown 渲染无影响。
- **回退**：删除 `buildMarkdown()` 末尾两行归一逻辑，并同步 `markdown.test.ts` 的断言。

### 7.3 博客来源的抓取尊重 `--proxy`

- **Python 行为**：`BlogSource.fetch` 内部固定用 `sync_client()`（默认读环境代理），
  **忽略** `--proxy/no_proxy` —— 即无论是否传 `--proxy`，博客正文抓取都会走环境代理。
- **新行为**：博客正文抓取与图片下载都使用同一个 `options.proxy`（默认 `direct`）。
- **原因**：与「默认直连、`--proxy` 才走代理」的 CLI 语义保持一致，也让抓取路径可控。
- **影响**：默认（不传 `--proxy`）时，博客正文抓取从「走环境代理」变为「直连」。
  若你的环境必须通过代理访问外网，请显式加 `--proxy`。
- **回退**：`src/sources/blog.ts` 的 `fetch()` 里把 `fetchHtml(norm, { proxy: options.proxy })`
  改成 `{ proxy: 'env' }`。

### 7.4 `--source` 未知取值的报错位置

- Python：argparse 的 `choices` 直接报错退出；TS：commander 的 `.choices()` 同样在解析阶段报错。
  **行为一致**。此处列出仅为说明：列表条目里的 `source` 字段仍由 `runList` 自行校验并写回
  `status: failed` + `error`（与 Python 一致，单测覆盖）。

---

## 8. 保持不变的契约

- 命令名 `spider-claw`，参数 `-o/--output`、`--list`、`--source`、`--proxy`、`--from-sitemap`；
- 输出结构 `<output>/<title>/<title>.md` + `images/img_00N.<ext>`；
- `url-list.json` 的输入形态（裸字符串 / 对象 / 含 `urls` 字段的对象）与回写字段
  （`source`/`status`/`output`/`updated_at`/`error`）；
- 去重键 `(source, articleId)`：微信取核心路径（去参去锚），博客取 URL path；
- 「重复 URL，跳过」「已爬取，跳过」「🏁 完成：成功 x / 跳过 y / 失败 z」等提示文案；
- 疑似验证码时把原始 HTML 落到 `<output>/debug.html` 并抛出明确错误；
- `--from-sitemap` 的合并目标仍是 `./url-list.json`（**与 Python 相同**，即不跟随 `--list`，
  见 §9 遗留项）；
- Twitter 仍为 `NotImplementedError` 等价的 stub 行为。

---

## 9. 未完成 / 待确认

| # | 事项 | 现状与建议 |
| --- | --- | --- |
| 1 | **微信 live e2e 未在本机执行** | 需 `npx camoufox-js fetch` 下载浏览器二进制 + 真实文章 URL。代码是逐行移植，但「Camoufox 渲染 + 新 playwright-core 版本 + 微信风控」的组合未经实测。建议：本机跑一次 `WECHAT_E2E_URLS=... pnpm test:e2e`，或在 CI 上手动触发 `E2E` workflow |
| 2 | `legacy/python/` 是否保留 | 现作为对照参考归档，不参与构建/CI。确认后可直接 `git rm -r legacy/python` |
| 3 | CI / 发布链路未实跑 | 4 个 workflow 已改为 pnpm + Node 22 + `npm publish --provenance`（trusted publishing）。`npm` 发布环境（`npm` environment、包名占用、OIDC 配置）需要你确认；PyPI 相关配置已移除 |
| 4 | 版本号 | `package.json` = `3.0.0`（Python 侧为 `0.1.0`，SKILL.md 为 2.0.0）。如需与既有 tag 对齐请告知 |
| 5 | `--from-sitemap` 忽略 `--list` | 沿袭 Python 行为（固定写 `./url-list.json`）。若要改成「跟随 `--list`」，是一行改动，建议下次单独提 |
| 6 | pnpm 构建脚本放行 | `pnpm-workspace.yaml` 用 `allowBuilds` 放行 `esbuild`/`better-sqlite3`（pnpm 10+ 默认拦截）。二者即使不跑脚本也可用（平台二进制/`prebuilds` 已随包分发），此配置用于消除告警并保证未来可用 |
| 7 | Node 版本下限 | `engines.node >= 22`，由 `camoufox-js`(≥22)、`undici`(≥22.19)、`commander`(≥22.12)、`vitest` 共同决定 |

---

## 10. 如何复现验证

```bash
# 0) 切到重构分支
git checkout dev-dsh-spider-claw

# 1) 依赖 + 静态检查 + 单测 + 构建
pnpm install
pnpm typecheck
pnpm test            # 79 用例，离线
pnpm build           # dist/cli.js / dist/index.js / dist/index.d.ts

# 2) CLI 冒烟（真实博客，无需浏览器）
node dist/cli.js --version
node dist/cli.js "https://addyosmani.com/blog/career-advice-age-of-agents/" -o /tmp/sc-ts

# 3) 与 Python 旧实现对比（需保留原 venv 与 Python 3.14）
cd legacy/python && ../../.venv/bin/python -c "
import asyncio, sys, pathlib
sys.path.insert(0, '.')
from spider_claw.sources.blog import fetch_article
print(asyncio.run(fetch_article('https://addyosmani.com/blog/career-advice-age-of-agents/',
                                output_dir=pathlib.Path('/tmp/sc-py'))))
"
diff -u "$(find /tmp/sc-py -name '*.md' | head -1)" "$(find /tmp/sc-ts -name '*.md' | head -1)"

# 4) 微信 e2e（先下载浏览器二进制）
npx camoufox-js fetch
WECHAT_E2E_URLS="https://mp.weixin.qq.com/s/XXXXXXXX" pnpm test:e2e
```

---

## 11. 附录：测试覆盖清单（79 用例）

| 文件 | 用例数 | 覆盖点 |
| --- | --- | --- |
| `tests/unit/markdown.test.ts` | 10 | 代码块占位符还原、`pre>code` 语言标识、标题/列表/链接/加粗、GFM 表格、script/style 与 `&nbsp;` 清理、图片链接精确替换（含括号与查询参数）、普通链接不受影响、头信息拼接与首尾空行归一 |
| `tests/unit/wechat.test.ts` | 20 | `normalizeWechatUrl` 10 种输入、`extractPublishTime` 4 种写法、UTC+8 时间戳格式化、`processContent`（懒加载图片/代码块/行号与 counter 泄漏/噪声移除/图片去重/缺失容器）、`match` 边界、`articleId` 追踪参数归一 |
| `tests/unit/blog.test.ts` | 22 | 域名路由（含子域、未注册兜底）、`articleId`/`normalize`、`parseDate` 7 种格式 + 兜底、`looksLikeDate`、sitemap（CDATA、path 前缀过滤、嵌套索引、子 sitemap 失败容错、最大深度）、`extract`（og:title/作者/日期 h2 剔除/重复 h1 剔除/噪声移除）、meta 日期 + 日期 h2 共存、JSON-LD 作者与日期、readability 兜底 |
| `tests/unit/http.test.ts` | 9 | `cleanNoProxy`（IPv6 CIDR/空值/多余逗号）、`resolveDispatcher`（direct/env/非法代理降级）、畸形 `NO_PROXY` 下构造不崩且不污染环境变量、`HttpClient` 直连不读环境变量、`decodeBody`（UTF-8 / GBK / 未知字符集） |
| `tests/unit/urlList.test.ts` | 8 | 裸字符串归一、`{urls:[]}` 形态、无效条目跳过、文件缺失/非法 JSON/顶层结构错误的错误类型、中文与状态字段往返、`now()` 格式 |
| `tests/unit/cli.test.ts` | 9 | `resolveSource`（显式优先/自动识别/未知 source/无法识别）、`detectSource` 三来源、`runList` 去重 + done 跳过 + 回写字段 + 失败标记与返回码 + 未知 source 标记失败 + 空列表 |
| `tests/unit/version.test.ts` | 1 | `src/version.ts` 与 `package.json` 版本一致 |
| `tests/e2e/wechat-live.test.ts` | 1 | 真实微信文章抓取并校验 Markdown 含原文链接（未设置 `WECHAT_E2E_URLS` 时整组跳过） |

---

## 12. 结论

TypeScript 重构已完成并自我验证通过：命令行形态、目录结构、`url-list.json` 契约、
去重与续爬语义、退出码均与 Python 版兼容；在可自动化的范围内（类型、单测、构建、CLI 冒烟、
双实现产物 diff）证据充分。剩余风险集中在**微信 live e2e 未实测**与**CI/发布链路未实跑**
两项，详见 §9，需你确认后再推送分支。
