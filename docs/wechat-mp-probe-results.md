# P0 探针结果

> 配套文档：`docs/wechat-mp-plugin-evaluation.md`（第 15 节列了 16 项 P0）
>
> 本文件记录每一项的**当前状态**、**结论**、**证据**，以及**哪些还没做、为什么**。
> 状态分四档：`已实测` / `读源码确认` / `待你扫码` / `未开始`
>
> 首次记录：2026-09-22。探针脚本：`scripts/probe/wechat-mp-probe.ts`（用法见同目录 README）。

---

## 一、环境盘点（先记这个，它决定了什么能立刻做）

| 项 | 结果 |
|---|---|
| Node | v22.22.2 |
| `dsh` | **已安装**：`~/.nvm/versions/node/v24.11.1/bin/dsh`；数据目录 `~/.dsh/`（`profiles/`、`sessions/`、`settings.yaml`、`storages/`） |
| **dsh 源码检出** | **有**：`/Users/taurus/0-ws/00-coding-repo/llm-learning/stage-dsh-plugin-qa/deepseek-harness`，HEAD `0d1f50007f`（2026-09-15） |
| `mp.weixin.qq.com` 直连 | **可达**（HTTP 200）→ 微信侧探针**不需要代理** |
| Camoufox | `camoufox-js@0.12.0` 已在 `node_modules`；浏览器二进制 `~/Library/Caches/camoufox/Camoufox.app` 共 **611 MB** |
| 本机代理 | **不可用**：系统代理仍指向 `127.0.0.1:7897`，但该端口无监听（Clash core 在跑、监听器不在）。GitHub / 文档站全部 `SSL_ERROR_SYSCALL` |

**由此得到两条重要结论：**

1. **有了本地 dsh 检出，凡属"读规范"的 P0 都可以离线核验**，不必依赖外网。这直接改变了 P0 的可行性。
2. 唯一真正卡住的是**需要你扫码**的那几项（P0-1 ~ P0-5、P0-7）。

---

## 二、已解决

### P0-10 —— 注册键就是工具名字面量 ✅ 读源码确认

`tool.call.toolview` 的注册形态（`packages/client/ui-tool/src/client/tool/toolviews/web-row.tsx:46-48`）：

```ts
ctx.slots.inject('tool.call.toolview', function* () {
  yield ctx.slots.register({ name: 'tool.call.toolview', key: 'web_search', locale: NS }, WebRow)
  yield ctx.slots.register({ name: 'tool.call.toolview', key: 'web_fetch', locale: NS }, WebRow)
})
```

分发侧（`.../tool/ToolCallTree.tsx:46-49`）：

```tsx
renderSlot('tool.call.toolview', owner, {
  entryKey: toolName,
  fallback: <GenericToolCard {...owner} t={t} />,
})
```

**结论**：cell 的寻址键是 **`key`**，值就是 wire tool name 的字面量；没匹配上时回退到 `GenericToolCard`。所以插件的工具名必须与注册用的 `key` 完全一致。

**顺带确认了客户端插件面**（同一文件 + `src/client/apply.ts`）：

```ts
export const webToolview = { name: 'web-toolview', inject: ['slots'], apply(ctx) { ... } }
```

这就是 6.3 节那句"必须返回 cordis 插件面"的实证。

### P0-11 —— 同名注册是「替换/遮蔽」，不是硬报错 ✅ 读源码确认（**推翻我原来的假设**）

- 该槽位被声明为 **`'tool.call.toolview': { kind: 'keyed', scope: 'session' }`**（`src/client/apply.ts:38`）
- keyed cell 的既有语义（slots 参考页）：**"复用已有 cell 表示有意替换其展示"**，`priority` 是**遮蔽优先级**；硬性失败只发生在"向未声明 slot 注册"或"重复声明其他 entry 已拥有的 child"

**结论**：风险方向与我原稿写的**相反**。

| | 原稿假设 | 实际 |
|---|---|---|
| 别的插件占了同名 | 我们**装不上**（loud failure） | 我们会**静默替换**它，或**被 priority 更高者遮蔽** |

**对策**：工具名带命名空间前缀（`wechat_mp_authorize` 本来就够独特）；验收时明确确认卡片真的渲染出来了，而不是被遮蔽后看到 Generic 卡片。

### P0-15 —— 授权服务的作用域：证据强烈指向「全局单例」 🟡 读源码推断，待真机确认

`packages/credentials/authorization/src/index.ts`：

```ts
export class AuthorizationService extends Service {
  static inject = ['credentials']
  private readonly flows = new Map<CredentialKey, AuthorizationFlow>()
  private readonly running = new Map<CredentialKey, InFlight>()   // ← 在飞守卫是实例字段
  constructor(ctx: Context) { super(ctx, 'authorization') }
}
```

**推断链**：

1. 这是一个 cordis `Service`，通过 `super(ctx, 'authorization')` 注册在**某个 context** 上；
2. cordis 的服务是**每个 context 一个实例**（对照 `directoryPicker` 的文档原话："one implementation per context; loading a second throws"）；
3. 在默认组合里它注册在根 context 上 → **全局一份** → `running` 这张"在飞"表也是全局的。

**结论（倾向性）**：两个会话同时发起授权时，**第二个会拿到 `ALREADY_IN_FLIGHT` 被拒**，而不是"静默看到别人的二维码"。也就是说 **6.2 节的单例路由（`/wechat-mp/qr` 不带 ID）在默认组合下是安全的**。

**为什么还留一个"待确认"**：唯一会让它变危险的情形是 `authorization` 被放进**按 agent 隔离的 realm**（文档提到 agent preset 可以给会话定制能力集合，服务行需要 `isolate`）。授权服务是否默认隔离，我没查到。**真机一趟就能定**：开两个会话同时点授权，看第二个是被拒还是拿到了别的二维码。

### R7 / P0-9 的一部分 —— `ctx.directoryPickerController` 存在 ✅ 读源码确认

`docs/subsystems/workspace.zh.md`（本地检出）：

- 宿主侧注册表：`ctx.workspaceRegistry`
- 抽象 seam：`ctx.directoryPicker`（"one implementation per context"）
- 控制器：`ctx.directoryPickerController`，逐字签名
  - `@Remote('pick') async pick(signal): Promise<string | null>`
  - `@Remote('list') async list(path, signal): Promise<DirectoryListing>`
  - `@Remote('createDirectory') async createDirectory(path, name): Promise<string>`

**结论**：11 节的目录选择方案改为复用这套服务（`pick` 就是原生 OS 选择器）。同时**佐证了 `@Remote({ mode: 'stream' })` 这种流式通路真实存在**（同文件里就有用法）——这是 P0-14 需要的线索。

### §6.3 的构建契约 —— 已按源码修正 ✅ 读源码确认

原稿漏了"工厂必须返回 cordis 插件面"，且示例里的 cell 寻址键写成了 `id`。已按官方源码改成 `{ name, key, locale }` + 生成器形式的 `slots.inject`。详见评估文档 6.3 节。

---

## 三、待你扫码（唯一硬门槛）

这五项都是**跑一次探针就全拿到**的，脚本已经写好并做过类型检查与 `--dry-run` 冒烟测试。

| 编号 | 测什么 | 脚本怎么覆盖 |
|---|---|---|
| **P0-1** | `appmsgpublish` 那套参数**现在还有效吗** | 整条链路跑通：`getqrcode` 返回合法 PNG → 轮询到 `status=1` → `bizlogin` 取到 token → 三层嵌套解析出文章；并打印**实际字段集合** |
| **P0-2** | 频控的真实错误码与阈值 | 加 `--hammer` 连打 12 次，记录第一个非 0 的 `ret` / `err_msg`（默认不跑，会触发风控） |
| **P0-3** | `count` 上限 | 同一 `begin` 分别用 `5 / 20 / 50`，比对实际篇数 |
| **P0-4** | token 真实寿命 | 隔几天重跑，脚本会打印"距今 N 天"；被服务端拒时返回 `200003` |
| **P0-5** | `searchbiz` 条数上限 | 分别用 `count=5 / 20`，比对返回条数 |
| **P0-7** | `appmsg?action=list_ex` 与 `appmsgpublish` 的差异 | ⚠️ **脚本还没覆盖**，需要再加一个探测分支 |

**顺带会被验证的**：文档 7.2 节那张扫码状态码表（`0/1/2/3/4/5/6/其他` 与 `acct_size` 的关系）。脚本会列出**本轮实际观察到的所有状态值**，直接对照即可。

**跑法**：

```bash
pnpm probe:mp -- --query "某个公众号的昵称"
# 先看不发请求的计划：
pnpm probe:mp -- --query "..." --dry-run
```

产物在 `scripts/probe/out/`（整个目录已 gitignore）：`qrcode.png`、`session.json`（0600）、`summary.txt`（结论汇总，可整段誊进本文件）、`fixtures/`（脱敏样本，可拷进 `tests/fixtures/`）。

### ⚠️ 安全说明（必须先确认）

脚本会捕获微信后台的真实响应。约定如下：

- **token / Cookie 只在内存里流转，绝不打印到终端**（只打长度与 cookie 名字）
- 落盘分两份：`out/raw/`（**含敏感值**，仅本地排错）与 `out/fixtures/`（**脱敏后**，可入库）
- 脱敏规则：`token` / `cookie` / `nickname` / `nick_name` / `head_img` / `signature` / `alias` / `fakeid` / `cover` 等键的值整体替换；URL 只保留结构（长 ID 段换 `<ID>`，查询串只留键名）
- **`scripts/probe/out/` 已加入 `.gitignore`**，入库前请再确认一次

---

## 四、未开始 / 需要另做

| 编号 | 事项 | 为什么还没做 | 下一步 |
|---|---|---|---|
| P0-6 | 最小前端包能否被宿主加载 | 需要真机跑 dsh 并装一个双半包骨架。契约本身已读源码确认（见 P0-10/P0-11），缺的是"实测一次" | 建一个最小双半包，`dsh plugin add` 装上，看卡片是否渲染 |
| P0-8 | 树外包能否 `import '@deepseek-ai/dsh-credentials'` | 需要看 dsh 的包发布状态与 loader 解析规则 | 在本地检出里确认哪些 `@deepseek-ai/*` 已发布到 npm、以及树外包的解析路径 |
| P0-9 | 树外包能否用 `ctx.webServer`，`prefix` 路由是否与 SPA 兜底冲突 | 前半段读文档已知"具名路由开放、回退席位被 SPA 独占"；缺实测 | 在最小插件里注册 `prefix '/wechat-mp'` 并 curl |
| P0-12 | settings 子系统能否被树外包用来持久化 | 文档层面已有答案（`ctx.settings.register(ns, schema)` → 持久化的 `SettingsScope`）；缺实测 | 照 cookbook 的"新增设置卡片"做一次 |
| P0-13 | Camoufox 能否在宿主进程内跑通 | 二进制已就位，但没在"宿主进程"语境下试过 | 写一个最小脚本：`import('camoufox-js')` → 抓一篇真实文章 |
| P0-14 | 树外包能否注册 `@Remote` / 订阅流式状态 | 只确认了 `@Remote({ mode:'stream' })` 存在（workspace 页有用法），没确认树外包能否注册自己的命名空间 | 读 `packages/api/*` 与 gateway 的注册约束；或在最小插件里试 |
| P0-16 | `url-list.json` 跨会话并发写 + `listPath` 解析基准 | 属于本项目侧的行为，纯本地可测 | 开两个进程同时跑 `runList`，看状态回写是否丢失 |

---

## 五、本轮的方法学说明

- **"读源码确认" ≠ "实测"**。上面标注为读源码的那些，都是拿本地检出的真实代码当证据的；`P0-15` 因为涉及 cordis 的 context 作用域语义，只能给出**倾向性推断**，明确留了真机确认的口子。
- 本地检出是 **2026-09-15 的快照**（`0d1f50007f`）。如果宿主已升级，读源码得到的结论需要按新版本复核。
- 我**没有改动 `references/` 和这份 dsh 检出里的任何文件**，只读。
- 本机代理当前不可用，所以本轮所有"远程核验"都已改成"本地源码核验"。**代价是可能与线上版本有偏差** —— 上一条已经注明。

---

## 六、实施阶段已完成的核验（2026-09-23 追加）

插件已经建起来了（`packages/dsh-wechat-mp/`），在这个过程中把剩余几项 P0 也核掉了。

### P0-6 —— 双半包能否被宿主接受 🟢 **已在真机完全验证（2026-09-23）**

验证环境：**`@deepseek-ai/dsh@0.1.2-rc.1`**（`npx @deepseek-ai/dsh web`，`--profile web`）。

| 验证项 | 方法 | 结果 |
|---|---|---|
| 插件声明能被识别 | `dsh plugin --profile web add ./packages/dsh-wechat-mp` | ✅ 退出码 0；`dsh.profile.bundles` 变成 `["…dsh-base","…dsh-web-app","dsh-wechat-mp"]` |
| patch 层能组合 | `dsh --profile web --dump-config` | ✅ 退出码 0，末段是 `# == dsh-wechat-mp` |
| 插件能加载 | 启动日志 | ✅ **零错误**（此前有过一次"整进程崩"，见下） |
| **Node 半的工具 + 路由在真宿主里生效** | `curl /wechat-mp/status` | ✅ **200**，`{"phase":"idle","message":"","revision":0,"ok":true}` |
| `/wechat-mp/qr` 空态 | `curl -D -` | ✅ 404 + `Cache-Control: no-store`（未授权时的正确行为） |
| **浏览器半进了启动图** | 解析首屏的 `globalThis["__DSH_BOOT__"]` | ✅ `{"id":"dsh-wechat-mp","url":"/plugins/??dsh-wechat-mp/client.js&rev=…","inject":["@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-tool"]}` |
| **宿主会服务我们的客户端 bundle** | `curl` 启动图里那条真实 URL | ✅ **200**，`content-type: text/javascript`，内容正是闭包工厂外壳 |
| 热重载 | 重新构建后再看启动图 | ✅ `rev` 自动从 `94f7c816f45ce7e4-45` 变为 `44b223736986` |

**结论：外部审阅方标为"风险最高、核验最少"的那一项，现在被真机证据关掉了。**

⚠️ **仍未验证**：卡片在浏览器里**渲染出来**的样子。启动图里有它、bundle 也被正确服务，
这已是无浏览器环境能拿到的最强证据；要看实际渲染需要一个浏览器。

### P0-9 —— 插件自己的 HTTP 路由 🟢 **已在真机验证**

`ctx.webServer.register({ kind: 'exact', path: '/wechat-mp/…' })` 在真宿主里生效：
`/wechat-mp/status` 返回 200 + JSON，带 `Cache-Control: no-store`。用 **exact 而不是 prefix**
是刻意的 —— 避免和 SPA 兜底抢范围，也避免将来和别的插件前缀冲突。

---

## 七、真机验证中修掉的三个 bug（都是"看起来能跑、实际不工作"那种）

这一轮是在**用户已装好的 dsh** 上做端到端时暴露出来的，含金量比单测高：

### BUG-1：`ctx.workspaceRoot` 探测把整个 dsh 启动带崩 🔴 严重

```
Error: failed to apply loader entry wechat-mp (dsh-wechat-mp):
       cannot get property "workspaceRoot" without inject
（随后 dsh 进程直接退出）
```

**根因**：cordis 的 `Context` 是 Proxy，**读一个没在 `inject` 里声明的服务会直接抛**。
我原来写的是"试探性地读 `ctx.workspaceRoot` / `ctx.workspace` / `ctx.cwd`，谁有算谁"。

**修法**：改用 `ctx.get(name)`（缺失返回 `undefined`）。依据是官方插件
`dsh-client-ui-skill/lib/client.js` 里的 `const inputTriggers = ctx.get("inputTriggers")`。

**同时加了两道防护**：
- `apply` 外层包 try/catch —— **插件初始化失败不该拖垮宿主**（实测代价太大：整个 web 起不来）
- 新增回归测试用一个"读取未声明属性就抛错"的 Proxy 上下文（复刻真机行为）

### BUG-2：同一个坑的第二处（更隐蔽）

`session-store.ts` 里的 `readCredentials` 也在用 `ctxLike['credentials']` 属性探测。
它**被 BUG-1 的 try/catch 吞掉了**，症状变成"插件装上了但一个工具都没有" —— 比崩溃更难查。
已一并改成 `ctx.get('credentials')`。

### BUG-3：二维码路由静默没挂上（对外表现为 404）🟡

**根因**：我在 `apply` 里用 `ctx.get('webServer')` 抢服务，而**它是异步就绪的** ——
那一刻拿到 `undefined`，于是 `pickDelivery` 静默退回"写文件"方案，**一条路由都没注册**，
而且没有任何报错。

**修法**：改用 `ctx.inject(['webServer'], (injected) => { … })` —— cordis 会挂一个带依赖的
子插件，服务就绪后才执行回调。依据 cordis `Context.inject` 的实现：

```js
inject(inject, callback) { return this.plugin({ inject, apply: callback, name: callback.name }) }
```

同时把 `jobs` / `settingsScope` 改成**懒解析**（工具执行时才读，那时服务一定就绪），
并把二维码交付改成**双通道**（路由 + 落文件），任一条挂掉都还有退路。

### 另外还有两条环境层面的坑（不属于插件，但会挡住验证）

| 坑 | 现象 | 解法 |
|---|---|---|
| 从别的 Node 宿主 shell 里启动 dsh | 满屏 `write EPIPE` / `Broker request outcome unknown`，进程退出 | `env -u NODE_OPTIONS -u NODE_REPL_EXTERNAL_MODULE npx @deepseek-ai/dsh web` |
| shell 里设了 `HTTP_PROXY` | 用 curl 访问 `127.0.0.1:3080` 被代理拦成 502 `upstream connect failed` | `curl --noproxy '*'` |

### 一条版本漂移的发现

用户运行的是 **0.1.2-rc.1**，而此前我拿来读源码的本地检出是 **0.1.6-alpha.2**。
两版**契约一致**（闭包工厂格式、`tool.call.toolview` 插槽、`ctx.slots.inject/register` 形态
都对得上），但 **`dsh-client-ui-slots` 这个包在 0.1.2-rc.1 里并不存在** ——
slots 注册表被并进了别的包。

**因此把插件的 peer 依赖从"检出"重链到了"宿主自带的包"**：cordis 用 symbol/instanceof
识别服务，**两份 cordis 会导致服务解析失败**，所以必须与宿主同一份。

---

## 八、仍未验证的（截至 2026-09-23）

### P0-1 ~ P0-5、P0-7 🔴 唯一剩下的硬阻塞：需要扫码

只能你来扫。探针已就绪并且做过类型检查与 `--dry-run` 冒烟测试：

```bash
pnpm probe:mp -- --query "<你的公众号昵称>"
```

跑完把 `scripts/probe/out/summary.txt` 的内容并入第三节即可。

### P0-12 / P0-14 / P0-15 🟡 现在可以真机验了

用户的 dsh web 已经跑起来、插件也加载成功，所以这三项**不再是"卡环境"，只是还没做**：

| 项 | 怎么验 |
|---|---|
| P0-12 settings 能否被树外包持久化 | 在会话里调 `wechat_set_output_root`，看返回里的 `persisted` 是否为 `true` |
| P0-14 树外包能否注册 `@Remote` / 订阅流式状态 | 在插件里试一次流式 Remote；成功的话二维码状态可以从轮询改成订阅 |
| P0-15 授权服务是全局单例还是每会话一实例 | 开两个会话同时发起授权，看第二个是"被拒"还是"拿到别人的二维码" |

### P0-13 Camoufox 在宿主进程内 🔴 本机无法验证

沙箱内启动浏览器会被 `SIGTERM`（exit 137），加了 `dangerouslyDisableSandbox` 也一样，
与已知的 playwright-cli 限制同源。**探针脚本已就绪，只差在你自己的终端跑**：

```bash
cd /Users/taurus/0-ws/00-coding-repo/git-repo/spider-claw
./node_modules/.bin/tsx scripts/probe/l2-camoufox-host.ts
```

它会打印：导入耗时、抓取耗时、Markdown 大小、图片数量、RSS 增量、以及"有没有远程图链没本地化"。
**这一项不通过的话，L2 抓取链路在宿主进程里就不成立** —— 是除 P0-1 外最该先验的。

### P0-8 树外包 import `@deepseek-ai/dsh-credentials` 🟡 部分

已把它设成 `peerDependencies` 并把解析对齐到宿主自带的包；但**没有真机验证过凭据写入路径**
（`Context.set` / `unset` 在树外包语境下是否可用）。降级路径（自己写文件，0600）是现成的。

---

## 九、当前状态一览

| 项 | 状态 | 证据 |
|---|---|---|
| P0-1 ~ P0-5、P0-7 | 🔴 待扫码 | 探针就绪 |
| **P0-6 双半包被宿主接受** | 🟢 **真机验证** | boot graph 有 entry、bundle 200、tools/route 生效 |
| **P0-9 插件 HTTP 路由** | 🟢 **真机验证** | `/wechat-mp/status` → 200 JSON |
| P0-10 注册键 = 工具名 | 🟢 读源码确认 | `key: 'skill'` 等官方样例 |
| P0-11 同名注册语义 | 🟢 读源码确认 | keyed cell = 有意替换 + priority 遮蔽 |
| P0-12 settings 持久化 | 🟡 可验未验 | — |
| P0-13 Camoufox 宿主内 | 🔴 沙箱阻塞 | 需用户终端跑 |
| P0-14 树外包 Remote | 🟡 可验未验 | 已确认 `@Remote({mode:'stream'})` 真实存在 |
| P0-15 授权服务作用域 | 🟡 读源码推断为全局单例 | 真机两会话可定论 |
| P0-16 清单并发写 | 🟢 已复现 + 已修复 | 并发实验 + `withListLock` |
| 卡片在浏览器里的渲染 | ⚪ 未验证 | 启动图 + bundle 已服务，是无浏览器环境的最强证据 |

---

*本文件会随探针推进持续更新。跑完 `pnpm probe:mp` 之后，把 `scripts/probe/out/summary.txt` 的内容并入第三节对应行即可。*
