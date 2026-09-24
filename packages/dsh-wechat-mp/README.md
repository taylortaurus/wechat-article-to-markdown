# dsh-wechat-mp

DeepSeek Harness（dsh）插件：**微信公众号文章批量下载**。

扫码登录公众号后台 → 枚举某个号的文章 → 批量抓成 Markdown（含图片本地化）。
也可以完全跳过登录，直接抓单篇或一份 URL 列表。

---

## 三个入口，两条链路

| 入口 | 你做什么 | 需要扫码吗 | 走哪条链路 |
|---|---|---|---|
| **E1 单链接** | 给一个文章 URL | **不需要** | L2 抓取 |
| **E2 列表** | 给一份 `url-list.json`（**可以跨公众号、混来源**） | **不需要** | L2 抓取 |
| **E3 账号** | 扫码 → 搜号 → 枚举该号文章 | **只有枚举这一段需要** | L1 枚举 → 写入 `url-list.json` → 汇入 L2 |

关键设计：**E3 不是第四条链路，而是 L2 的"喂料器"** —— 它的产物就是 E2 的输入。
扫码只为枚举；文章正文页游客可见，所以抓取链路永远不需要登录。

```
E3 账号入口 → [L1 枚举：扫码 → 搜号 → 翻页列文章]  （需要登录）
                        │ 写入 / 合并
                        ▼
                  url-list.json  ←──────── E2 列表入口
                        │
E1 单链接入口 ───────────┴──→ [L2 抓取：去重 → 渲染 → 正文 → Markdown → 图片]  （不需要登录）
                        │
                        ▼
              写入配置的输出根目录
```

---

## 安装

插件放在本仓库的 `packages/dsh-wechat-mp/`，依赖兄弟包 `spider-claw`（用 `file:` 链接，
不需要发布到 npm）。

```bash
cd /path/to/spider-claw

# 1) 先确保 spider-claw 已构建（插件消费它的 dist）
pnpm build

# 2) 装进一个 dsh profile
dsh plugin --profile wechat-mp-dev add ./packages/dsh-wechat-mp

# 3) 确认组合层里有它
dsh --profile wechat-mp-dev --dump-config | tail -5
# 应当看到：
#   # == dsh-wechat-mp
#   - id: wechat-mp
#     name: dsh-wechat-mp
```

### 本机离线开发时的额外一步

`@deepseek-ai/*` 这些包在**运行时由宿主提供**（已声明为 `peerDependencies`）。
如果本机没装 dsh 的这些包，插件加载会失败。开发期可以指向本地的 dsh 检出：

```bash
cd packages/dsh-wechat-mp
mkdir -p node_modules/@deepseek-ai
DSH=/path/to/deepseek-harness
ln -sfn "$DSH/vendor/cordis"                    node_modules/@deepseek-ai/cordis
ln -sfn "$DSH/vendor/schemastery"               node_modules/@deepseek-ai/schemastery
ln -sfn "$DSH/packages/core/tools"              node_modules/@deepseek-ai/dsh-tools
ln -sfn "$DSH/packages/jobs/jobs"               node_modules/@deepseek-ai/dsh-jobs
ln -sfn "$DSH/packages/credentials/credentials" node_modules/@deepseek-ai/dsh-credentials
ln -sfn "$DSH/packages/credentials/authorization" node_modules/@deepseek-ai/dsh-authorization
ln -sfn "$DSH/packages/client/ui-slots"         node_modules/@deepseek-ai/dsh-client-ui-slots
ln -sfn ../../..                                 node_modules/spider-claw
```

---

## 配置

在 profile 的 `cordis.yml` 里覆盖（`config:` 段）。**所有可调参数都在这里，
没有硬编码的路径。**

| 字段 | 默认 | 说明 |
|---|---|---|
| `outputRoot` | `''` | 输出根目录。**留空 = 当前工作区下的 `output/`**（默认值来自运行时环境，不是写死的绝对路径） |
| `layout` | `'flat'` | `flat`：`output/<标题>/`；`byAccountDate`：`output/<账号>/<年-月>/<年-月-日>_<标题>/` |
| `listPath` | `''` | `url-list.json` 位置。留空 = 工作区根目录下的同名文件 |
| `pageDelayMs` | `3000` | 枚举翻页间隔。**不要调低** —— 频控风险不对称 |
| `backoffFactor` / `maxBackoffMs` / `maxRetries` | `2` / `60000` / `3` | 频控退避 |
| `listPageSize` | `20` | 列文章每页条数 |
| `maxArticles` | `500` | 单次枚举的硬上限 |
| `requestTimeoutMs` | `20000` | 单请求超时 |
| `fetchTimeoutMs` | `120000` | **单篇抓取超时**。不能省 —— 浏览器被杀时底层会无限等，没有它界面会永远卡在「深度求索中」 |
| `listTimeoutMs` | `1800000` | 批量抓取的整体上限。已抓完的部分会保留，可直接再跑来续上 |
| `proxy` | `'direct'` | 抓正文的代理策略：`direct` / `env` / 代理地址 |
| `rateLimitCodes` | `[]` | **频控的 `ret` 码。默认为空是有意的**：源码里只见过 `0` 和 `200003`，凭空猜码号会把正常错误误判成频控。实测出真值后再填 |
| `fetchAfterSync` | `false` | 枚举完是否立刻抓正文 |

---

## 工具清单

### E1 单链接

- `wechat_fetch_article` —— 抓一篇，返回 Markdown 路径 + 元数据 + 内容防护判定

### E2 列表

- `wechat_fetch_list` —— 批量抓 `url-list.json`，**自动跳过已抓过的**（断点续爬）
- `wechat_list_status` —— 只看状态，不抓取

### E3 账号（需要扫码）

- `wechat_mp_authorize` —— 扫码登录（界面里会显示二维码卡片）
- `wechat_mp_search_account` —— 按昵称/微信号搜号，拿 `fakeid`
- `wechat_mp_list_articles` —— 列文章（**只有元数据**）。支持服务端关键词检索、时间区间、仅原创、按合集筛选
- `wechat_mp_sync_account` —— 枚举并写入清单（可选接着抓正文；可选后台任务）
- `wechat_mp_status` / `wechat_mp_logout`

### 输出配置

- `wechat_set_output_root` —— 改输出根目录（**界面与工具共用同一份实现**）
- `wechat_output_info` —— 看当前输出目录、清单路径、布局与限速配置（界面里有面板卡片）

---

## 典型用法

```
# 只想抓一篇文章
wechat_fetch_article("https://mp.weixin.qq.com/s/xxx")

# 想批量抓某个号
wechat_mp_authorize()                       # 扫码（界面里显示二维码）
wechat_mp_search_account("某个公众号")       # 拿 fakeid
wechat_mp_sync_account(fakeid, since="2026-01-01")   # 枚举 → 写进 url-list.json
wechat_fetch_list()                         # 抓正文 → Markdown

# 换了输出目录
wechat_set_output_root("/data/articles")
```

---

## 它做了什么"防坑"设计

这些都对应参考实现（C# 版那个工具）里已经踩过的坑，写在这里便于将来 review：

| 坑 | 这里的做法 |
|---|---|
| Cookie 两套管理，状态会漂移 | 只维护**一个**内存 jar，请求头由它派生 |
| 可变单例会话，并发时字段被清空 | 会话是**不可变对象**，失效 = 换一个 `invalid: true` 的新对象 |
| 翻页只等 100 毫秒，无退避 | 默认 3 秒 + 指数退避 + 频控单独映射（用假时钟单测验证） |
| 扫码轮询定时器可重入 | 串行 `await` 循环，不会重入 |
| 凭据缺字段被当成"有效" | 读出来显式校验，缺任一字段即视为未配置；**过期只认服务端的 `200003`**，不看本地时钟 |
| 错误被吞成空列表 | `ret != 0` 一律抛领域错误，调用方分得清"没文章"和"接口挂了" |
| 参数漏字段导致整个插件加载失败 | schema 规范化层兜底（`additionalProperties`） |
| 两个会话同时跑会互相覆盖清单状态 | `url-list.json` 的写操作走**跨进程文件锁** |
| 付费/视频类文章被当正文落盘、还标成成功 | 输出防护：清单阶段按类型排除，抓取后判试纸页 |
| 输出路径写死 | 路径解析优先级：工具参数 > 配置 > 工作区 > cwd，**默认值来自运行时环境** |

---

## 开发

```bash
cd packages/dsh-wechat-mp

pnpm test        # 127 个单测 + 集成测试（全离线）
pnpm typecheck   # tsc --noEmit
pnpm build       # 双半包：lib/index.js（Node）+ lib/client.js（浏览器）
```

### 双半包的构建契约

**Node 半**：标准 ESM，宿主模块与 `spider-claw` 都是 external。

**浏览器半**：产物必须严格是"闭包工厂"——

```js
window.__ModuleLoader__.load({ id: "dsh-wechat-mp", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// ……CJS 正文……
return module.exports; } });
```

这层壳是从官方预设 `packages/client/tsdown.client.ts` 逐字读来的。官方那个预设
**没有发布成 npm 包**（官方 cookbook 原话："没有已发布的预设暴露该包，因此本仓库之外的包
得自行复刻同样的输出格式"），所以我们用 `tsup` 复刻。

**硬约束：外部依赖只允许平台冻结的那 9 个说明符**（见 `tsup.config.ts` 的
`PLATFORM_MODULES`），其余一切必须内联 —— `require()` 一个不在宿主模块表里的包会在
运行时直接抛错。

---

## 已在真机上验证（2026-09-23）

在 `@deepseek-ai/dsh@0.1.2-rc.1`（`npx @deepseek-ai/dsh web`，<http://127.0.0.1:3080>）上端到端跑通：

| 验证项 | 结果 |
|---|---|
| 装进 profile | `dsh plugin --profile web add ./packages/dsh-wechat-mp` → 退出码 0，`bundles` 出现 `dsh-wechat-mp` |
| 插件加载 | 启动日志**零错误**；插件被 apply |
| **Node 半的工具 + 路由生效** | `GET /wechat-mp/status` → **200**，`{"phase":"idle","message":"","revision":0,"ok":true}` |
| `/wechat-mp/qr` 的空态 | → 404 + `Cache-Control: no-store`（尚未发起授权时的正确行为） |
| **浏览器半进了启动图** | `{"id":"dsh-wechat-mp","url":"/plugins/??dsh-wechat-mp/client.js&rev=…","inject":["…renderer","…ui-tool"]}` |
| **宿主会服务我们的客户端 bundle** | `GET /plugins/??dsh-wechat-mp/client.js&rev=…` → **200**，`text/javascript`，内容正是闭包工厂 |
| 热重载 | 重新构建后启动图的 `rev` 自动变化 → 改代码只需 `pnpm build` + 刷新页面 |

> 尚未验证：卡片在浏览器里**渲染出来**的样子（需要人眼看浏览器；启动图 + bundle 已服务是当前能拿到的最强证据）。

---

## ★ 接 dsh 宿主的三条硬规则（都实测踩过）

这三条是这次真机验证的核心收获，做同类插件时**必须**遵守：

**1. 读可选服务只能用 `ctx.get(name)`，绝不能用 `ctx.foo`。**

cordis 的 `Context` 是 Proxy，读一个没在 `inject` 里声明的服务会**直接抛错**
（`cannot get property "x" without inject`）。而 `apply` 里未捕获的异常会让**整个 dsh
进程起不来** —— 不是只有本插件失效。

**2. 等异步就绪的服务要用 `ctx.inject([...], cb)`，不能在 `apply` 里 `get()` 抢。**

`ctx.inject` 会挂一个带依赖的子插件，服务就绪后才调 `callback`；那时回调里可以**直接读**
那些服务。实测教训：我在 `apply` 里用 `ctx.get('webServer')` 抢，拿到的是 `undefined`
→ 静默降级成"写文件"→ 二维码路由对外表现为 404，而且**一声不响**。

**3. `output.schema` 里每个显式对象节点必须声明 `additionalProperties`。**

漏了会抛 `JsonSchemaError: unsupported JSON schema`。坑在于它是**定义时**校验的 ——
在"注册边界兜底"太晚，必须包装 `defineTool` 本身。见 `src/tools/schema.ts`。

---

## 从 WorkBuddy / 其他宿主 shell 里启动 dsh 的坑

如果从**别的 Node 宿主**（比如 WorkBuddy 的沙箱 shell）里启动 `dsh web`，会继承宿主注入的
`NODE_OPTIONS`（内含一个 broker fs shim），dsh 启动时会满屏 `write EPIPE` /
`Broker request outcome unknown` 并**直接退出**。

解法：清掉再启动。

```bash
env -u NODE_OPTIONS -u NODE_REPL_EXTERNAL_MODULE npx --yes @deepseek-ai/dsh web --no-open
```

另外，若 shell 里设了 `HTTP_PROXY`，用 curl 访问 `127.0.0.1:3080` 会被代理拦掉
（返回 502 `upstream connect failed`）。加 `--noproxy '*'` 直连。

**从你自己的终端正常启动不会有这两个问题。**

---

## 已知限制（诚实清单）

1. **`appmsgpublish` 接口的存活性尚未实测**。端点参数是从参考实现源码逐行读出来的，
   但"现在还能用吗"必须真机验证。探针已就绪：`pnpm probe:mp -- --query "<公众号>"`
   （见 `scripts/probe/README.md`）。
2. **频控的真实错误码未知**，所以 `rateLimitCodes` 默认是空的。
3. **界面的"常驻面板"还没做**。现在输出目录/状态是作为 `wechat_output_info` 的
   **工具卡片**呈现的。要变成常驻面板，需要先确认 `settings.section` 或
   `sidebar.right.pane.tab` 的声明契约，再把同一个组件注册过去。
4. **多账号未支持**（v1）。会话对象不可变，将来扩展只是多套一层 Map。

---

## 相关文档

- `docs/wechat-mp-plugin-evaluation.md` —— 完整的评估与实施方案（含对外部审阅意见的处理结果）
- `docs/wechat-mp-probe-results.md` —— P0 探针的逐项结论
- `docs/wechat-mp-plugin-evaluation.review-zcode.md` —— 外部独立审阅报告
- `scripts/probe/` —— 微信后台接口探针（P0-1 ~ P0-5）与 Camoufox 宿主内验证（P0-13）
