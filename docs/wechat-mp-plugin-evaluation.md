# 微信公众号文章批量下载：dsh 插件评估与实施方案

> 状态：**第二轮修订**。这份文档只做评估和方案设计，不含实现代码。
>
> 三个评估对象：
> - 参考实现：`references/AppWeChatArticleDownloader`，C# / .NET 8 / WinForms，22 个 `.cs` 文件，共 6027 行
> - 宿主规范：DeepSeek Harness（以下简称 dsh）的插件文档与源码
> - 要融合进来的项目：本仓库的 `spider-claw`（TypeScript，v3.0.0）
>
> 本稿已按外部独立审阅意见修订。全部 19 条发现的处理结果见附录 D。

---

## 1. 先说结论

参考实现里真正有价值的，是**"怎么发现文章"这一段的接口契约**——也就是公众号后台那几个私有接口的参数和返回结构。这部分是逆向出来的成果，自己重新摸一遍成本极高。

它的下载和导出部分不值得抄。在正文清洗、代码块还原、图片本地化这几件事上，本项目明显做得更好；而且它带着 19 处已经逐行核实的问题和死代码（其中 3 处是"方向对但症状描述过头"，见第 8 节）。

所以融合的方式应该是一句话：

> **借它的"发现"，用你的"提取"，包成 dsh 的"工具"。**

三个来源各出一份力，谁也不越界：

| 来源 | 出什么 | 不出什么 |
|---|---|---|
| C# 参考实现 | 思路和接口契约（同时它本身也是反例） | 代码实现、依赖选型、界面形态 |
| dsh 生态 | 插件的形态和骨架：工具定义方式、生命周期、配置、原生服务、前端扩展点 | 业务能力 |
| spider-claw | 能力底座和输出：反爬、正文提取、Markdown、图片本地化、断点续爬 | —— |

---

## 2. 架构定稿：三个入口，两条链路

这是最重要的一节，先看这个，后面的细节都是围绕它展开的。

### 三个入口

| 入口 | 用户做什么 | 需要扫码吗 | 走哪条链路 | 现在有没有 |
|---|---|---|---|---|
| **E1 单链接** | 给一个文章 URL | 不需要 | L2 抓取 | 已有（`spider-claw "<url>"`） |
| **E2 列表** | 给一个 `url-list.json`，里面可以混不同公众号、甚至不同来源的文章 | 不需要 | L2 抓取 | 已有（`spider-claw --list`） |
| **E3 账号** | 扫码 → 搜公众号 → 枚举这个号下的文章 | **只有枚举这一段需要** | L1 枚举 → 写入 `url-list.json` → 汇入 L2 | **插件要新增的全部内容** |

### 两条链路

**L1 枚举链路**（插件新增，需要登录）：扫码授权 → 搜号拿到 fakeid → 翻页列出文章 → 得到一份带标题、链接、时间的清单。

**L2 抓取链路**（现成的，一行都不用改）：读 URL 列表 → 去重 → 用 Camoufox 渲染页面 → 提取正文 → 转成 Markdown → 图片下载到本地。

### 为什么不是"三条链路"

因为 E1、E2、E3 的下游完全一样，都是"URL 变 Markdown"。只有 E3 多了一段上游（登录 + 枚举）。所以正确的形状是 **3 个入口 + 2 条链路**，而不是 3 条平行的链路。

更关键的一点：**E3 的产物就是 E2 的输入**。它不是一个新链路，而是给 L2 喂料的。想清楚这一点，插件的工作量就只剩"L1 枚举链路"这一块了。

```
E3 账号入口 ──→ [L1 枚举链路]  扫码授权 → 搜号 → 翻页列文章
                      │                （需要登录）
                      │ 写入 / 合并
                      ▼
                url-list.json  ←────────────── E2 列表入口
                      │
E1 单链接入口 ─────────┴──→ [L2 抓取链路]  去重 → 渲染 → 正文 → Markdown → 图片
                                  （不需要登录*）
                      │
                      ▼
             写入用户指定的输出目录
```

### 四条设计结论

**第一，登录被限制在 L1 里面。** 文章正文页 `/s/xxx` 游客就能看，所以 L2 不依赖登录态。E1 和 E2 不会让你扫码。这也顺带解释了为什么 E2 可以跨公众号——**它根本不关心文章属于谁**。

> **\* 但这个"不需要登录"有两个例外，必须设防**（详见 5.1 节）：付费订阅文章（`is_pay_subscribe`）和视频/图片类文章（`item_show_type` 62/66）。这两类都不靠登录解决，但按现在的设计会让 L2 把**试读片段或残缺内容当成正文成功落盘**，污染 `url-list.json` 的 `done` 状态，进而破坏"断点续爬"这个卖点。

**第二，`url-list.json` 是唯一的交接点。** 枚举和抓取之间只通过这个文件通信。E3 重复跑只会追加新条目（按 `(来源, 文章ID)` 去重），不会重复抓。E2 中途断了可以继续。

> **但跨会话并发写是个真问题**（详见 15 节 P0-16）：`runList` 每处理一条就整文件回写，两个 dsh 会话同时跑就会互相覆盖。插件侧需要一个进程内互斥，或者在文档里明确"同一时刻只允许一个抓取会话"。

**第三，"喂完就走"是可以的。** E3 可以只产出清单，让用户之后自己跑 E2；也可以紧接着触发抓取。这个做成一个参数 `fetchAfterSync`，默认关闭——把"枚举"和"抓取"两个耗时动作分开，便于中断和检查。

**第四，三个入口共用一套输出配置。** 输出目录、目录结构、去重策略都是共用的，不会出现"E3 存的地方和 E2 不一样"这种分裂。

### 已经定下来的决定

| 事项 | 结论 |
|---|---|
| 使用方式 | 两种并存：账号维度（要扫码）和列表维度（不用扫码，可跨号）。单链接作为第三种入口一并暴露 |
| 输出目录 | 插件提供界面入口，可以交互选择目录，也可以用可配置的默认值，**不允许写死路径**（见第 11 节） |
| 架构调整 | 需要。从"一条流水线"改成"三个入口 + 两条链路" |
| 二维码 | 可以画进 dsh 的网页界面（见 6.2 节），代价是要多写一份前端代码 |
| 凭据存储 | 优先用 dsh 自带的凭据服务，自己写文件只作为降级方案 |

---

## 3. 扫码登录能做到什么，做不到什么

这一节决定了整个插件的形状，必须先讲清楚。

**扫码登录的是"你自己"的后台账号。** 你用的还是个人微信扫，但你的微信必须是某个公众号的管理员或者运营者。扫完之后拿到的是公众号后台的登录凭证（URL 里那一串 `token=1862390040`，加上后台的会话 Cookie），**不是个人微信的通行证**。

**拿到凭证之后，你可以列出任意公众号的文章清单。** 这不是越权，而是微信自己开放的能力。微信允许所有公众号在图文里插入"全平台任意已群发文章"的链接（后台的「超链接 → 查找文章 → 搜索其他公众号」）。参考实现只是把这个功能的内部接口复刻了一遍。

> 关于开放时间：公开报道说这项能力是 2017 年 6 月 6 日随微信一次更新放开的（例如网易转载的《微信公众号内可以跳转任意文章了》一文提到"苹果 WWDC 2017 年召开……6 月 6 日凌晨"）。我只有这一层二手出处，**没找到微信官方公告**，所以日期本身存疑。不过这个日期不承重——承重的是下面那几个接口本身。

**但清单里只有元数据，没有正文。** 返回的是标题、永久链接、发布时间、摘要、封面图这些字段。正文还是得逐篇打开 `/s/xxx` 页面去抓——**而这正好是本项目的强项**。

```
扫码登录后台  ──→  拿到 token + Cookie
                     │
                     ├──→ 能列出任意公众号的文章清单（元数据）
                     │
                     └──→ 拿不到正文
                            （正文仍需逐篇抓 /s 页面 → 这是 spider-claw 的活）
```

**一个硬前提**：必须有一个自己管理的公众号。没有的话，这条路走不通。

---

## 4. 参考实现（C# 项目）的结构

```
AppWeChatArticleDownloader.sln  (.NET 8)
│
├── .Models/            纯数据对象
│                       ArticleInfo、OfficialAccountInfo、LoginCredential、
│                       DownloadOptions、ArticleQueryOptions、DownloadTaskInfo、
│                       ApiResponseModels
│
├── .Infrastructure/
│   ├── Http/WeChatMpService.cs         545 行  登录 4 步 + 搜索 + 列文章 + 下载
│   └── Storage/LocalStorageService.cs  217 行  存到 %LocalAppData%
│
├── .Core/
│   ├── OfficialAccounts/OfficialAccountService.cs   132 行  搜号、确认当前账号
│   ├── Articles/ArticleService.cs                   275 行  分页加载、解析嵌套 JSON、筛选
│   ├── Downloads/DownloadService.cs                 383 行  并发控制、任务状态
│   ├── Exporters/ArticleExporter.cs                 612 行  导出 HTML/TXT/PDF + 下载图片
│   ├── Caching/CacheService.cs                      115 行  ← 整个类没人调用
│   ├── Configuration/ConfigurationService.cs        169 行  读写配置文件
│   └── Logging/AppLogger*.cs
│
└── .WinForms/          FrmLogin 扫码轮询 252 行 + FrmMain 主界面 1092 行
```

依赖里有 `PuppeteerSharp 19.0.2`，但引入之后**没有真正用上**（它生成 PDF 用的是 Chrome 命令行）。

---

## 5. 本项目现在有什么

### 5.1 已有能力

| 已有能力 | 在哪 |
|---|---|
| 单篇文章抓取（Camoufox 反指纹浏览器 → 等 `#js_content` → cheerio 解析） | `src/sources/wechat.ts:229-295` |
| 元数据提取（标题、公众号名、发布时间，时间藏在页面脚本的 `create_time` 里） | `src/sources/wechat.ts:102-132` |
| 代码块还原（微信的 `.code-snippet__fix` 转成占位符，最后还原成围栏代码块） | `src/sources/wechat.ts:168-186` |
| 图片并发下载（保持顺序）、按 `wx_fmt` 判断扩展名、带 Referer 过防盗链 | `src/core/images.ts`、`wechat.ts:282-285` |
| 批量续爬 + 按 `(来源, 文章ID)` 去重 | `src/cli.ts:73-144`、`src/core/urlList.ts` |
| 从站点地图批量发现文章（**目前只有博客**） | `src/cli.ts:161-189`、`src/sources/blog.ts` |
| 库入口（`WechatSource`、`fetchWechatArticle`、`loadUrlList`、`saveUrlList`） | `src/index.ts` |

**缺口只有一个**：博客有"从站点地图自动发现文章列表"的能力（`--from-sitemap`），微信这边没有对应物。插件要补的就是这一环。

### 5.2 「不需要登录」的两个例外（必须设防）

这两类文章**不靠登录解决**（登录了后台也只能拿到试读页，正文在单独的付费接口里），但按现在的设计会让 L2 静默产出错误结果。

| 例外 | 依据 | 后果 |
|---|---|---|
| **付费订阅文章** | `ArticleInfo.cs:140-141` 有 `is_pay_subscribe` 字段——清单里本来就有这类条目 | 游客只能看到试读片段。轻则 `#js_content` 缺失、抛"未能提取到正文内容"；重则**把试读片段当成正文成功落盘**，还把 `status` 标成 `done`。后者比失败更糟，因为它污染了断点续爬的状态 |
| **视频 / 图片类文章** | `item_show_type`：62 是视频、66 是图片（`ArticleInfo.cs:122-135`） | `wechat.ts:217-221` 的注释自己承认结构不同时 `#js_content` 会等超时。这类文章要么失败，要么产出垃圾 Markdown |

**要补的防护（成本都很低）**：

1. E3 的 `output.schema` 里**加上 `isPaySubscribe` 和 `itemShowType`**（现在漏了 `isPaySubscribe`）；
2. L1 落清单时按类型/付费标记**分流或标记**，不要无差别写进 `pending`；
3. L2 侧加一个**试读页检测**——正文长度异常短、或者命中"购买/订阅"类关键词时，不要标 `done`。

---

## 6. dsh 插件能做到什么

下面这些结论来自 dsh 的官方文档和官方源码。

### 6.1 基础能力

| 事项 | 结论 |
|---|---|
| 插件长什么样 | 一个导出 `apply(ctx)` 函数的 TypeScript 模块 |
| 怎么加工具 | `import { defineTool } from '@deepseek-ai/dsh-tools'`，声明 `inject = ['tools']`，然后 `ctx.tools.register(...)` |
| 工具定义 | `{ name, description, parameters, output: { schema, render }, execute }`，`execute` 可以是 async |
| 参数校验 | 在 `parameters` 里声明类型和是否必填，框架会在执行前校验，并且自动推导出 `args` 的类型 |
| 返回值 | `execute` 返回的是**规范 JSON 值**（符合 `output.schema`），不要返回内容块。面向模型看的文字由 `output.render` 负责生成 |
| 错误处理 | 业务上"结果不理想"（比如文章已删除）写进返回值；基础设施故障直接抛异常 |
| 取消 | 前台的 `execute` 必须响应 `exec.signal` |
| **长任务** | `ctx.jobs.start({ kind, label, owner, run })`。**`run()` 不接收任何参数**，它**同步返回**一组钩子 `JobHooks = { cancel(reason?), done, readOutput?() }`。取消由任务拥有者调 `ctx.jobs.kill(id, caller?, reason?)` 发起，运行时再转发给生产方自己的 `cancel`。**没有任何 per-job 的 AbortSignal 被传进来** |
| 配置 | 导出一个 `Config` 类型和同名的 Schemastery schema，默认值写在 schema 里，用户在 `cordis.yml` 的 `config:` 里覆盖 |
| 凭据 | `ctx.credentials` 提供两个键空间：`CredentialRef`（环境变量名形式的引用）和 `CredentialKey`（插件为某个 id 持有的凭据记录）。记录的写路径只有 `modifyRecord` 一个（带锁的读-改-写） |
| 交互式授权 | `ctx.authorization.registerFlow(...)` 注册一个授权流程，`begin(...)` 发起。**同一个 key 同时只允许一次尝试**，重复调用会被拒（`ALREADY_IN_FLIGHT`） |
| 打包 | `package.json` 里写 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，patch 文件按**包名**引用插件行。官方只在示例里用了 `dsh-` 前缀的包名，**并没有写成"约定"** |
| 装插件 | `dsh plugin --profile <名字> add ./包目录`，或者从 npm、git、tarball 安装 |
| 要不要拆包 | 官方建议按"定义 / 提供方 / 消费方"三个角色分，但**明确说了不要预防性拆分**——只有角色需要独立演进或替换时才拆 |

### 6.2 能不能把二维码画到网页上？能

**这里我要先更正一个错误。** 这份文档初稿的结论是"dsh 的授权接口没有图像通道，所以二维码只能存成文件让用户打开"。这个结论只对了一半。

**对的那一半**：`ctx.authorization` 这套授权交互接口确实没有图像通道。它的通知结构只有 `message`、`url`、`code` 三个字段，提问结构也只有文本、密码、下拉选择三种形态。

**但我漏掉的那一半很关键**：dsh 的网页界面本身就是一套插件系统，第三方包可以往里加 React 组件。相关文档和源码都查过，确认了四件事：

| 结论 | 出处 |
|---|---|
| 包只要在 `package.json` 里声明 `dsh.client`（`platform: 'web'`），并且用 `exports["./client"]` 导出一份构建好的浏览器代码，就会被宿主扫描进网页插件表 | client-modules 参考页 |
| 这个扫描是按"加载器来源"增量做的，**支持第三方包（树外包）加入** | 同上 |
| 插件用 `ctx.slots.inject()` 加 `ctx.slots.register()` 往具名插槽里放 React 组件。插槽列表里已经有 **`tool.call.toolview`**（按工具名分发的卡片位置），还有右侧栏面板、浮层等 | slots 参考页 |
| 插件可以用 `ctx.webServer.register({ kind: 'exact' 或 'prefix', path, handler })` 注册自己的 HTTP 路由，返回一个释放函数 | web-server 参考页 |

**不过有一个限制必须绕开。** 注册到 `tool.call.toolview` 的组件，在**工具还在执行中的时候**只能拿到工具名、原始参数、会话工作目录这几样东西。结果内容、错误、元数据都要等工具执行完、结果事件到达之后才能拿到。而且文档明确写了，注册方**不依赖** `presentCall` / `presentResult`。**就"工具事件"这一条通道而言，确实没有"执行到一半把数据推给卡片"的机制。**

> **但"只能自己去拉"这个全称判断说过头了，这里要降级。** dsh 文档里还记载着另外三条宿主 → 浏览器的推送通路：
>
> - `@Remote({ mode: 'stream' })` 流式方法，供前端订阅（web-client / API Gateway 页）
> - 自定义会话事件 + `ConversationNodeDefinition`（conversation 页有完整示例）
> - `ctx.resources.register` 帧流（client-resources 页）
>
> 物理层是 WebSocket，会话的瞬态 control stream 已经在传 queue / job / projection 的更新。理论上二维码卡片可以订阅宿主的流式状态，而不是 HTTP 轮询。
>
> **真正的开放问题是：这些通路对树外包开不开放，没有任何文档背书。** 所以正确表述是"轮询是**有文档支撑**的做法"，而不是"推送**不可能**"。这一条已列为 P0-14。

二维码恰恰是"执行到一半才有"的数据。所以卡片**用一个有文档支撑的办法把它拉过来：把二维码当静态资源，由插件自己的路由提供；卡片里只放一个 `<img>`。**

```
宿主侧（Node）
  ├─ 跑登录状态机，拿到二维码图片
  └─ 注册同源路由：ctx.webServer.register({ kind: 'prefix', path: '/wechat-mp' })
       GET /wechat-mp/qr      → 当前二维码图片
       GET /wechat-mp/status  → { phase, message }  当前扫码状态

浏览器侧（React 卡片）
  └─ <img src="/wechat-mp/qr?ts=<时间戳>" />  +  每 1.5 秒拉一次 /wechat-mp/status 刷新提示
```

这个设计有三点契合：

**同源，不需要处理跨域。** 网页界面和插件路由都在同一个 `ctx.webServer` 上（默认监听 `127.0.0.1`），`<img src="/wechat-mp/qr">` 直接就能用。

**轮询成本可以忽略。** 本机回环地址，1.5 秒一次状态查询，比引入流式订阅简单得多。

**两个实现细节必须写对，否则会出 bug：**

1. **图片要带 cache-busting。** 二维码过期重取后 URL 不变，浏览器可能继续显示旧图。用 `?ts=<时间戳>` 或者由 status 响应驱动 `img` 重新加载。
2. **单例路由在多会话下不一定安全。** `ALREADY_IN_FLIGHT` 的守卫范围是 authorization 服务实例上的 key；但**授权服务是全局单例还是每会话一实例，文档和源码都没能确认**。如果是后者，两个会话同时发起授权就会有两个在飞的二维码，而 `/wechat-mp/qr` 只服务"最近一个"——A 会话的页面会显示 B 会话的二维码，扫完登进谁的号全看扫描顺序。**这是必须实测的点，已列为 P0-15。**

**结论**：二维码交付最合适的做法，既不是"写文件"也不是"另起一个服务"，而是"**插件自己开一条同源路由 + 一个前端卡片**"。等 P0-14 出结果后，如果树外包能用流式通路，可以把轮询换成订阅。

**代价也要说清楚**：这条路让插件从一个 Node 包变成**双半包**（Node 一半 + 浏览器一半），多出来一堆活：写 React 组件、搭一份浏览器代码的构建链、声明 `dsh.client` 和 `exports["./client"]`、遵守跨包只能 `import type` 的约束、还要对齐平台的 React 版本。**这是整个方案里新增工作量最大的一块。**

**降级方案保留**：把二维码交付抽成一个 `QrDelivery` 接口，先实现"写图片到工作区"这个不需要前端的后端。将来前端构建或插槽注册出问题时，插件照样能用。

### 6.3 浏览器那一半的构建契约

这部分已经查到源码级别。**但初稿漏了最关键的一条，这里补上。**

**第一，工厂里必须返回一个 cordis 插件面。** 这是初稿完全没提、缺了就整条路走不通的一条。浏览器模块的工厂返回值不是随便什么对象，而是一个插件：要导出 `inject` 和 `apply(ctx)`。而**要拿到 `ctx.slots`，必须声明 `inject: ['slots']`**：

```js
window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

  const inject = ['slots']            // ← 少了这个，context 里就没有 ctx.slots
  function apply(ctx) {
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register(
        { name: 'tool.call.toolview', key: 'wechat_mp_authorize', locale: NS },
        QrCard,
      )
    })
  }
  module.exports = { inject, apply }

return module.exports; } });
```

**上面这段的每个细节都是照着官方源码核过的**（第二轮补验，依据 `packages/client/ui-tool/src/client/tool/toolviews/web-row.tsx` 与 `.../src/client/apply.ts`）：

- 插件面就是 `{ name?, inject: ['slots'], apply(ctx) }`
- 注册是的形态是 `ctx.slots.register({ name: 'tool.call.toolview', key: '<工具名>', locale: NS }, Component)`
- 这颗 cell 的寻址键是 **`key`**（不是 `id`）——因为 `tool.call.toolview` 被声明为 **`{ kind: 'keyed', scope: 'session' }`**（`apply.ts:38`），分发时由 `renderSlot('tool.call.toolview', owner, { entryKey: toolName, fallback: <GenericToolCard/> })` 传入工具名
- **`key` 就是 wire tool name 的字面量**：官方自己的 `web_search` / `web_fetch` 就是这么注册的。所以我们的工具名必须和注册用的 key 完全一致
- `slots.inject` 的第二个参数是**生成器函数**，用 `yield` 交出注册结果（cordis 的副作用惯例），不是普通回调

> **顺带解决了一个我此前判定"无法判定"的问题（P0-11）**：`tool.call.toolview` 是 **keyed** cell，而 keyed cell 的语义是"**复用已有 key 表示有意替换其展示**，`priority` 是遮蔽优先级"——**不是硬报错**。所以真正的风险方向是：我们的卡片可能**静默替换掉**别人对同名工具的注册，或者**被 priority 更高的一方遮蔽**。对策是工具名带命名空间前缀（`wechat_mp_*` 本来就够独特），并在验收时确认卡片确实渲染出来了。

**第二，产物形态**是一个"闭包工厂"文件，上面那层壳属实：

- 官方预设文件是 `packages/client/tsdown.client.ts`，用 tsdown（底层是 rolldown），参数是 `format: 'cjs'`、`platform: 'browser'`、`outDir: 'lib'`、入口文件名固定为 `client.js`，必须带 sourcemap。
- 这个预设有两个麻烦：没有发布成 npm 包，而且 import 了仓库内部的模块。但它做的事很少——加一个头、加一个尾、配一份外部依赖白名单。官方 cookbook 甚至直接说了"**没有已发布的预设暴露该包，因此本仓库之外的包得自行复刻同样的输出格式**"。所以照着自己写就行。

**第三，外部依赖白名单是 9 项，而且不是"固定"的。**

初稿写成"固定的 10 项清单"，两个说法都不对。

准确的 9 项在 `packages/client/web/src/platform.ts` 里（初稿列出的名字一字不差，只是数错了）：

`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`

（同文件里的 `PRELOADED_CLIENT_EXTERNALS` 是空数组，所以别把它算进去。）

而且"固定"不成立——`dsh.client.external` 可以在包自己的 manifest 里声明额外要共享的模块，运行时的 `require` 解析域也不止这份种子表（已物化的其他客户端包也能被 require）。**大方向是对的：白名单外的东西应该打包进去，否则运行时会抛错；但边界是可扩展的。**

**第四，样式怎么办。** 官方预设用 lightningcss 在打包时编译 `.module.css` 并在工厂执行时注入 `<style>`。我们的卡片只有一点样式，**不必走这条链**——直接在组件里用内联样式，或者在 `apply` 里创建并插入一个 `<style>` 标签就够了。这是初稿漏掉的点，但代价很低，不构成阻塞。

---

## 7. 值得借鉴的地方

### 7.1 先看思路层面（比字段名更值钱）

文档初版只列了接口细节，漏掉了参考实现真正的产品级优点。这一节补上。

**1. "账号维度"和"URL 维度"是两种正交的能力。** 整个 C# 工具是围绕 `fakeid`（公众号唯一标识）组织起来的：选中一个号，然后在这个号的文章里翻页。这正是第 2 节里的两个入口。

**2. 四层分层结构。** Models（纯数据）/ Infrastructure（HTTP、存储）/ Core（业务）/ WinForms（界面）。

> 修正：初稿说"Core 只依赖前两层的抽象"，这句话不成立——Core 层直接依赖具体类，没有任何接口抽象（`ArticleService` 的构造函数收 `WeChatMpService`、`LocalStorageService`；`DownloadService` 直接持有 `ArticleExporter`）。所以它只有"分层的意识"，没有"面向抽象编程"的实践。借鉴价值要打折扣：分层方式可以参考，但别把它当成依赖倒置的范例。

**3. 两套状态枚举，设计得挺细。** 这里初稿搞混了，需要分清：

- **文章级** `DownloadStatus`（`ArticleInfo.cs:231-272`）共 **8** 个值：未下载 / 等待中 / 下载中 / 导出中 / 成功 / 失败 / 已跳过 / 已取消。其中"已跳过"和"已取消"是**独立状态**，没有和"失败"混在一起——这个区分很实用，映射到 `url-list.json` 的 `status` 时应该保留。
- **任务级** `TaskStatus`（`DownloadTaskInfo.cs:129-165`）是另一个枚举，共 **7** 个值：待开始 / 运行中 / 已暂停 / 已取消 / 已完成 / **部分失败** / 异常终止。

有些讽刺的是，"部分失败"（`PartialFailed`）正是第 8 节 A7 里被无条件覆盖掉的那个状态。

**4. 六个筛选维度是产品级思考，不是接口细节。** 标题关键词、作者、时间区间、是否原创、所属合集、下载状态。其中"时间区间"是**做增量同步的关键**——只取上次同步之后的新文章。

**5. 元数据和正文分开存。** 除了正文，还单独写一份 `metadata.json`，里面有标题、作者、时间、链接、封面、摘要、是否原创、所属合集、文章类型。这样做的好处是下游（比如做 RAG 检索、建索引）不用去解析 Markdown 就能拿到结构化信息。

**6. 按日期分层的目录结构。** `<账号名>/<年-月>/<年-月-日>_<标题前50字>/`。这是归档友好的组织方式，值得作为可选的目录结构模式。

**7. 配置全部对象化。** `DownloadOptions` 把路径、并发数、重试次数、请求间隔、是否跳过已存在文件、导出哪些格式，全都做成了可配置项，界面上也有对应的设置面板。这个思路和 dsh 自己强调的"**凡是不同部署可能采用不同值的参数，都必须做成配置项**"完全一致。

**从第 1 条能得出一个关键结论**：参考实现只能做账号维度，因为它没有"URL 列表"这一层。**而我们多了一层 `url-list.json`，就把"枚举"和"抓取"解耦开了**——于是 E3 变成了 E2 的喂料器，登录被关在 L1 里面，L2 不依赖登录态。这是我们相对参考实现的结构性优势，不是实现细节。

### 7.2 接口契约（这部分照实复刻）

这是参考实现最值钱的部分。下面这些都需要照原样实现，因为它们是逆向出来的事实。

**搜索公众号**

```
GET https://mp.weixin.qq.com/cgi-bin/searchbiz
  ?action=search_biz&begin=0&count=5&query=<昵称或微信号>
  &token=<token>&lang=zh_CN&f=json&ajax=1

返回：{ list: [{ nickname, fakeid, alias, round_head_img, signature, service_type }] }
```

`fakeid` 是公众号的唯一标识，后面列文章要用它。出处：`WeChatMpService.cs:364-388`。

**列文章**

```
GET https://mp.weixin.qq.com/cgi-bin/appmsgpublish
  ?sub=list                  # 带关键词搜索时改成 search
  &search_field=null         # search 模式下改成 7
  &begin=<从第几条开始>
  &count=<每页条数>
  &query=<关键词>
  &fakeid=<公众号标识>
  &type=101_1
  &free_publish_type=1
  &sub_action=list_ex
  &token=<token>&lang=zh_CN&f=json&ajax=1

请求头：Cookie（后台会话）、Referer 和 Origin 都是 https://mp.weixin.qq.com
```

> 注意：配套的那篇文章里写的端点是 `appmsg?action=list_ex`，和源码里实际用的 `appmsgpublish` **不是同一条**，返回结构也不一样。以源码为准。

出处：整个方法体在 `WeChatMpService.cs:425-487`（初稿各处标注了这个方法的不同片段，这里统一成方法范围）。

**返回结构的解析链**。这里有个坑：响应里嵌了三层 JSON，而且中间两层都是**被转义过的字符串**，需要再解析一次。

```
响应 JSON
└── publish_page          ← 这是一个字符串，还要再 JSON.parse 一次
    └── publish_list: [{ publish_type, publish_info }]
        └── publish_info  ← 这也是字符串，还要再 parse 一次
            └── { appmsgex: [ 文章对象... ] }
```

相关的类型定义在 `ApiResponseModels.cs:41-81`。出处：`ArticleService.cs:128-154`。

**文章的字段全集**（`ArticleInfo.cs:14-153`）

`aid`、`appmsgid`、`title`、`link`、`author_name`、`create_time`、`update_time`、`publish_time`、`digest`、`cover`、`pic_cdn_url_235_1`、`pic_cdn_url_16_9`、`copyright_stat`、`copyright_type`、`item_show_type`、`is_pay_subscribe`、`is_deleted`、`appmsg_album_infos[]`

其中四组字段特别有用：

- `publish_time` 可能为 0，这时应该回退到 `update_time`（`ArticleInfo.cs:75`）
- `is_deleted` 表示文章已删除，应该跳过
- `item_show_type` 表示文章类型：10 是图文，66 是图片，62 是视频 → **需要分流，见 5.2 节**
- `is_pay_subscribe` 表示付费订阅 → **需要防护，见 5.2 节**

**登录相关的端点**（完整参数见附录 A）

四步：`bizlogin?action=startlogin` 开会话 → `scanloginqrcode?action=getqrcode` 拿二维码 → `scanloginqrcode?action=ask` 轮询 → `bizlogin?action=login` 确认登录并拿 token。另有 `account/getprofile` 拿昵称头像。

**扫码状态码的含义**

初稿只列了 5 个值还自称"比那篇文章更完整"，实际源码里的分支更多（`FrmLogin.cs:118-163`）：

| 值 | 含义 | 该怎么处理 |
|---|---|---|
| 0 | 等待扫描 | 继续等 |
| **2 或 3** | **二维码过期**（初稿把 2 漏了） | 重新取二维码，**不是重开会话** |
| 4 或 6 | 已扫码 | 还要看 `acctSize`：`>= 1` 提示"请在手机上确认"；否则提示"没有可用账号" |
| 1 | 已确认 | 进入正式登录 |
| **5** | **账号未绑定邮箱**（初稿完全没提） | 独立分支，**要终止轮询**并报错 |
| 其他 | 未知 | 有 `errMsg` 就把它显示出来 |

漏掉 2 和 5 意味着：插件真的收到 `status=2` 时会落进未处理分支，既不刷新也不报错。

**登录失效的统一信号**：返回的 `ret` 等于 `200003`（`WeChatMpService.cs:403-408` 和 `:470-475`）。这个要在所有接口调用里统一识别，不能等用户报错才发现掉线了。

### 7.3 值得保留思路，但实现要重做

| 事项 | 出处 | 为什么只借思路 |
|---|---|---|
| 文章列表本地缓存 | `ArticleService.cs:181-209` | 缓存没有有效期。`CacheService.IsCacheValid()` 虽然定义了 24 小时有效期，但**从来没有被调用过**（`CacheService.cs:63`，全仓找不到调用点） |
| 增量跳过 | `DownloadService.cs:181-193` | 只检查 `index.html` 文件是否存在，比本项目 `url-list.json` 里的 `status` 弱 |
| 并发下载 | `DownloadService.cs:118-132` | 用 `SemaphoreSlim` 限流，但没有重试、没有退避，延时还是硬编码的 |
| 文件名净化 | `DownloadService.cs:361-382` | 思路对（禁掉 `#`、`%` 这些字符），但没考虑 Windows 保留名，也没限制账号名长度 |
| 图片 `data-src` 转 `src` | `ArticleExporter.cs:550-573` | 逻辑挺细致（避免把 `data-src` 误判成 `src`），但它用正则改 HTML，我们用 cheerio 不需要 |

### 7.4 两个"配置项是摆设"的坑

**第一个：延时是写死的。**

```csharp
// DownloadService.cs:241  实际生效的是这句
await Task.Delay(CurrentTask!.Concurrency > 1 ? 100 : 500, cancellationToken);

// FrmMain.cs:645  翻页间隔
await Task.Delay(100);
```

而 `DownloadOptions.RequestInterval`（默认 500）虽然绑到了界面上的数字框，也写进了配置文件，但**全仓没有任何地方读它**。我们借鉴的时候，必须把间隔做成真正生效的可配置项。

**第二个：`RetryCount` 同样是装饰品。**

`RetryCount`（默认 3）只被赋给了一个用于展示的任务对象（`DownloadService.cs:102`），**下载流程里没有任何重试逻辑**。重试得靠用户手动点界面上那个"重试失败任务"按钮（`FrmMain.cs:774`）。

---

## 8. 不值得借鉴的地方

这一节是评估的主要产出之一，目的是别把对方的技术债一起搬过来。

### 8.1 架构级问题（7 处）

> 其中 A1、A2、A5 三条已按外部审阅意见下调严重程度——它们描述的**方向**是对的，但**症状**是我照直觉补出来的，经不起逐行核验。这里如实改成准确的表述。

**A1：Cookie 管了两遍。** 一边让 `HttpClientHandler` 用 `CookieContainer` 自动收管 Cookie，另一边又在每个请求里手动加 `request.Headers.Add("Cookie", _cookie)`（`WeChatMpService.cs:29-35` 加上 `:309`、`:394`、`:461`）。

核对下来是：.NET 8 会把手动 Cookie 头和容器里的 Cookie **合并发送**，所以"同一请求带两份 Cookie"属实。但"会导致刚登录就提示失效"这个症状**推不出来**——`BizLoginAsync` 在登录成功那一刻先快照容器（`:247`）再读取（`:272`），**两份内容按构造就是一致的**；之后是否漂移，取决于微信后台会不会在会话中途下发 `Set-Cookie`，以及服务端怎么处理重名 Cookie，这两点都没有证据（而且这个工具显然是能用的，说明重复通常被容忍）。

**准确的说法：这是真实的坏味道加条件性风险，不是既有故障。**

我们的做法：只用一种方式管理 Cookie，不手动拼 header。

**A2：会话状态是可变的单例。** `_token` 和 `_cookie` 是 `WeChatMpService` 的实例字段，而且在业务方法里被直接置空（`:20-21`、`:403-408`、`:470-475`）。

核对下来是：**全仓读 `_token` 的只有搜索和列文章两条路径**；下载走 `DownloadArticleHtmlAsync` / `DownloadResourceAsync`，它们只带 UA 和 Referer，**根本不读 `_token`**（`WeChatMpService.cs:496-537`）。而且在这套 WinForms 里，下载的输入来自已经加载完的列表，两者不并行。所以**我描述的竞态在这个代码库里没有触发路径，是我构造出来的**。

不过可变单例会话本身仍是值得避免的设计——一旦将来列表刷新和下载并行（我们的插件就会），它会真的触发。

我们的做法：把会话做成**不可变对象，整体替换**，永远不原地清空字段。

**A3：完全没有限速。** 翻页全量加载时只等 100 毫秒（`FrmMain.cs:633-646`），既没有退避也没有识别频控错误。而 `appmsgpublish` 恰好是风控最严的接口，很容易触发"操作过于频繁"，严重时可能牵连账号。

我们的做法：翻页间隔做成可配置（默认不小于 3 秒），加上指数退避，频控错误单独映射处理。

**A4：轮询用的定时器可以重入。** 代码是 `_pollTimer.Tick += async (s, e) => await CheckScanStatusAsync()`（`FrmLogin.cs:96-99`），回调里没有先停掉定时器。如果上一次请求还没返回，下一次 Tick 就并发进来了，状态字段互相覆盖。

我们的做法：用递归 `setTimeout` 加一个"在飞"标志位。

**A5：过期判断完全依赖本地时钟，而且缺字段时会"反向续命"。**

初稿说"缺 `expireTime` 字段会反序列化成 `0001-01-01`，于是永远判过期"——**这是错的**。`ExpireTime` 是**属性初始化器**（`LoginCredential.cs:44-45`）：

```csharp
[JsonPropertyName("expireTime")]
public DateTime ExpireTime { get; set; } = DateTime.Now.AddDays(7);
```

System.Text.Json 反序列化时先用无参构造函数建对象（初始化器这时执行），**只覆盖 JSON 里存在的属性**。所以字段缺失时保留的是 `Now+7`，`IsValid`（`:51`）为真，结果与初稿断言**正好相反**：老文件会被**续命 7 天**，永远不会因为本地时间而失效。

**这仍然是个值得修的问题，只是症状不同**：凭证的有效性完全由一个硬编码的本地时钟决定，跟服务端真实状态无关；而且缺字段时会得到一个"看起来有效"的假象，反而掩盖问题。

我们的做法：字段缺失或非法就直接视为"未配置"，过期以服务端返回 `200003` 为准，本地时间只用来做提示。

**A6：过期时间没有依据。** 硬编码 7 天（`LoginCredential.cs:45`、`FrmMain.cs:850`），跟真实会话寿命没关系。

**A7：状态被无条件覆盖。** `DownloadService.cs:134-136` 先把状态设成"部分失败"，紧接着下一行无条件改成"已完成"。于是部分失败的任务被报告成完全成功，失败数量在界面上丢失了。

### 8.2 实现级问题（12 处）

| 问题 | 出处 |
|---|---|
| 图片**串行**下载（`foreach` 里 `await`，没有并发） | `ArticleExporter.cs:346-429` |
| 图片扩展名**只从 URL 路径猜**，不看微信的 `wx_fmt` 参数 | `ArticleExporter.cs:602-611` |
| 用**正则改 HTML**：先匹配 `<img ...>` 再 `html.Replace(...)`。*（初稿说的"标签重复时误替换"机制不对——两个完全相同的标签会因为去重指向同一个本地文件，结果反而是对的。真实脆弱点是：当较早被替换过的标签字符串是后面某个匹配的子串时，`Replace` 会静默失效，图片留在远端 URL。）* | `ArticleExporter.cs:340-416` |
| 导出 TXT 是用正则 `<[^>]+>` 去标签，结构全丢 | `ArticleExporter.cs:438-466` |
| **没有正文容器选择器**，整页 HTML 原样存下来，等于没清洗 | `ArticleExporter.cs:108-113` |
| **代码块完全不处理**，没有 `.code-snippet__fix` 相关逻辑 | 全仓无此选择器；对照本项目 `wechat.ts:168-186` |
| **没有 Markdown 输出**，只有 HTML / TXT / PDF | `DownloadOptions.cs:18-33` |
| 引入了 `PuppeteerSharp` 却没用，PDF 走的是 `chrome --headless --print-to-pdf` 命令行 | `Core.csproj`、`ArticleExporter.cs:15-16`、`:189` |
| `CacheService` 是**整个类的死代码**，注入到主窗体但零调用；功能还和 `OfficialAccountService` 里的同名方法重复，后者同样没人调用 | `FrmMain.cs:29,56`、`CacheService.cs` 全类、`OfficialAccountService.cs:115-131` |
| **暂停是空操作**：`_isPaused` 置位之后，没有任何地方等待它 | `DownloadService.cs:30,52,296-313` |
| 清除凭据写的是**一个全新的空凭据对象**（带着新的过期时间），而不是删文件 | `ConfigurationService.cs:136` |
| PDF 的 Chrome 路径探测只支持 Windows；`FindEdgeExecutable()` 定义了但没人调用 | `ArticleExporter.cs:246-271`、`:292-329` |

### 8.3 两边能力对照

| 能力 | C# 参考实现 | 本项目 | 用谁的 |
|---|---|---|---|
| 扫码登录 / 会话管理 | 完整，但有 A1/A2/A5 的设计问题 | 没有 | 借 C# 的思路，重写 |
| 枚举任意公众号的文章清单 | 完整，但有 A3 的问题 | 没有 | 借 C# 的思路，重写 |
| 列表筛选维度 | 6 个维度 | 没有 | 借 |
| 单篇抓取绕反爬 | 裸 `HttpClient` 加 UA 和 Referer | Camoufox 反指纹浏览器 | **用我们的** |
| 正文提取 | 存整页 HTML | `#js_content` 选择器 | **用我们的** |
| 代码块转源码 | 没有 | 占位符 + 围栏代码块 | **用我们的** |
| 图片本地化 | 串行，扩展名容易错 | 并发保序 + `wx_fmt` + Referer | **用我们的** |
| 输出格式 | HTML / TXT / PDF | **Markdown**（对 RAG 和知识库友好） | **用我们的** |
| 批量续爬去重 | 看文件是否存在 | `(来源, 文章ID)` 键 + 状态回写 | **用我们的** |
| 长任务进度和取消 | 事件 + 信号量 | CLI 里没有进度 | 用我们的能力 + dsh 的任务状态 |

---

## 9. 插件的包结构

按照 dsh 的三个角色约定来组织，但因为官方明确说了"**不要预防性拆分**"，所以 v1 打成**一个包**，内部按角色分文件。

```
dsh-wechat-mp/                      # 包名
│
├── package.json                    # 声明 dsh.bundle（宿主插件）和 dsh.client（前端）
├── cordis.patch.yml                # 让宿主加载这个插件
├── tsconfig.json / tsdown.config.ts
│
├── src/                            # ── Node 这一半（跑在宿主进程里）
│   ├── index.ts                    #   apply(ctx, config)
│   ├── config.ts                   #   配置定义（含输出目录，杜绝写死路径）
│   │
│   ├── definition/                 #   角色一：定义
│   │   ├── service.ts              #     抽象服务接口 + 领域类型
│   │   └── types.ts                #     OfficialAccount / MpArticle / ListQuery / MpSession
│   │
│   ├── provider/                   #   角色二：提供方
│   │   ├── mp-local.ts             #     纯 HTTP 实现
│   │   ├── endpoints.ts            #     所有接口地址和参数（改版只影响这一个文件）
│   │   ├── parse.ts                #     嵌套 JSON 解析 + 字段映射（纯函数，好测）
│   │   ├── session.ts              #     不可变会话对象（修 A2）
│   │   ├── throttle.ts             #     间隔 + 指数退避 + 频控识别（修 A3）
│   │   └── errors.ts               #     错误码到领域错误的映射（含 200003）
│   │
│   ├── auth/                       #   只在 L1 枚举链路里用到
│   │   ├── flow.ts                 #     接 dsh 的授权流程
│   │   ├── qr.ts                   #     四步登录 + token 提取
│   │   └── delivery/               #     二维码交付（可替换）
│   │       ├── http-route.ts       #       主方案：插件自己的同源路由
│   │       ├── file.ts             #       降级方案：写图片到工作区
│   │       └── browser.ts          #       兜底方案：有头浏览器
│   │
│   ├── output/                     #   输出目录和落盘结构
│   │   ├── root.ts                 #     决定写到哪里（见第 11 节）
│   │   ├── layout.ts               #     目录结构：平铺 / 按账号和日期分层
│   │   └── guard.ts                #     试读页 / 非图文类型的防护（见 5.2 节）
│   │
│   └── tools/                      #   角色三：消费方，按入口分组
│       ├── entry-single.ts         #     E1  wechat_fetch_article
│       ├── entry-list.ts           #     E2  wechat_fetch_list
│       ├── entry-account.ts        #     E3  authorize / search_account /
│       │                           #        list_articles / sync_account
│       └── output-config.ts        #     设置输出目录（界面和工具共用同一实现）
│
├── src/client/                     # ── 浏览器这一半（构建成 lib/client.js）
│   ├── index.tsx                   #   apply + inject:['slots']，注册插槽
│   ├── qr-card.tsx                 #   扫码卡片：<img> + 状态轮询
│   └── panel.tsx                   #   入口面板：输出目录 + 任务状态
│
└── tests/
    ├── fixtures/                   #   从 C# 抄来的真实响应样本（要去敏）
    └── unit/
```

**和三个角色的对应关系**：`definition/` 是定义，`provider/` 是提供方，`tools/` 是消费方。`auth/`、`output/`、`config.ts` 是提供方的支撑件，不属于任何一层接口。等将来真的要做第二套提供方（比如浏览器方案）的时候再拆包。

**`package.json` 要同时声明两件事**：

```jsonc
{
  "name": "dsh-wechat-mp",
  "type": "module",
  "exports": {
    ".":        { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 宿主插件那一半
    "client": { "platform": "web", "inject": [] }  // 浏览器那一半；inject 是包依赖边，不是插槽依赖
  },
  "peerDependencies": { "@deepseek-ai/cordis": "*" }
}
```

> 注意：这里的 `dsh.client.inject` 是**包之间的依赖边**（决定 factory 到达顺序），和 6.3 节里模块内部那个 `inject: ['slots']` 是两回事，别搞混。

浏览器那一半的完整契约（含必须导出的插件面）见 6.3 节。

---

## 10. 怎么和 spider-claw 接上

有两条路：

| 方式 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **当库用**（推荐） | `import { fetchWechatArticle, loadUrlList, saveUrlList } from 'spider-claw'` | 类型安全、没有进程开销、能拿到结构化返回值、不需要每次都过审批 | 和宿主跑在同一个进程里；**而且要求 `spider-claw` 以可安装的形态存在（见下面的部署问题）** |
| 调命令行 | 用 `ctx.shell` 跑 `spider-claw "<url>"` | 隔离干净、可以随便换版本、不要求它被发布 | 每次调用都要过审批，而且只能解析它的标准输出拿结果 |

**推荐当库用。** `spider-claw` 的库入口（`src/index.ts`）已经把需要的东西全导出来了：`WechatSource`、`fetchWechatArticle`、`loadUrlList`、`saveUrlList`、`UrlListItem`、`FetchOptions`。它本来就是为组合设计的。

> **一个初稿完全没写、但会挡住 P4 的问题：`spider-claw` 怎么进入插件的部署？**
>
> 如果按 D1 选了插件独立建仓，那么 `import 'spider-claw'` 就要求它要么发布到 npm、要么以 `file:` / 打包的方式随插件分发。而本项目目前**没有发布的证据**，`package.json` 的 `exports` 也只有 `import` 条件（纯 ESM），没有任何 `require` 或打包产物之外的入口。
>
> 这个要跟 D1 一起决定：**(a)** 把 `spider-claw` 发到 npm；**(b)** 插件开发期用 `file:` 依赖本地路径，发布时把构建产物一起打包；**(c)** 退回"调命令行"模式，用 `ctx.shell`，改用 `spider-claw` 的全局安装。

**衔接点是 `url-list.json`**，这是项目里已有的、测过的交接格式：

```jsonc
[
  {
    "url": "https://mp.weixin.qq.com/s/xxxxxxxx",
    "source": "wechat",
    "status": "pending",          // 抓完之后 spider-claw 会回写成 done 或 failed
    "aid": "2247483…",            // 我们加的扩展字段：后台的稳定 ID，比 URL 更适合去重
    "title": "文章标题",           // 元数据前置，方便抓取前先筛一遍
    "publish_time": "2026-09-21 21:25:00",
    "fakeid": "MzIx…",
    "is_pay_subscribe": false     // 见 5.2 节：落清单时就带上，抓取前可以过滤
  }
]
```

`UrlListItem` 类型带了一个索引签名（`src/core/urlList.ts:19`），**天生就允许携带额外字段**。这一点经过逐行核验，**加字段确实不用改任何现有代码**：`loadUrlList` 对对象条目原样透传（`urlList.ts:80`），`runList` 只就地改 `status` / `source` / `output` / `updated_at`（`cli.ts:127-143`），`saveUrlList` 序列化整个对象（`urlList.ts:89-91`）。

**关于去重键**：现在 `WechatSource.articleId()` 用的是 URL 的核心路径（`wechat.ts:244-247`）。

> 修正初稿的一处归因错误：初稿说清单里的链接带的 `&chksm=…&scene=…` 参数"已经被 `normalizeWechatUrl` 处理掉了"——**不对**。`normalizeWechatUrl` 的返回值是 `https://host + pathname + search + hash`（`wechat.ts:79`），**查询串是完整保留的**。真正把参数去掉的是 `articleId()` 里的 `split('?')[0]`。所以"去重对追踪参数鲁棒"这个结论成立，但原因是去重键取了核心路径，**不是入参被清洗过**。（顺带：被抓取的 URL 本身会带着 `chksm` 去请求，这无害。）

更稳的做法是用后台的 `aid` 或 `appmsgid`，因为它不受 URL 形态影响。建议 v1 先保持现有的 URL 去重（零改动），把 `aid` 作为并列字段写进去，等真的出现重复案例再切换。

**`listPath` 的相对路径基准**：现在写的是 `./url-list.json`。它相对**谁**的 cwd 解析——宿主进程的，还是工作区的——初稿没说。这个必须跟第 11 节的输出根目录**共用同一套解析规则**，否则会出现"清单写到了 A 处、输出落到了 B 处"。

---

## 11. 输出目录与界面入口

这是你明确要求的一点：路径不能写死。

### 路径怎么定

按优先级来，先看有没有显式指定，再看配置，最后落到默认值：

```
工具调用时传的显式参数
  → 插件配置里的 outputRoot
    → 默认值：当前 dsh 工作区目录下的 output/
```

dsh 本身有"工作区"的概念（启动 `dsh` 时所在的目录，或者用户在界面上选的目录），所以把默认输出放在工作区里是最符合习惯的做法。配置项只提供默认值，**默认值也要来自运行时环境，不能是写死的绝对路径**。

定下来之后，把这个绝对路径解析一次存进上下文，后面所有写入都用它，避免中途工作目录变了导致写错地方。

### 目录结构

用 `layout` 配置项切换：

- `flat`（现有行为）：`output/<文章标题>/<文章标题>.md` + `images/`
- `byAccountDate`（借鉴 C# 的做法）：`output/<账号名>/<年-月>/<年-月-日>_<标题>/`

### 界面上放什么

在 dsh 的网页界面里注册一个面板，用来做三件事（初稿写了四件，第三件已下调，见下）：

1. 显示当前的输出根目录
2. 改这个目录（交互式选，或者直接填）
3. 看任务的**状态**（在跑 / 已完成 / 已取消 / 失败）——**不是进度条**
4. 触发三个入口

> **为什么把"看进度"改成"看状态"**：`ctx.jobs` 里**根本没有进度这个概念**。任务对外的可观测面只有 `JobSnapshot`（`running` / `stopping` / `completed` / `killed` / `failed`，加一个生产者自定义的 `detail` 文本），以及消费方主动拉取的 `readOutput()`。界面经 control stream 拿到的也只是"queue、job 与 projection 的更新"，也就是生命周期状态，不是百分比。
>
> 所以想要进度条，只有两条路：**(a)** 降级成状态展示，零成本，直接走原生能力；**(b)** 复用插件自己那条 `/wechat-mp/status` 路由上报进度计数（跟二维码用的是同一条路）。初稿既承诺了功能又没给通路，这是设计缺口。

### 目录怎么选

dsh 自己已经有完整的目录选择服务了，**不需要自己搭树**：

- 插槽树里的 `sidebar.workspaces.directoryFlow` 和 `conversation.hero.workspace.directoryFlow`（这两个我在 slots 参考页里亲眼确认过）就是这套服务的 UI 面；
- 它背后是 `ctx.directoryPickerController`，对外暴露 `@Remote('pick')`（**调原生 OS 选择器**）、`@Remote('list')`（应用内浏览）、`@Remote('createDirectory')`。

> **一个命名上的澄清**（第二轮补验）：`ctx.directoryPicker` 是**宿主侧的抽象 seam**；浏览器侧要调它，走的是经 `ctx.remote.directoryPicker` 暴露出来的 `pick` / `list` / `createDirectory`。所以"浏览器侧的正规通道"这个说法要修正为"`ctx.remote.directoryPicker`"。


**应该做的是复用或对照它，而不是用 `ctx.fs` 自研。**

> 初稿在这一点上错了两处，都记在这里：
>
> 1. **`ctx.fs` 是宿主侧服务，不是浏览器侧的服务。** 它的原语是 `resolve` / `stat` / `readText` / `listDir` / `writeText` / `editText` 这类。**没有任何文档说明树外包可以 inject 它**——这一点我至今没能确认。而且就算能用，拿它去实现浏览器侧的目录浏览也是错位的，浏览器侧列目录的正规通道是 `directoryPicker` / `workspaceFiles`。
> 2. **命名有侧别错误。** 宿主侧的服务叫 `ctx.workspaceRegistry`（另有 `workspaceController` / `workspaceFiles` / `directoryPicker`）；**`ctx.workspaces` 是客户端 model 的名字**（我在 Web Client 架构页读到过"`WorkspaceController` 把该 model 作为 `ctx.workspaces` 公开"这句话，那是客户端语境）。把它当成宿主 `ctx` 的成员引用会误导实现。
>
**已核验（第二轮补验通过）**：`ctx.directoryPickerController` 这个名字和它的三个 Remote 方法都属实。核验来源是**本机的一份 dsh 检出**（`/Users/taurus/0-ws/00-coding-repo/llm-learning/stage-dsh-plugin-qa/deepseek-harness`，HEAD `0d1f50007f` / 2026-09-15）里的 `docs/subsystems/workspace.zh.md`：

- 宿主侧注册表叫 `ctx.workspaceRegistry`；目录选择是一个抽象 seam `ctx.directoryPicker`（"每个 context 只能有一个实现，加载第二个会抛错"）
- `ctx.directoryPickerController` 是承载 `ctx.remote.directoryPicker` 的宿主服务，逐字签名：`@Remote('pick') async pick(signal): Promise<string | null>`、`@Remote('list') async list(path, signal): Promise<DirectoryListing>`、`@Remote('createDirectory') async createDirectory(path, name): Promise<string>`
- 顺带佐证了 6.2 节提到的流式通路：同一文件里就有 `@Remote({ mode: 'stream' })` 的真实用法

> **一个操作上的好消息**：既然本机有这份检出，**后面所有关于 dsh 行为的核验都可以直接读源码，不必依赖外网**。这对 P0-6/9/10/11/14/15 是决定性的便利（尤其代理不稳的时候）。

### 用户改的值存在哪

`cordis.yml` 是用户手写的文件，插件不该去改它。所以配置项只提供默认值，用户在界面上改的值**优先用 dsh 的设置子系统持久化**。

这一条已经被文档坐实，不用再猜：settings 页写了 `ctx.settings.register(ns, schema)` 返回可持久化的 `SettingsScope`；cookbook 里有一个「新增设置卡片」的页面，给出了 `settings.plugin.item` 卡片的完整做法；`installSection()` 还能和 `cordis.yml` 分层叠加。插件自己存文件只作为降级方案。

> 剩下的唯一待验证项是"树外包实际操作一次能不能跑通"，见 P0-12。

---

## 12. 工具设计

所有工具都用 `defineTool` 定义，返回结构化的值，给人看的文字交给 `render` 生成。

### E1：`wechat_fetch_article`（单篇）

```ts
parameters: {
  url:       { type: 'string', required: true },
  outputDir: { type: 'string' },     // 不传就用配置里的
  proxy:     { type: 'string', description: "'direct' | 'env' | 代理地址" },
}
output.schema: {
  markdownPath, title, author, publishTime, imageCount,
  guard: { isLikelyPaywall: boolean, reason?: string }   // 见 5.2 节
}
```

实现上直接 `import { fetchWechatArticle } from 'spider-claw'`。

> 待定：这个工具和"让 agent 直接跑 spider-claw 命令"功能重叠。倾向于保留，因为工具化之后能返回结构化的路径和元数据，比让模型去解析命令行输出可靠。

### E2：`wechat_fetch_list`（列表）

```ts
parameters: {
  listPath:  { type: 'string', description: '默认 url-list.json（解析规则与输出根目录一致）' },
  outputDir: { type: 'string' },
}
output.schema: {
  total, succeeded, failed, skipped, outputs: [{ url, markdownPath }]
}
```

内部调用现有的 `runList`。

> **初稿有个参数去掉**：原来写了 `onlyPending`（默认 true，意思是可以传 false 强制全部重抓）。但 `runList` 只有一个硬编码行为——`status === 'done'` 就跳过（`cli.ts:68-149`），**没有"强制重抓"开关**。要么给 `runList` 加签名参数，要么删掉这个参数。v1 建议删掉。

### E3-1：`wechat_mp_authorize`（扫码授权）

```ts
parameters: {
  force: { type: 'boolean', description: '忽略已保存的凭据，强制重新扫码' },
}
output.schema: {
  status: 'authorized' | 'already_authorized' | 'cancelled',
  nickname, credentialSource,
}
```

底层走 `ctx.authorization.begin(...)`，由注册的流程执行第 13 节那套四步登录。这里不用自己加锁——`begin` 对同一个 key 有 `ALREADY_IN_FLIGHT` 保护。**但它的作用域是否跨会话，见 P0-15。**

### E3-2：`wechat_mp_search_account`（搜公众号）

```ts
parameters: {
  query: { type: 'string', required: true, description: '公众号昵称或微信号' },
  limit: { type: 'number', description: '默认 5' },
}
output.schema: {
  accounts: [{ fakeid, nickname, alias, signature, avatarUrl, serviceType }]
}
```

### E3-3：`wechat_mp_list_articles`（列文章）

```ts
parameters: {
  fakeid:        { type: 'string', required: true },
  keyword:       { type: 'string', description: '服务端检索，不用先全拉回来再本地过滤' },
  since:         { type: 'string', description: 'YYYY-MM-DD' },
  until:         { type: 'string' },
  originalOnly:  { type: 'boolean' },
  albumName:     { type: 'string', description: '按合集筛' },
  includeDeleted:{ type: 'boolean', description: '是否包含已删除的，默认 false' },
  limit:         { type: 'number', description: '最多返回多少条，默认 100' },
}
output.schema: {
  total, truncated: boolean,
  articles: [{ aid, appmsgid, title, link, author, publishTime,
               digest, cover, isOriginal, itemShowType, albumNames, isDeleted,
               isPaySubscribe }]        // ← 初稿漏了 isPaySubscribe，见 5.2 节
}
```

### E3-4：`wechat_mp_sync_account`（同步一个账号，长任务）

```ts
parameters: {
  fakeid:  { type: 'string', required: true },
  since:   { type: 'string' },
  until:   { type: 'string' },
  listPath:{ type: 'string', description: '默认 url-list.json' },
  fetchAfterSync: { type: 'boolean', description: '同步完接着抓正文，默认 false' },
}
output.schema: 两种形态之一
  后台模式：{ kind: 'background', jobId }
  完成模式：{ kind: 'completed', discovered, appended, skipped, newArticles, listPath }
```

实现要点：

```ts
// 插件自己持有取消控制器，因为 ctx.jobs 不会给你 per-job 的 signal
const ac = new AbortController()

const { id: jobId } = await ctx.jobs.start({
  kind: 'wechat-mp-sync',
  label: `同步 ${account.nickname} 的文章`,
  owner: exec.agent,
  run() {                                  // ← 无参数！同步返回钩子
    const work = (async () => { /* 用 ac.signal 而不是 exec.signal */ })()
    return {
      cancel(reason) { ac.abort(new Error(reason ?? 'cancelled')) },  // 同步、幂等
      done: work.then(
        () => ({ status: 'completed' as const }),
        () => ({ status: 'killed' as const }),
      ),
    }
  },
})
return { kind: 'background', jobId }
```

> **这里初稿写错了，必须说清楚。** 初稿写的是 `run: async (ownSignal) => {...}`，并声称"用 ownSignal，不要用 exec.signal"。
>
> 事实是：`JobStart.run()` 的签名是 **`run(): JobHooks`——不接收任何参数**，而且**同步返回**钩子；`JobHooks = { cancel(reason?): void; done: Promise<JobOutcome>; readOutput?(): string }`。取消是任务拥有者调 `ctx.jobs.kill(id, caller?, reason?)` 发起的，运行时再转发给生产方自己的 `cancel`。**根本不存在 per-job 的 AbortSignal 被传进 `run`。**
>
> 初稿引用的那句官方原话（"发布任务 ID 之后应使用任务自有的取消信号，而不是 `exec.signal`"）**引用是准确的**——错在我把"任务自有的取消信号"具体化成了一个不存在的回调参数。照初稿写，`ownSignal` 会是 `undefined`，取消根本接不上。
>
> 正确的做法就是上面那样：**插件自己持有 `AbortController`，在返回的 `cancel` 钩子里触发它。**

### 另外：`wechat_set_output_root`（设置输出目录）

给界面面板和 agent 共用的一个工具，内部是同一份实现，避免两处逻辑不一致。

---

## 13. 扫码登录的流程

**状态机**（对应 `WeChatMpService.cs:99-285` 和 `FrmLogin.cs:118-163`）：

```
1. 开始会话     POST bizlogin?action=startlogin      → 拿到 sessionid
2. 取二维码     GET  scanloginqrcode?action=getqrcode → 二维码图片
3. 轮询状态     GET  scanloginqrcode?action=ask
     ├─ 0      继续等
     ├─ 4 / 6  看 acctSize：>=1 提示"请在手机上确认"；否则提示"没有可用账号"
     ├─ 1      进入第 4 步
     ├─ 2 / 3  二维码过期 → 重新取二维码（注意不是重开会话）
     ├─ 5      账号未绑定邮箱 → 终止轮询并报错
     └─ 其他   有 errMsg 就显示出来
4. 确认登录     POST bizlogin?action=login           → 从 redirect_url 里提取 token
5. 拿账号信息   GET  account/getprofile              → 昵称和头像（可选，只用于展示）
```

**轮询的写法**（这是修 A4 的关键）：

```ts
let stopped = false
let inFlight = false

const tick = async () => {
  if (stopped || inFlight) return           // "在飞"标志位，替代"先停后启"
  inFlight = true
  try {
    const status = await provider.checkScanStatus(signal)
    // ……状态机……
  } finally {
    inFlight = false
    if (!stopped) timer = setTimeout(tick, pollIntervalMs)   // 递归 setTimeout，不是 setInterval
  }
}

timer = setTimeout(tick, pollIntervalMs)
ctx.effect(() => () => { stopped = true; clearTimeout(timer) })   // 插件卸载时自动清理
```

**为什么用递归 `setTimeout` 而不是 `setInterval`**：效果和"先停后启"一样，但更简单——下一次调度发生在这一次完成之后，天然不会重入。而 `setInterval` 是固定节奏触发，请求一慢就会堆积（这正是 `FrmLogin.cs:96-99` 的实际问题）。

**凭据存在哪**：两条路。

- **用 dsh 的 `ctx.credentials`**（推荐，符合"原生优先"）：用 `CredentialKey` 存整个会话记录，写路径是 `modifyRecord`，带跨进程锁；还能通过 `credentials/record-updated` 事件驱动界面刷新。代价是这个 API 面比较重，而且要先确认树外包能不能 import 到它（见 P0-8）。
- **自己写文件**（降级方案）：写 `.dsh-wechat-mp/session.json`，权限设成 0600。实现简单，但离开了 dsh 的约定，也没有跨进程互斥。

按前面定的原则，**默认走前者，后者作为降级**。不管走哪条，都要把下面两件事做对：读出来之后显式检查字段是否合法，缺字段就直接当作未授权；过期判断以服务端返回 `200003` 为准，**不要只信本地时钟**（这是 A5 的准确版本）。

---

## 14. 限速与错误处理

```ts
interface ThrottleConfig {
  pageDelayMs:   number   // 翻页间隔，默认 3000（参考实现只有 100，风险很高）
  backoffFactor: number   // 退避倍数，默认 2
  maxBackoffMs:  number   // 退避上限，默认 60000
  maxRetries:    number   // 重试次数，默认 3
}
```

错误处理：

| `ret` 值 | 含义 | 怎么处理 |
|---|---|---|
| 0 | 成功 | —— |
| 200003 | 登录失效 | 抛一个专门的错误类型，提示用户"请重新调用授权工具"。**不要去清空会话对象的字段，改成标记为无效** |
| 频控码（**待实测**，见 P0-2） | 请求太快 | 指数退避重试；连续失败就抛错并建议调大间隔 |
| 其他非 0 | 未知业务错误 | 直接抛错，把 `errMsg` 原样带出来，不要吞掉 |

> 参考实现的做法正好相反：只要 `ret != 0` 就记一条警告然后返回空列表（`OfficialAccountService.cs:75-79`、`ArticleService.cs:122-126`）。**错误被吞成了空结果**，调用方没办法区分"这个号没有文章"和"接口挂了"。这一点必须反过来做。

---

## 15. 动手之前必须验证的事

下面这些事实决定后面所有设计，所以要先花时间实测。**我本人没有执行过这些接口**，以下全部是待验证项，不要当结论用。

| 编号 | 要验证什么 | 为什么重要 | 怎么算通过 |
|---|---|---|---|
| P0-1 | `appmsgpublish` 加那套参数**现在还有效吗** | 微信改版比较频繁，这是全部价值的来源 | 用真实登录态跑通一次，拿到含文章列表的返回，并且把原始响应存成测试样本 |
| P0-2 | **频控的真实错误码和阈值** | C# 源码里只有 200003，没有频控码；而且它只用 100 毫秒间隔，看不出作者遇到过 | 故意快速翻页触发一次，记录错误码和提示，定出安全间隔的下限 |
| P0-3 | `count` 参数的**实际上限是多少** | C# 传的是 20，但后台界面上每页只显示 5 条，不确定会不会被截断 | 分别用 5 / 20 / 50 请求，比对实际返回条数 |
| P0-4 | 登录凭证的**真实有效期** | C# 硬编码 7 天，没有任何依据 | 连续几天复用同一份凭据，记录第一次收到 200003 是第几天 |
| P0-5 | `searchbiz` 的条数上限和检索方式 | 决定搜索工具的 `limit` 怎么定义 | 用 5 和 20 各请求一次；用昵称和微信号各测一次 |
| **P0-6** | **最小前端包能不能被宿主正常加载**：声明 `dsh.client` 和 `exports["./client"]`，产物按 6.3 节的形态（**含必须导出的 `{ inject: ['slots'], apply }` 插件面**），然后在 `tool.call.toolview` 里注册一个卡片 | **整个方案里风险最高、我核对得最少的一环。** 产物形态和插件面都是从官方源码读到的，但**没有官方的第三方前端示例**——官方 cookbook 自己说了"没有已发布的预设暴露该包，因此本仓库之外的包得自行复刻同样的输出格式"，而仓库内能参考的例子（`packages/client/ui-theme`、`ui-settings-plugins`）都是**仓内路径**，不能直接照搬到树外 | 在网页界面里看到一个自己写的卡片；`/plugins/??<包名>/client.js` 返回 200。**不通过就退回降级方案** |
| P0-7 | `appmsg?action=list_ex`（那篇文章里的端点）和 `appmsgpublish` 的实际差异 | 两者返回结构不同；如果前者更稳定，解析层要做双分支 | 两个都跑通，记下字段差异 |
| P0-8 | 树外包能不能 import `@deepseek-ai/dsh-credentials` 这类内置包 | 决定凭据方案能不能用 dsh 原生的 | 在最小插件里 import 一下看看能不能跑 |
| P0-9 | 树外包能不能用 `ctx.webServer`，`prefix` 路由会不会和 SPA 兜底冲突 | 这是二维码路由的地基 | 注册 `prefix '/wechat-mp'`，`curl 127.0.0.1:<端口>/wechat-mp/status` 返回 200，并且不影响正常页面 |
| P0-10 | 平台冻结的 React 是哪个版本；`tool.call.toolview` 的注册键是不是就是工具名字面量 | 决定卡片能不能挂上去 | 在 P0-6 里顺带确认 |
| **P0-11** | `tool.call.toolview` 上**同名注册的真实行为**：是硬报错，还是**静默替换 / 被遮蔽**？ | **初稿的前提写反了。** 我引用的依据（一份 Agent Note）说"同一 tool name 只能有一个生效的注册，重复 key 会硬报错"；但 slots 参考页对同一个机制的说法是"复用已有 cell 表示**有意替换**其展示"、"`priority` 是**遮蔽**优先级"。两者可能是不同层的规则（通用 slot 允许按优先级遮蔽，而 `ui-tool` 自己的 keyed 分发可能更严），我无法判定 | 用一个故意与现有工具同名的注册试一次，看是抛错、替换还是被遮蔽。**风险是双向的**：既可能装不上，也可能静默替换掉别的插件的卡片 |
| P0-12 | dsh 的 settings 子系统能不能让树外包持久化用户设置 | 决定输出目录在界面上改完之后存在哪。文档层面已有答案（`ctx.settings.register(ns, schema)` → 可持久化的 `SettingsScope`），待验证的只是实测一次 | 参考官方的"新增设置卡片"做法试一次 |
| **P0-13** | **Camoufox 能不能在宿主进程里跑通**：`import('camoufox-js')` + 启动一次无头 Firefox + 完成一次 `fetchWechatArticle` | **初稿把 L2 当成"现成的、一行不改"，整个 P0 清单都押在 L1 和前端上，一个针对 L2 的探针都没有。** 可是 `wechat.ts:212` 是对 `camoufox-js` 的**动态 import**，随后启动一个无头 Firefox：这个依赖在宿主环境里装不装得上、浏览器二进制（百 MB 级）怎么下载、渲染崩溃会不会连带拖垮 dsh 进程，全都没验 | 在宿主进程内成功抓下一篇文章，且宿主不崩 |
| **P0-14** | **树外包能不能注册 `@Remote` / 网关命名空间**，或者订阅宿主的流式状态 | 这是 6.2 节的钥匙：能用的话，二维码状态推送和任务进度上报都有比 HTTP 轮询更顺的**文档化**通路；不能用，现在的 `/wechat-mp` 路由设计才真正算"最优"。现在这个决定性问题悬空 | 在最小插件里试一次流式 Remote 或 `$events` 订阅 |
| **P0-15** | `ctx.authorization` 服务是**全局单例还是每会话一实例** | 决定 6.2 节的单例路由（`/wechat-mp/qr` 不带 ID）在多会话下安不安全。若是每会话一实例，两个会话会同时存在两个在飞二维码，A 会话的页面会显示 B 会话的二维码 | 开两个会话同时发起授权，观察 `/wechat-mp/qr` 返回的是哪一个 |
| **P0-16** | `url-list.json` 的**跨会话并发写**，以及 `listPath` 相对谁的 cwd 解析 | `runList` 每处理一条就整文件回写（`cli.ts:144`），两个会话同时跑就会后写者覆盖前写者——这正是 A2 那个教训在文件层面的重演 | 开两个会话同时跑列表抓取，检查回写的状态有没有丢失；同时确认路径解析基准 |

**这一阶段的产出**：一份 `docs/wechat-mp-probe-results.md` 记录实测结论，`tests/fixtures/*.json` 存放真实响应样本（**要去敏**，删掉 token、Cookie、昵称），以及一个最小的双半插件骨架用来验证 P0-6/9/10/11/13/14/15。

> **关于修订的说明**：这份文档的 6.2 节初稿把"dsh 授权接口没有图像通道"错误地推导成了"二维码只能存文件"。后来查了网页客户端相关的文档和官方源码，确认 dsh 支持第三方插件贡献浏览器端 React 组件，也支持插件自己注册 HTTP 路由，所以二维码**是能**画进网页界面的。**但修正时我又走到了另一个极端**——把"没有推送通道"写成了已核验的事实，而实际上 dsh 至少还记载着三条宿主到浏览器的推送通路（`@Remote` 流式方法、自定义会话事件、`ctx.resources` 帧流），只是它们对树外包开不开放没有文档背书。这一稿已按准确表述改回，并列为 P0-14。
>
> **本轮修订涉及的范围**：19 条外部审阅发现，其中 16 条接受并已改入正文，3 条经我核验后认为审阅方有误（见附录 D）。所有改动都以"事实与证据"为准，不以"面子"为准。

---

## 16. 实施步骤

| 阶段 | 做什么 | 怎么算完成 | 依赖 |
|---|---|---|---|
| **P0 探针** | 上面 **16 项**全部实测，产出样本和结论文档。**其中 P0-1 和 P0-6 是两个硬门槛** | 16 项都有结论（"不可行"也是结论） | 一个能登录的公众号；P0-6 还需要 dsh 本体能跑起来 |
| **P1 骨架** | `definition/` 和 `provider/`；`endpoints.ts` 单独成文件，作为改版时唯一要动的地方；`parse.ts` 做成纯函数并用样本单测（**含完整的扫码状态码分支**）；不可变会话对象；限速器；错误映射 | 解析层的单测通过；类型检查干净 | P0-1/2/3 |
| **P2a 授权（Node 侧）** | 四步登录状态机；先实现"写文件"这个降级交付方案把链路跑通；接入 dsh 的授权流程；凭据读写 | 真机扫码能跑通；确认同一时间只能有一次尝试；凭据文件权限是 0600 | P0-4/15 |
| **P2b 二维码路由** | 注册 `/wechat-mp` 前缀路由，提供二维码图片（**带 cache-busting**）和状态查询；路由随插件卸载一起释放 | `curl` 能取到图片；状态随扫码推进；卸载插件后路由消失 | P0-9 |
| **P2c 前端卡片** | 搭浏览器代码的构建链（产物形态 + **`{ inject: ['slots'], apply }` 插件面** + 那 9 项外部依赖白名单）；注册到 `tool.call.toolview`；卡片里放图片和状态轮询 | **在网页界面里能直接看到二维码并扫码完成授权** | P0-6/10/11/14 |
| **P3 工具** | 搜索、列文章、单篇抓取；同步工具接后台任务（**`run()` 无参数 + 自己持有 AbortController**）；按 `is_pay_subscribe` / `item_show_type` 做分流 | 单测通过 + 手动跑通"搜号 → 列文章 → 写入列表" | P1、P2a |
| **P4 衔接** | 和 `spider-claw` 的 `url-list.json` 联调；抓取完成后状态正确回写；试读页防护生效 | 端到端跑通：账号 → 清单 → Markdown 落盘 + 图片本地化，且付费/视频类文章不会被误标 `done` | P3、D3、D7 |
| **P5 界面与打包** | 输出目录面板（**复用 directoryPicker**）；任务状态展示；`dsh.bundle` 和 `dsh.client` 两个声明；`cordis.patch.yml`；README | `dsh plugin add` 装上后，界面里的卡片和面板都正常 | P4、P0-12、D1 |

> **如果决定先不做前端卡片**：跳过 P2c，P2b 降级成"把二维码图片写到工作区并告诉用户路径"。**端到端链路仍然能完整跑通**，只是扫码体验从"页面里直接扫"变成"打开一个文件"。这样做的好处是把 P0-6 这个风险推迟到后续迭代。
>
> **不要跳过 P0。** 如果 `appmsgpublish` 已经失效，整套方案的"发现"能力就归零了，得转向浏览器方案重新设计。所以 P0 不能和 P1 并行做。

---

## 17. 测试怎么做

| 测哪一层 | 怎么测 | 覆盖什么 |
|---|---|---|
| `parse.ts` | 纯函数 + 样本单测（离线，进 CI） | 嵌套 JSON 解析；字段缺失时的容错；空的列表；中间层 JSON 非法；过滤已删除文章；`publish_time` 为 0 时回退到 `update_time`；`is_pay_subscribe` / `item_show_type` 的透传 |
| `throttle.ts` | 注入假时钟 | 间隔是否生效；退避序列；上限封顶；频控码是否正确触发退避 |
| `errors.ts` | 表驱动单测 | 每个错误码的映射；200003 映射到登录失效错误 |
| `session.ts` | 单测 | 会话对象不可变：标记失效不会影响已经发出的请求（**A2 的设计约束测试**——注意 A2 描述的竞态在原 C# 代码里没有触发路径，这条是防我们自己的代码犯） |
| 凭据读写 | 单测 | **缺字段 / 畸形字段时的容错**（这是 A5 的准确版本——不是测一个不存在的 bug）；文件权限 |
| `output/guard.ts` | 单测 + 样本 | 试读页识别；非图文类型（62/66）识别；确认不会被误标 `done` |
| 授权状态机 | 假提供方 + 假时钟 | **0 / 1 / 2 / 3 / 4 / 5 / 6 / 其他 全部分支**；`acctSize` 的两个走向；过期后重新取二维码；"在飞"闸门（这是 A4 的回归测试） |
| 端到端 | 手动，需要真实扫码 | 跟现有 `tests/e2e` 的做法保持一致：默认自动跳过，不要污染 CI |

**一点建议**：把 8.1 和 8.2 里那些问题，每一处都写成一条回归测试。它们不是"顺手修一下"，而是这次评估的主要产出之一。

---

## 18. 风险

| 风险 | 影响 | 怎么减轻 |
|---|---|---|
| 接口改版 | 插件失效 | 所有接口地址和参数集中在 `endpoints.ts`，改版只动一个文件；样本单测能让失败点直接定位到"哪个环节变了" |
| 频控或账号被限制 | 用户的公众号受影响，这是真实损失 | 默认间隔不少于 3 秒、指数退避、翻页数设硬上限、不做并发枚举。**这是整个方案里唯一可能给用户造成实质损失的风险，必须保守** |
| 凭据泄露 | 后台会话被盗 | 文件权限 0600、加进 `.gitignore`、日志里永远不打印 token 和 Cookie、测试样本去敏 |
| 接口灰度 | 同一个接口对不同账号返回的结构不一样 | 解析时每个字段都按可选处理并给兜底，不做强解构 |
| **脏数据污染续爬状态** | 付费/视频类文章被误标 `done`，之后再也不重试 | 5.2 节的三条防护；`output/guard.ts` 单测 |
| **跨会话并发写列表** | 两个会话同时抓取会互相覆盖状态回写 | P0-16 实测后，加进程内互斥或在文档里声明限制 |
| 合规 | 平台规则 | 定位为"个人归档自己有权访问的内容"；枚举节奏保持温和；README 里明确写清楚不支持也不建议高频抓取全平台 |

---

## 19. 需要你拍板的事

已经定下来的（第 2 节）：使用方式、输出目录要可配置、架构调整、二维码画到前端、凭据优先用 dsh 原生。

还剩这些：

| 编号 | 要决定什么 | 选项 | 我的建议 |
|---|---|---|---|
| **D1** | 插件放在哪 | (a) 单独一个仓库 (b) 放进本仓库的 `packages/dsh-wechat-mp/` | **(a)**。发布生命周期不一样，`dsh.bundle` 这个声明不该出现在 spider-claw 这个包里。开发时用 `dsh plugin add ./本地目录` 链接过去就行。如果你更看重"一个仓库好管理"，(b) 也行，但根目录的 CI 是按单包写的，要调整 |
| **D2'** | 要不要接受"双半包"的复杂度 | (a) 接受，v1 就做前端卡片 (b) 先只做 Node 那一半用降级方案，前端卡片放到 P5 | 想要"在网页里直接扫码"的完整体验就选 (a)；想最快把端到端跑通就选 (b)。**这是最需要你先定的一项**，因为前端那一半是整个方案新增工作量的大头 |
| **D3** | 抓取侧怎么接 | (a) 当库用 `import` (b) 调命令行 | **(a)** |
| **D4** | v1 支持多账号吗 | (a) 单账号 (b) 多账号 | **(a)**。但会话对象按不可变建模，将来扩展到多账号只是多套一层 Map |
| **D5** | 二维码的降级方案要不要一起做 | (a) 做（多花一点时间，但前端出问题时有退路） (b) 不做 | **(a)**。降级方案本身很简单 |
| **D6** | 单篇抓取要不要做成工具 | (a) 做成工具 (b) 去掉，让 agent 直接跑命令 | **(a)**，能返回结构化的路径和元数据 |
| **D7**（新） | `spider-claw` 怎么进入插件的部署 | (a) 发布到 npm (b) 用 `file:` 依赖本地路径，发布时把构建产物一起打包 (c) 退回调命令行模式 | 这跟 D1 联动。若 (a) 选独立建仓，**这个必须先解决，否则 P4 根本跑不起来**。倾向 (a) 或 (b) |

---

## 20. 明确不做

1. **不重写 Markdown 转换那一套。** `spider-claw` 的 `wechat.ts`、`core/markdown.ts`、`core/images.ts` 在这件事上明显比参考实现好，重写是纯损失。
2. **不做 PDF。** 参考实现的 PDF 依赖 Windows 上的 Chrome 命令行，跨平台用不了；本项目也没这个需求。
3. **不做 TXT 导出。** 参考实现是用正则去标签，Markdown 已经是更好的形态。
4. **不做独立 GUI。** 宿主就是 dsh 的网页界面。
5. **不做并发枚举。** 风险不对称：收益小，损失可能很大。
6. **v1 不做多账号。**
7. **不搬参考实现的任何解析代码。** 正则改 HTML、串行下载图片、手动拼 Cookie 这些一律不用；只取接口契约和字段定义。

---

## 附录 A：接口速查

这张表是逆向出来的成果，来源都是参考实现的源码。

| 步骤 | 方法 | 端点 | 关键参数 | 出处 |
|---|---|---|---|---|
| 1 开始会话 | POST | `/cgi-bin/bizlogin?action=startlogin` | 表单：`userlang=zh_CN`、`redirect_url=`、`login_type=3`、`sessionid=<毫秒时间戳+随机数>`、`token=`、`lang=zh_CN`、`f=json`、`ajax=1` | `WeChatMpService.cs:99-144` |
| 2 取二维码 | GET | `/cgi-bin/scanloginqrcode?action=getqrcode&random=<随机数>` | 返回 PNG 图片 | `:149-168` |
| 3 轮询状态 | GET | `/cgi-bin/scanloginqrcode?action=ask` | `token=`、`lang=zh_CN`、`f=json`、`ajax=1` | `:174-209` |
| 4 确认登录 | POST | `/cgi-bin/bizlogin?action=login` | 表单：`userlang`、`redirect_url=`、`cookie_forbidden=0`、`cookie_cleaned=0`、`plugin_used=0`、`login_type=3`、`token=`、`lang`、`f=json`、`ajax=1` | `:214-285` |
| 5 账号信息 | GET | `/cgi-bin/account/getprofile?action=getprofile` | `lang`、`f=json`、`ajax=1`、`token` | `:290-330` |
| 6 搜索公众号 | GET | `/cgi-bin/searchbiz?action=search_biz` | `begin=0`、`count=5`、`query=<关键词>`、`token`、`lang`、`f=json`、`ajax=1` | `:364-420` |
| 7 列文章 | GET | `/cgi-bin/appmsgpublish` | `sub=list` 或 `search`、`search_field=null` 或 `7`、`begin`、`count`、`query`、`fakeid`、`type=101_1`、`free_publish_type=1`、`sub_action=list_ex`、`token`、`lang`、`f=json`、`ajax=1` | 方法体在 `:425-487` |

公共请求头：User-Agent 用的是 Chrome 120 on Windows；`Referer` 是 `https://mp.weixin.qq.com/`；`Origin` 是 `https://mp.weixin.qq.com`（`WeChatMpService.cs:24,36-38`）。

## 附录 B：错误码和返回结构

| 类型 | 字段 | 出处 |
|---|---|---|
| `BaseResponse` | `ret`（整数）、`err_msg`（字符串） | `ApiResponseModels.cs:17-24` |
| `ScanLoginResponse` | `status`、`acct_size` | `:86-93` |
| `BizLoginResponse` | `redirect_url` | `:98-102` |
| `AccountProfileResponse` | `nick_name`、`head_img` | `:107-114` |
| `SearchBizResponse` | `list`、`total` | `:29-36` |
| `AppMsgPublishResponse` | `publish_page`（字符串，需要再解析一次） | `:41-45` |
| `PublishPage` | `publish_count`、`total_count`、`publish_list` | `:50-60` |
| `PublishListItem` | `publish_type`、`publish_info`（字符串，需要再解析一次） | `:65-72` |
| `ArticleInfo` | `aid`、`appmsgid`、`title`、`link`、`author_name`、`create_time`、`update_time`、`publish_time`、`digest`、`cover`、`pic_cdn_url_235_1`、`pic_cdn_url_16_9`、`copyright_stat`、`copyright_type`、`item_show_type`、`is_pay_subscribe`、`is_deleted`、`appmsg_album_infos[]` | `ArticleInfo.cs:14-153` |
| `DownloadStatus` | 8 值：NotDownloaded / Waiting / Downloading / Exporting / Success / Failed / Skipped / Cancelled | `ArticleInfo.cs:231-272` |
| `TaskStatus` | 7 值：Pending / Running / Paused / Cancelled / Completed / PartialFailed / Error | `DownloadTaskInfo.cs:129-165` |

目前已知的错误码只有两个：`0` 表示成功，`200003` 表示登录失效（`WeChatMpService.cs:403,470`）。**频控的错误码还没测出来**，见 P0-2。

## 附录 C：证据索引

```
参考实现 references/AppWeChatArticleDownloader/
  WeChatMpService.cs:20-21        可变的 token/cookie 字段（A2）
  WeChatMpService.cs:29-35        CookieContainer 处理器（A1 的一半）
  WeChatMpService.cs:99-285       登录四步
  WeChatMpService.cs:154          取二维码
  WeChatMpService.cs:187          轮询状态
  WeChatMpService.cs:266-273      从 redirect_url 提取 token
  WeChatMpService.cs:296          拿账号信息
  WeChatMpService.cs:309/394/461  手动拼 Cookie（A1 的另一半）
  WeChatMpService.cs:332-341      把 Cookie 容器快照成字符串
  WeChatMpService.cs:364-388      搜索公众号
  WeChatMpService.cs:403-408      ret==200003 时清空字段（A2）
  WeChatMpService.cs:425-487      列文章接口（方法体全范围）
  WeChatMpService.cs:470-475      ret==200003（列文章侧）
  WeChatMpService.cs:496-537      裸 HttpClient 抓正文（注意：不读 _token）
  FrmLogin.cs:96-99               可重入的定时器（A4）
  FrmLogin.cs:118-163             扫码状态码语义（含 case 2/3、case 5、acctSize）
  FrmMain.cs:105-116              加载凭据
  FrmMain.cs:633-646              翻页只等 100 毫秒（A3）
  FrmMain.cs:850                  过期时间写死 7 天（A6）
  FrmMain.cs:29/56/774/1021       CacheService 注入但没使用；RetryCount 只用于展示
  FrmMain.cs:1022/1038            RequestInterval 写进了配置但没人读
  ArticleService.cs:26            每页 20 条
  ArticleService.cs:28-31         构造函数收具体类型（第 7.1 节第 2 条的修正依据）
  ArticleService.cs:119           翻页起点计算
  ArticleService.cs:122-126       错误被吞成空列表
  ArticleService.cs:128-154       嵌套 JSON 解析
  ArticleService.cs:158           空页即认为加载完
  ArticleService.cs:181-209       列表缓存没有有效期
  DownloadService.cs:26           直接持有具体 ArticleExporter
  DownloadService.cs:118-132      信号量控制并发
  DownloadService.cs:134-136      状态被覆盖（A7）
  DownloadService.cs:181-193      跳过已存在的文件
  DownloadService.cs:241          硬编码的延时
  DownloadService.cs:277-289      按日期分层的目录结构
  DownloadService.cs:296-313      暂停是空操作
  ArticleExporter.cs:15-16        引入但没用的 PuppeteerSharp
  ArticleExporter.cs:108-113      整页 HTML 原样存
  ArticleExporter.cs:189          Chrome 命令行生成 PDF
  ArticleExporter.cs:246-271      只支持 Windows 的 Chrome 路径探测
  ArticleExporter.cs:334-433      串行的图片下载
  ArticleExporter.cs:340-416      用正则改 HTML
  ArticleExporter.cs:438-466      用正则去标签导出 TXT
  ArticleExporter.cs:550-573      data-src 转 src
  ArticleExporter.cs:578-597      元数据旁路文件
  ArticleExporter.cs:602-611      扩展名只从 URL 猜
  LoginCredential.cs:44-45        过期时间属性初始化器（A5 的准确依据）
  LoginCredential.cs:51           有效性判断（A5、A6）
  ConfigurationService.cs:79-109  加载凭据
  ConfigurationService.cs:136     清除凭据时写了一个新对象
  CacheService.cs:63              IsCacheValid 没有调用点
  OfficialAccountService.cs:75-79        错误被吞成空列表
  OfficialAccountService.cs:115-131      和 CacheService 重复且都没人调用
  ArticleInfo.cs:75               发布时间回退到更新时间
  ArticleInfo.cs:122-147          文章类型和删除标记（含 is_pay_subscribe）
  ArticleInfo.cs:231-272          DownloadStatus 枚举（8 值）
  DownloadTaskInfo.cs:129-165     TaskStatus 枚举（7 值）
  DownloadOptions.cs:63/69        RetryCount 和 RequestInterval 是死配置

本项目 spider-claw/
  src/index.ts                    库导出面（决定能不能当库用）
  src/core/urlList.ts:11-20       UrlListItem 带索引签名，加字段不用改代码
  src/core/urlList.ts:80          对象条目原样透传
  src/core/urlList.ts:89-91       整对象序列化
  src/cli.ts:68-149               runList：只有 status==='done' 跳过，无强制重抓
  src/cli.ts:127-143              就地改 status/source/output/updated_at
  src/cli.ts:144                  每处理一条就整文件回写（P0-16 的依据）
  src/sources/wechat.ts:79        normalizeWechatUrl 保留 search/hash（第 10 节修正）
  src/sources/wechat.ts:212       对 camoufox-js 的动态 import（P0-13 的依据）
  src/sources/wechat.ts:244-247   现在的去重键（split('?')[0]）
  src/core/images.ts:44-98        并发保序下载 + wx_fmt
  docs/wechat-source-design.md    微信来源的设计说明（对照基准）

dsh 规范
  /develop/basic/                 插件就是导出 apply(ctx) 的 TS 模块；启动地址 http://127.0.0.1:3080
  /develop/basic/tool             工具定义 DSL
  /develop/basic/config           配置 schema 和 cordis.yml
  /develop/basic/publish          打包、安装方式（含 turtle-ui 链接）
  /develop/practice/              三个角色分层，以及"不要预防性拆分"
  /reference/cookbook/adding-a-tool     规范值、取消信号、后台任务、界面卡片
  /reference/subsystems/jobs            ★ JobStart.run(): JobHooks（无参数）+ JobHooks 三钩子 + 无 progress 概念
  /reference/subsystems/credentials     凭据的两个键空间
  /reference/subsystems/client-modules  前端包怎么声明和被扫描
  /reference/subsystems/slots           插槽列表（含 tool.call.toolview）+ 注册方式与遮蔽语义
  /reference/subsystems/web-server      插件怎么注册自己的 HTTP 路由
  /reference/subsystems/web-client      客户端 model（ctx.workspaces 属此侧）
  /reference/subsystems/settings        设置子系统（ctx.settings.register → SettingsScope）
  /reference/subsystems/workspace       ★ directoryPickerController（外部审阅报告，待补验）
  packages/credentials/authorization/src/index.ts   授权流程的接口定义
  packages/credentials/authorization/src/types.ts   授权通知的结构（没有图像字段）
  packages/client/ui-tool/package.json              前端包声明的真实例子
  packages/client/modules/package.json              同上
  packages/client/tsdown.client.ts                  产物形态（闭包工厂）+ format/platform/外置规则
  packages/client/web/src/platform.ts               ★ 9 项外部依赖白名单
  apps/web/tests/fixtures/plugins/fixture-live-client/client.js  ★ 客户端插件导出面的实例
  .agents/notes/.../2026-08-23-client-derived-tool-presentation.zh.md
      工具调用块的字段，以及执行期间卡片能拿到什么
```

---

## 附录 D：外部审阅意见的处理结果

审阅产物：`docs/wechat-mp-plugin-evaluation.review-zcode.md`。共 19 条发现加 5 条新增问题。

**处理汇总**：接受并已改入正文 16 条；经我核验认为审阅方有误 3 条；降级为待验证 1 项。

### 已采纳（16 条）

| 编号 | 原判严重度 | 结论 | 落到哪里 |
|---|---|---|---|
| R1 | 重大 | `ctx.jobs.start` 的 `run` 无参数、同步返回 `JobHooks`，取消靠 `kill → hooks.cancel`。**我确实猜错了机制** | 6.1 节、12 节 E3-4、16 节 P3 |
| R2 | 重大 | 客户端 bundle 的工厂**必须返回 cordis 插件面**（`{ inject: ['slots'], apply }`）；白名单是 **9 项**不是 10 项；且可通过 `dsh.client.external` 扩展而非"固定" | 6.3 节（新增导出面一节）、9 节 package.json 注释、16 节 P2c |
| R3 | 重大 | `ExpireTime` 是**属性初始化器**，缺字段时保留 `Now+7` 而不是变成 `0001-01-01`。**我的反序列化直觉错了，症状方向正好相反** | 8.1 节 A5 整条重写、17 节测试项改写 |
| R4 | 中等 | 扫码状态码漏了 `2`（也是过期）和 `5`（未绑定邮箱），且 4/6 依赖 `acctSize` | 7.2 节状态表、13 节状态机、17 节测试分支 |
| R5 | 中等 | 「L2 免登录」对**付费订阅**和**视频/图片类**文章会静默产出错误结果（试读页被当正文标 `done`） | **新增 5.2 节**、9 节加 `output/guard.ts`、12 节 E3-3 加 `isPaySubscribe`、18 节风险 |
| R6 | 中等 | 否定结论成立，但"没有推送通道"是过度全称——至少还有三条文档记载的推送面（`@Remote` 流式、自定义会话事件、`ctx.resources`）；其树外包可用性未验证。单例路由的多会话前提也没确立 | 6.2 节降级改写、15 节加 P0-14 / P0-15 |
| R7 | 中等 | 目录选择该用现成的 `directoryPickerController`（含 `@Remote('pick')` 原生选择器），不是用 `ctx.fs` 自研；且 `ctx.workspaces` 是**客户端 model** 的名字 | 11 节重写（含命名纠偏与诚实标注） |
| R8 | 中等 | P0-11 的前提写反了：slots 页说复用 cell 是"有意替换"+ priority 遮蔽 | 15 节 P0-11 改写为双向风险 |
| R9 | 中等 | `ctx.jobs` 里**没有 progress 概念**，只有状态 + `detail` + `readOutput` | 11 节"看进度"降级为"看状态"、9 节 panel 注释 |
| R10 | 中等 | `normalizeWechatUrl` **保留**查询串，真正去参的是 `articleId()`；`onlyPending=false` 在现有 `runList` 上做不到 | 10 节归因修正、12 节 E2 删参数 |
| R11 | 轻微 | A1 的"刚登录就失效"缺因果链（登录时刻两份 Cookie 按构造一致） | 8.1 节 A1 降级为"坏味道 + 条件性风险" |
| R12 | 轻微 | A2 描述的竞态在本仓没有触发路径（下载路径不读 `_token`） | 8.1 节 A2 改为"设计约束"，17 节测试改为防我们自己犯错 |
| R13 | 轻微 | 「Core 只依赖前两层的抽象」不成立，Core 直接用具体类型 | 7.1 节第 2 条改写 |
| R14 | 轻微 | 混淆了两个枚举：`DownloadStatus` 是 **8** 值，`TaskStatus` 才是另一个 **7** 值枚举 | 7.1 节第 3 条改写、附录 B 补两行 |
| R15（部分） | 轻微 | "dsh- 前缀是约定"和 CredentialKey 的转述都不准 | 6.1 节对应两行修正 |
| R17 | 轻微 | §1 的"16 处"与 §8 实际清点不符 | 第 1 节改为 19 处并说明构成 |
| R18 | 轻微 | 正则误替换的机制举例不对（相同标签的结果其实是对的） | 8.2 节对应行补注 |
| 第四节 5 条 | — | 全部采纳：Camoufox 无探针、`spider-claw` 部署路径缺失、跨会话并发写、树外包能否注册 `@Remote`、二维码图片缓存 | 分别落到 P0-13 / D7 / P0-16 / P0-14 / 6.2 节实现细节 |

### 未采纳（3 条，附我方证据）

| 编号 | 审阅方的说法 | 我的核验结果 | 证据 |
|---|---|---|---|
| **R15（端口部分）** | 「端口 3080 在全部已抓页面中零命中，无出处」 | **不成立。** `/develop/basic/` 页面的启动步骤里明确写了"打开 `http://127.0.0.1:3080`"。审阅方只 grep 了 reference 区的页面 | 本会话对 `develop/basic/` 的抓取结果；6.2 节因此保留 3080 |
| **R16** | 「文档站与仓库全文检索 `turtle-ui` 零命中（文档从没提过它）；`github.com/turtle-ui/turtle-ui` 实测 200」 | **论证对象错了。** ① `/develop/basic/publish` 页面正文确实有 `[turtle-ui](https://github.com/deepseek-harness/turtle-ui)` 这个链接；② 我实测 `git clone https://github.com/deepseek-harness/turtle-ui.git` 返回 **`Repository not found`**，审阅方测的是 `turtle-ui/turtle-ui`，是**另一个 URL** | 本会话对 publish 页的抓取结果 + `git clone` 的原始报错。**结论（没有官方第三方前端示例）保留、论据也保留**；已把 P0-6 的证据换成更硬的 cookbook 原文（"没有已发布的预设暴露该包，因此本仓库之外的包得自行复刻同样的输出格式"）+ 仓内示例路径 |
| **R19** | 「2017-06-06 这个日期公开检索未找到出处」 | **有二手出处。** 网易转载的《微信公众号内可以跳转任意文章了》一文写到"苹果 WWDC **2017** 年召开让许多人忽视了微信的一个重量级更新……**6 月 6 日**凌晨"，界面新闻同月有对应报道 | 本会话早前的网页检索结果。已在 3 节标注为"二手出处、无官方公告、日期本身存疑但不承重" |

### 一项降级为待验证 → **已补验通过**

| 事项 | 处理 |
|---|---|
| `ctx.directoryPickerController` 及其三个 `@Remote` 方法 | **已核验属实**。核验来源是本机的一份 dsh 检出 `docs/subsystems/workspace.zh.md`（HEAD `0d1f50007f` / 2026-09-15）：`ctx.workspaceRegistry`、抽象 seam `ctx.directoryPicker`、控制器 `ctx.directoryPickerController`，以及逐字签名 `@Remote('pick') async pick(signal): Promise<string\|null>`、`@Remote('list') async list(path, signal): Promise<DirectoryListing>`、`@Remote('createDirectory') async createDirectory(path, name): Promise<string>` 全部命中。已去掉 11 节里的待验证标注 |

> **这次补验带来一个操作层面的重要结论**：本机已有 dsh 的完整检出，**P0 里凡属"读规范"的那几项（P0-6/9/10/11/14/15 的大部分）都可以离线核验，不必依赖外网**。加上 `mp.weixin.qq.com` 直连可达（返回 200）、Camoufox 0.12.0 与 611MB 浏览器二进制已就位，**P0 阶段几乎不存在环境层面的阻塞**——真正的门槛只剩"需要一个可登录的公众号"。

### 关于本次审阅质量的一点记录

审阅方在"诚信边界"上的表现值得记一笔：它按提示把资料分成"逐字读过 / 只见过链接 / 完全没测"三档，因此火力确实集中在了我自认薄弱的地方（第 11 节的 `ctx.fs` / `ctx.workspaces`，第 6.3 节的构建契约），并且**在这两处都给出了比原文更硬的证据**。它也如实标注了哪些是推理性结论、哪些无法核验。

同时它有两处把核验对象搞错了（R15 端口、R16 的 turtle-ui URL），说明**审阅方的证据也需要被核验**——这几条正是靠回溯我自己的抓取记录才纠正过来的。

另外，我原本用它做了一次对照检验：故意在提示词里**不提示**"§6.3 漏了 CSS 怎么处理"，看它能否独立发现。**结果是没发现**——它在同一节找到了三件更要紧的事（缺导出面、白名单计数错、"固定"是伪命题），但没提 CSS。所以这个对照检验**失败了**，不能据此认为该审阅的覆盖面完整。不过重新想过之后，CSS 这条的实际严重度也比我原来判的轻：产物是全内联的 CJS，卡片用内联样式或 `apply` 里插一个 `<style>` 就够了，不构成阻塞。已补进 6.3 节。

---

*这份文档只做评估和方案，没有改动任何现有代码。定下来之后按第 16 节的顺序推进。*
