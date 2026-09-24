# 独立审阅：微信公众号文章批量下载 dsh 插件方案

> 审阅对象：`docs/wechat-mp-plugin-evaluation.md`（待裁决稿）。
> 审阅方式：逐条对照本地源码（C# 参考实现 + 本项目 `src/`）与 dsh 官方资料（文档站 11 个页面 + GitHub 仓库 20 余个源文件，均实际抓取）。每条发现注明证据与推翻过程；推理性结论单独标明。

## 一、总体结论

**这份方案大体上可以照着做，但没有到文档自我评估的那个可信度。** 架构主心骨（三个入口 + 两条链路、`url-list.json` 作为唯一交接点、登录关闭在 L1）经代码核验成立；第 4、5 节的统计与行号引用全部准确；第 7.2 节接口契约、附录 A/B 经逐行核对基本属实；§6.2 的核心否定结论（工具执行期间没有向卡片推送数据的通道）在源码层面得到确认，未被推翻。**最大的单点风险仍是文档自己标注的 P0-1**（`appmsgpublish` 接口是否还活着），这一点作者有自知之明。

但「可以照着做」要打三个折扣，按危害排序：

1. **`ctx.jobs` 的取消契约写错了 API 形状**（§6.1 / §12 E3-4）：文档把 `run: async (ownSignal) => {...}` 当作"必须写对"的要点，而官方 jobs 参考明确 `run(): JobHooks` **无参数**，取消靠生产者自备的 `cancel` 钩子。照抄会直接返工（见 R1）。
2. **§6.3 前端构建契约不完整**：浏览器模块必须导出 cordis 插件面 `{ inject: ['slots', …], apply(ctx) }`，文档只字未提——少了它，bundle 能加载但卡片永远注册不上；"10 项白名单"实为 9 项且并非"固定"（manifest 的 `external` 字段可扩展）（见 R2）。
3. **§8.1 A5 是一个被推翻的"可复现缺陷"**：C# 属性初始化器语义决定了"缺 `expireTime` 字段 → 反序列化成 `0001-01-01`"这件事**不可能发生**，而 §17 还要为它建回归测试（见 R3）。

如果 P0-1 通过，这份方案在修正上述三条之后是可执行的。

---

## 二、发现清单（按严重程度排序）

### 重大

#### R1 `ctx.jobs.start` 的 `run` 回调签名没有依据，取消机制写错了形状

- **反对的说法**：§6.1「长任务」行与 §12 E3-4 的代码示例 `run: async (ownSignal) => { /* 用 ownSignal，不要用 exec.signal */ }`，并强调「这一条必须写对，否则取消的行为会不对」。
- **证据**：
  - 文档站 jobs 参考（https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/jobs ）`JobStart` 类型逐字为 `run(): JobHooks`，注释 "Start the work after preflight and synchronously return its hooks. **Called once**"——**无参数**；`JobHooks = { cancel(reason?): void; done: Promise<JobOutcome>; readOutput?(): string }`，其中 `cancel` 是**生产者自己提供的**同步终止钩子。
  - adding-a-tool 页「长时间运行的工作」原文只说 `ctx.jobs.start({ kind, label, owner: exec.agent, run })`，全节没有任何 `run` 收到独立 signal 的表述。
  - 文档引用的那句官方原话（"发布 id 后应使用任务自有的取消信号，而不是 exec.signal"）本身**引用准确**——错在把"任务自有的取消信号"具体化成了一个不存在的回调参数。
- **怎么推翻的、结果如何**：我先假设文档可能读过我没读到的页面，专门让核验代理穷尽 grep adding-a-tool 与 jobs 两页的 `signal`/`AbortSignal`/`run` 字样，两页均无 `run` 带参的记载；`owner` 确为 `Agent` 类型、"用任务自有信号替代 exec.signal"的规则也属实——所以结论收敛为：**规则引用对了，机制猜错了**。按文档写法，`ownSignal` 将是 `undefined`，取消根本接不上；正确做法是插件自己持有 `AbortController`，并在返回的 `JobHooks.cancel` 里触发它。这属于 P3 必返工项，且 P0 清单里没有对应的实证项。

#### R2 §6.3 前端构建契约不完整：缺「客户端模块导出面」，白名单计数与"固定"说法都不对

- **反对的说法**：§6.3「这部分已经查到源码级别了，可以照着做」，随后只给出闭包工厂产物形态 + tsdown 预设参数 + "固定的 10 项清单"；§9 的 package.json 示例里 `"inject": []`。
- **证据**：
  - **导出面缺失**：仓库内唯一可运行的客户端插件实例——测试夹具 `apps/web/tests/fixtures/plugins/fixture-live-client/client.js`（L11-13）返回的是 `{ inject: ['slots', 'locale'], apply(ctx) { … } }`；slots 参考页（https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots ）的客户端示例同样是 `export const inject = ['slots']` + `export function apply(ctx)`。**工厂返回值必须是 cordis 插件面，且必须 `inject: ['slots']` 才拿得到 `ctx.slots`**——没有这一步，§6.2 设计的卡片根本无法注册。§6.3/§9 通篇没有讲这件事。
  - **白名单是 9 项不是 10 项**：`packages/client/web/src/platform.ts` L8-14 的 `PLATFORM_MODULES` 逐字核对，正是文档点名的 9 个模块名（名单本身一字不差），没有第 10 项；`PRELOADED_CLIENT_EXTERNALS` 是空数组。
  - **"固定"不成立**：`packages/client/tsdown.client.ts` L401-425 会把各包 manifest 里 `dsh.client.external` 声明的模块并入 external 集合（`requestedExternals`）；且运行时 `require` 的解析域不止种子表——`packages/client/modules/src/client/system.ts` L248-251 的报错文案写明命中范围是 "not a platform seed word, **not a materialized module**, and no registered package factory"，即其他已物化的客户端包也可被 require。文档"除了这些必须全部打包进去、否则直接抛错"的大方向对，但边界表述不准。
  - 文档做对的部分（一并确认，避免矫枉过正）：banner/footer 闭包工厂形态在 `tsdown.client.ts` L618-622 逐字属实；`format:'cjs'`/`platform:'browser'`/`outDir:'lib'`/`entryFileNames:'client.js'`/`sourcemap:true` 全部属实；白名单外 require 抛错属实；P0-6 的验收 URL `/plugins/??<包名>/client.js` 恰好就是真实的 combo 加载形态（modules/src/index.ts L225-231）。
- **怎么推翻的、结果如何**：我最初怀疑产物形态整个是错的（文档站网页里确实找不到 `__ModuleLoader__` 字样，只有 `window.__DSH_BOOT__`），于是让代理直接读 loader 侧源码——`window.__ModuleLoader__.load({id, factory})` 在 `modules/src/index.ts` L554-575（注入 HTML 的引导门面）、`system.ts` L135-145、`boot.ts` L57-59 三处成立，文档的产物形态**没有错**；错的是完整性：缺导出面契约、计数错、把可扩展机制说成固定。P0-6 实测时大概率能撞出这些问题，但方案文档自称"可以照着做"，P2c 会照着这份不完整的契约搭构建链。

#### R3 §8.1 A5「过期判断反序列化的坑」被 C# 语义直接推翻

- **反对的说法**：§8.1 A5：「如果本地的 `login_credential.json` 里缺了 `expireTime` 字段……反序列化之后它会变成 `0001-01-01`，于是永远判定为已过期，用户每次打开都要重新扫码」，并归为 7 条架构级缺陷之一；§17 还计划为它建回归测试（「缺字段视为未授权（这是 A5 的回归测试）」）。
- **证据**：`LoginCredential.cs:44-45`：
  ```csharp
  [JsonPropertyName("expireTime")]
  public DateTime ExpireTime { get; set; } = DateTime.Now.AddDays(7);
  ```
  这是**属性初始化器**。System.Text.Json 反序列化的行为是：先用无参构造函数建对象（初始化器此时执行，`ExpireTime = Now+7`），然后只覆盖 JSON 里**存在**的属性。字段缺失 → 保留 `Now+7` → `IsValid`（`LoginCredential.cs:51`）为真——结果与文档断言**正好相反**（老格式文件会被"续命"7 天，永远不会因本地时间过期），而不是变成 `0001-01-01`。全仓也没有任何代码路径会写出零值时间：`ConfigurationService.cs:136` 清除凭据时写 `new LoginCredential()`，序列化出去的 `expireTime` 是初始化器求值后的 `Now+7`。
- **怎么推翻的、结果如何**：我先尝试挽救原文——考虑"JSON 里显式写了零值时间"或"旧版本文件格式"两条路：显式零值在本仓没有任何写入方；旧版本缺字段的场景如上分析得到的是反向结果。两条路都救不回来。**A5 的机制描述是错的**，它描述的 bug 不存在。A5 引出的设计建议（缺字段视为未配置、以服务端 `200003` 为准、本地时间只做提示）依然是好建议，可以保留；但 §8 应把 A5 从"可复现缺陷"降级为"改进建议"，§17 的对应回归测试要改写成测"缺字段/畸形字段时的容错"，而不是测一个不存在的 bug。这条直接影响文档 §8 的可信度——它是七条"架构级缺陷"之一，却是照着 C# 之外的语言直觉编出来的。

### 中等

#### R4 扫码状态码表不完整，且自称"比那篇文章更完整"

- **反对的说法**：§7.2 的状态码表只列 0 / 1 / 3 / 4 / 6 四种语义（"3 = 二维码过期"），§13 的状态机同样只写「3 二维码过期 → 重新取二维码」；§7.2 还说这张表「比那篇文章写得更完整」。
- **证据**：`FrmLogin.cs:118-163` 的实际 switch：
  - `case 2: case 3:` —— **2 和 3 都是"过期，刷新二维码"**（L131-136）；文档把 2 整个丢了。
  - `case 5:` —— "账号未绑定邮箱"，独立分支、会终止轮询（L151-155）；文档完全没提。
  - `case 4/6` 还依赖 `acctSize >= 1` 区分"请在手机上确认"与"没有可用账号"（L138-149），文档也没提。
- **怎么推翻的、结果如何**：直接读源码即可，无争议。这是文档自我定位"最值钱、照实复刻"的接口契约一节，状态机漏了两个真实分支意味着插件实做时收到 status=2 会落进未处理分支（按 §13 的设计既不刷新也不报错）。修复成本为零，但必须在 P1 的 `parse`/状态机设计前补上。附录 C 标注的出处 `FrmLogin.cs:118-141` 实际分支延展到 163 行，范围也偏窄。

#### R5 「L2 永久免登录」缺两类会实打实失败的例外

- **反对的说法**：§2「文章正文页 `/s/xxx` 游客就能看，所以 L2 完全不需要登录态」；§7.1 结尾「L2 永久不需要登录。这是我们相对参考实现的结构性优势」。
- **证据**：
  - **付费订阅文章**：`ArticleInfo.cs:140-141` 有 `is_pay_subscribe` 字段——文档自己的字段全集里收了它，但 §12 E3-3 的 `output.schema` 没有暴露它，L2 抓取侧（`src/sources/wechat.ts` 全文）没有任何付费墙检测。游客打开付费文章只能看到试读片段+购买提示：轻则 `#js_content` 缺失抛「未能提取到正文内容」，重则**把试读片段当成正文成功落盘**——后者比失败更糟，因为它污染 `url-list.json` 的 `status: done`。
  - **非图文类型**：`item_show_type` 62=视频、66=图片（`ArticleInfo.cs:122-135`，文档自己也列了）。`wechat.ts:217-221` 的注释自己承认「部分文章结构不同」时 `#js_content` 等待超时；这类文章要么失败、要么产出垃圾 Markdown，而 L1→L2 的链路里没有任何按类型分流的环节。
- **怎么推翻的、结果如何**：我尝试证明"付费文章不会出现在 L1 清单里"来挽救原命题——失败：`is_pay_subscribe` 字段的存在本身就说明清单里有这类条目。**"免登录"这个架构结论仍然成立**（这两类例外都不靠登录态解决：付费文章登录了后台也只能拿到试读页，正文在单独的付费接口里），但"完全/永久"的绝对表述必须加限定，并且方案要补一个分流决策：L1 落清单时按 `item_show_type`/`is_pay_subscribe` 过滤或标记（E3-3 的输出里加 `isPaySubscribe` 是零成本的），L2 侧加一个"试读页检测"。按原方案不设防，E2 的 `done` 状态会被脏数据污染，进而破坏"断点续爬"这个卖点。

#### R6 §6.2 的推理链条：否定结论站住了，但"只能拉"说过头了，单例路由的并发前提没确立

- **反对的说法**：§6.2「没有'执行到一半把数据推给卡片'的通道……所以卡片不能靠推送，只能自己去拉」；「`ctx.authorization.begin()` 本身就保证了同一个 key 同时只有一次尝试在进行，所以……用单例路由就够了」。
- **证据**：
  - **站住的部分**（我重点尝试推翻、没推翻掉）：`agent.inject()` 存在但 adding-a-tool 原文明说它「追加持久化上下文，下一次模型请求会看到它」——是喂给模型的，不是 UI 推送；tools 子系统页的工具事件全集只有 `tools/change|pre-execute|execute|post-execute|result`，没有 partial/progress 类事件；Agent Note（2026-08-23-client-derived-tool-presentation.zh.md）L299/L340/L432 逐字确认 running 卡片只有「工具名称、调用参数、Session cwd」且「注册方不依赖 presentCall/presentResult」；tools 页 JSDoc 还明确 presentCall 「must depend only on args」。就"工具事件通道"而言，文档的否定结论**在源码层面成立**。
  - **过头的地方**：文档站记载了另外三条宿主→浏览器的推送通路——`@Remote({ mode: 'stream' })` 流方法供前端订阅（web-client/api-gateway 页）、自定义会话事件 + `ConversationNodeDefinition`（conversation 页有完整示例）、`ctx.resources.register` 帧流（client-resources 页）；物理层是 WebSocket，「瞬态 control stream……应用 queue、job 与 projection update」。二维码卡片完全可以让浏览器侧 inject `'connection'`/`'remote'`（slots 页 cookbook 示例正是 `inject = ['slots','locale','connection','remote','settingsScope']`）订阅宿主流式状态，而不是 HTTP 轮询。这些通路的 **"`@Remote`/网关命名空间对树外包开放"没有文档背书**——这才是真正的开放问题，文档却把"没有推送通道"写成了已核验事实。
  - **单例路由的缺口**：`ALREADY_IN_FLIGHT` 的守卫范围是 authorization 服务实例上的 key（authorization/src/index.ts L294-297 已核实），但授权服务是全局单例还是每会话一实例，文档站和源码抓取都没能确认。若是后者，两个会话同时发起 `wechat_mp_authorize` 就会有两个在飞二维码，而 `/wechat-mp/qr` 只服务"最近一个"——A 会话的页面显示 B 会话的二维码，扫完登进的是谁的号全看扫描顺序。这恰恰是§6.2 用"begin 有互斥"来排除掉、实则没排除掉的场景。
- **怎么推翻的、结果如何**：推送通路部分，我按提示逐个查了 `agent.inject`/`conversation.chat.node`/事件流/审批副作用——前两者与工具卡片无关，但 `@Remote stream`/`$events`/`resources` 三条是文档明确记载的通用推送面，足以否证"只能拉"的全称判断；树外包可用性双方都没有证据，应降级为待验证并加进 P0。单例路由部分，我把"多标签页"和"多会话"分开推演：前者共享同一宿主与同一 flow，无问题；后者取决于服务作用域，无证据，必须进 P0（现有 P0-9 只测路由连通性，测不出这个）。

#### R7 §11 目录选择的实现路径猜错了对象：文档里有现成的 `directoryPickerController`

- **反对的说法**：§11「自己实现的话，用 `ctx.fs` 列子目录，配一个简单的树形选择就够了」；证据索引里写 `ctx.workspaces`。
- **证据**：
  - workspace 参考页（https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/workspace ）记载了完整的目录选择服务链：`ctx.directoryPickerController` 承载 `ctx.remote.directoryPicker`，含 `@Remote('pick')`（原生 OS 选择器）、`@Remote('list')`（应用内浏览）、`@Remote('createDirectory')`；§11 自己点名的两个插槽 `sidebar.workspaces.directoryFlow`、`conversation.hero.workspace.directoryFlow` 经 slots 页核对**真实存在**，正是这套服务的 UI 面。方案该做的是复用/对照它，而不是用 `ctx.fs` 自研树。
  - `ctx.fs` 属实存在（filesystem 页：`resolve/stat/readText/listDir/writeText/editText` 等原语），但**没有任何文档说明树外包可以 inject 它**——作者自知的薄弱点，核验结论是：文档没写，风险未消除。而且它是宿主侧服务，§11 的目录选择发生在浏览器侧，浏览器侧列目录的正规通道是 `ctx.workspaceFiles`/`directoryPicker`，不是 `ctx.fs`。
  - 命名纠偏：宿主侧服务叫 `ctx.workspaceRegistry`（另有 `workspaceController`/`workspaceFiles`/`directoryPicker`）；`ctx.workspaces` 是**客户端 model** 的名字（web-client 页）。文档把它当宿主 ctx 的成员引用会误导实现。
  - 反向确认一条：§11「优先用 dsh 的设置子系统持久化」**已被文档坐实**（settings 页 `ctx.settings.register(ns, schema)` 返回可持久化的 `SettingsScope`；cookbook `adding-a-settings-card` 给了 `settings.plugin.item` 卡片的完整做法；`installSection()` 还能和 cordis.yml 分层叠加）。P0-12 的疑问句"能不能"其实已经有书面答案"能"，剩余待验证的只是"树外包实际操作一次"。
- **怎么推翻的、结果如何**：这正是任务说明里要求重点查的"作者薄弱点"，结论：`ctx.fs` 的名字和方法猜对了，但用它做浏览器侧目录选择是错位的；settings 子系统的乐观判断被证实；`ctx.workspaces` 命名有侧别错误。不推翻架构，但 §11 的"目录怎么选"一节应重写为围绕 `directoryPickerController` 展开。

#### R8 §15 P0-11 的前提与文档记载相反：插槽同名复用不是硬报错，是"有意替换"

- **反对的说法**：P0-11「同一个工具名重复注册插槽，是不是真的会硬报错？文档说'同一个工具名只能有一个生效的注册，重复会报错'。如果宿主里别的插件已经占了名字，我们就装不上」。
- **证据**：slots 参考页原文：「复用已有 cell 表示有意替换其展示」「将 `single` 和已有 occupant 的 keyed cell 视为替换点」「对于 `single`、`list` 和 `keyed` cell，`priority` 是遮蔽优先级」；硬性失败只发生在「向未声明 slot 注册，或重复声明其他 entry 已拥有的 child」。
- **怎么推翻的、结果如何**：核验代理穷尽了 slots 页后原样引文，结论与文档转述相反。风险方向因此反转：真正的风险不是"装不上"，而是我们的 `tool.call.toolview` 卡片可能**静默替换**别的插件（或宿主自身）对同一工具名的注册，或被 priority 更高者遮蔽。P0-11 应改写为测"替换/遮蔽行为"，§6.2 的设计也该考虑卡片消失时的可诊断性。

#### R9 §11 承诺的「看同步和抓取的进度」没有任何机制支撑

- **反对的说法**：§11「在 dsh 的网页界面里注册一个面板，用来做四件事：……3. 看同步和抓取的进度」。
- **证据**：jobs 参考页通篇没有 progress 概念（核验代理对全部页面 grep `progress` 零命中）；任务对外的可观测面是 `JobSnapshot`（`running/stopping/completed/killed/failed` + 自定 `detail`）和消费方拉取式的 `read`/`readOutput`；web-client 页明确 UI 经 control stream 只拿到「queue、job 与 projection update」——即**生命周期状态**，不是进度条数据。长任务一节也没有任何"界面如何获知进度"的内容。
- **怎么推翻的、结果如何**：先假设 jobs 有进度事件——没有；再假设 UI 从 job store 拿——只拿得到状态迁移。结论：进度面板要么降级为"任务在跑/已完成"的状态展示（零成本，走原生 store），要么复用 R6 里的插件自建通道（`@Remote stream` 或 `/wechat-mp/status` 同款路由上报进度计数）。方案现在既承诺了功能又没给通路，属于设计缺口而非措辞问题。

#### R10 §10 的一处归因错误 + E2 的 `onlyPending=false` 没有实现支撑

- **反对的说法**：§10「清单里的链接有时会带 `&chksm=…&scene=…` 之类的参数，已经被 `normalizeWechatUrl` 处理掉了」；§12 E2「内部就是调用现有的 `runList`」（参数里有 `onlyPending`，默认 true）。
- **证据**：
  - `src/sources/wechat.ts:79`：`normalizeWechatUrl` 返回 `` `https://${WECHAT_HOST}${parsed.pathname}${parsed.search}${parsed.hash}` `` ——**完整保留查询串**，一个参数都不剔。真正去参的是 `articleId()`（`wechat.ts:244-247` 的 `split('?')[0]`）。文档结论（"URL 去重对追踪参数鲁棒"）依然成立，但归因错了对象——顺带说明：被抓取的 URL 本身会带着 `chksm` 去请求，这无害，但文档的表述会误导读者以为入参被清洗过。
  - `src/cli.ts:68-149` 的 `runList` 只有一个硬编码行为：`status === 'done'` 跳过。没有"强制重抓"开关。`onlyPending=false`（全部重抓）按 §12 的说法"内部就是调用现有的 runList"是做不到的，要么改 `runList` 签名，要么删掉这个参数。
- **怎么推翻的、结果如何**：逐行读 `normalizeWechatUrl` 与 `runList`，无争议。扩展字段本身（`aid`/`title`/`publish_time`/`fakeid`）我专门核验过**没有问题**：`loadUrlList` 对对象条目原样透传（`urlList.ts:80`），`runList` 只就地改 `status/source/output/updated_at` 并 `delete item.error`（`cli.ts:127-143`），`saveUrlList` 序列化整个对象（`urlList.ts:89-91`），单测里也有 round-trip 用例——所以第 10 节的核心主张（"加字段不用改代码"）成立，以上两点是局部修正。

### 轻微

#### R11 §8.1 A1「刚登录就提示失效」的因果链断了

- **说法**：A1 断言双份 Cookie「一旦手动维护的那份跟不上容器里的最新状态，就会出现'刚登录就提示失效'这种很难复现的问题」。
- **证据与推翻过程**：代码事实全部核实（`WeChatMpService.cs:29-35` 容器 + `UseCookies=true`；`:309/:394/:461` 手动 `Cookie` 头；`:332-341` 快照；`SetCredentials` 反向解析进容器）。.NET 8 的 SocketsHttpHandler 会把手动 Cookie 头与容器 Cookie **合并发送**（.NET Core 3.0+ 行为），所以"同一请求带两份同名 Cookie"属实。但"刚登录就失效"推不出来：`BizLoginAsync` 在 L247 先 `SaveCookiesFromContainer()` 快照、L272 再取一次——**登录时刻两份内容按构造就是一致的**，之后才谈得上漂移；漂移是否真的发生取决于微信后台是否在会话中途 `Set-Cookie` 以及服务端对重复 Cookie 名的取舍，两者均无证据（这个工具显然能用，说明重复通常被容忍）。**结论：不是"冗余但无害"，也不是必然出 bug——是真实的坏味道 + 条件性风险，但文档把条件性风险写成了既有故障，且给出的具体症状无依据。** 应降级表述。

#### R12 §8.1 A2 的具体失败场景在本仓找不到并发路径

- **说法**：「如果并发下载时，一个任务正在用 `_token` 拼 URL，另一个任务把它设成了 null，就会发出空 token 的请求」。
- **证据与推翻过程**：全仓读 `_token` 的写点只有 `SetCredentials`、`BizLoginAsync` 成功分支、两处 `ret==200003` 清空——全在搜索/列文章路径；下载走 `DownloadArticleHtmlAsync`/`DownloadResourceAsync`，**不读 `_token`**（`WeChatMpService.cs:496-537`）。列文章与下载在 WinForms 里也不并行（下载的输入来自已加载完的列表）。所以"A2 描述的竞态"在这个代码库里没有真实触发路径；可变单例会话仍是值得修的设计味道（建议保留），但"引发连锁失败"的场景是构造出来的。这跟 R11 是同一类毛病：**方向对、症状编**。

#### R13 §7.1 第 2 条的前提不成立："Core 只依赖前两层的抽象"

- **证据**：Core 层直接依赖具体类，没有任何接口抽象——`ArticleService` 构造函数收 `WeChatMpService`、`LocalStorageService` 具体类型（`ArticleService.cs:28-31`）；`DownloadService` 直接持有 `ArticleExporter` 具体类型（`DownloadService.cs:26`）。
- **推翻过程**：grep 全部 Core 构造函数，无 interface。四层分层作为"分层意识"仍可借鉴，但"和 dsh 三角色是一样的结构、可以直接映射"的断言建立在一个不存在的事实上，借鉴价值要打折扣。

#### R14 §7.1 第 3 条把两个枚举混成一个：「7 个状态」列出了 8 项

- **证据**：文档列举的"未下载/等待中/下载中/导出中/成功/失败/已跳过/已取消"是**文章级**的 `DownloadStatus` 枚举，共 **8** 值（`ArticleInfo.cs:231-272`）；真正的"任务状态机"`TaskStatus` 是另外 7 值：Pending/Running/Paused/Cancelled/Completed/**PartialFailed**/Error（`DownloadTaskInfo.cs:129-165`）。讽刺的是 `PartialFailed` 正是 A7 里被无条件覆盖掉的那个状态，而它没出现在文档的清单里。
- **推翻过程**：读两个枚举定义即证。这条要修，因为文档据此给出映射建议（"映射到 ctx.jobs 的任务状态和 url-list.json 的 status"），引用错枚举会让映射设计失去参照。

#### R15 三处"文档没说过"的规范转述

- 「包名前缀约定是 `dsh-`」（§6.1、§9）：publish 页无此前缀约定，只有示例包名用了 `dsh-hello-plugin`。叫 `dsh-wechat-mp` 没问题，但"约定"二字无出处。
- 「默认 `127.0.0.1:3080`」（§6.2）：`127.0.0.1` 默认属实（web-server 页："host 只接受 127.0.0.1（默认姿态）和 0.0.0.0"），但**端口 3080 在全部已抓页面中零命中**，无出处。
- 「会话类记录用 `CredentialKey`」（§6.1）：credentials 页的原话是 CredentialKey 回答 "what credential does this plugin hold for this id"，没有"会话类/环境类"的二分措辞；实质无误，转述失真。

#### R16 §15 P0-6 的「turtle-ui 已经 404」两处都不实

- **证据**：dsh 仓库与文档站全文检索 `turtle-ui` 零命中（文档从没提过它）；`github.com/turtle-ui/turtle-ui` 实测 HTTP 200，内容是一个 GitHub profile 配置仓库——不是 404，也和 dsh 无关。文档想说的本质（没有官方第三方前端示例）反而是对的，而且被 cookbook 原文直接坐实：「没有已发布的预设暴露该包，因此本仓库之外的包得自行复刻同样的输出格式」；client-modules 页给的现成例子是仓库内路径（`packages/client/ui-theme`、`ui-settings-plugins`）。
- **推翻过程**：让核验代理实际请求了 turtle-ui 的 GitHub 页面并在仓库内全文搜索。结论：论点保留，论据换掉。

#### R17 §1 的「16 处」与 §8 的实际清点不符

§8.1 七条 + §8.2 十二条 = 19 处，§1 说「16 处可以复现的缺陷和死代码」。且其中 A5（见 R3）经核验不成立，A1/A2 的症状表述过重（R11/R12），真正经得起逐行核验的是 A3/A4/A6/A7 全部 + 12 条实现级缺陷全部（我逐条核过：串行图片 `ArticleExporter.cs:346-429`、扩展名只看路径 `:602-611`、正则改 HTML `:340-416`、TXT 正则 `:438-466`、无正文选择器 `:108-113`、全仓无 `code-snippet`（grep 零命中）、无 Markdown（`DownloadOptions.cs:18-33`）、PuppeteerSharp 仅 using（`:15-16`，csproj:12 确为 19.0.2）、CacheService 零调用 + `OfficialAccountService.cs:118/126` 同样零调用、暂停空操作 `:296-313`、清凭据写新对象 `ConfigurationService.cs:136`、PDF 仅 Windows `:246-271` + `FindEdgeExecutable` 零调用）。§8 的主体是扎实的，恰好是**最被渲染的两三条**出了问题。

#### R18 §8.2「标签重复时会误替换」的机制举例不准

`ArticleExporter.cs:365-384/401-416` 的 `html.Replace(fullTag, newTag)`：若两个 `<img>` 标签字符串完全相同，则它们的 `data-src`/`src` 也相同，`downloadedImages` 去重后指向同一个本地文件，双双替换到同一目标——结果反而是对的。真实的脆弱点是：处理第 N 个匹配时若某个更早匹配的标签字符串是它的子串且已被替换，`Replace` 变成空操作，图片留在远端 URL。"结论（正则改 HTML 脆弱）"成立，"机制举例"不成立。

#### R19 §3 的「2017 年 6 月 6 日」无法核验

公众号可在图文里链接"任意已群发文章"这一能力有公开资料佐证（如知乎《微信公众平台基础知识》："链接可以是任意已群发图文消息链接"），但具体到"2017-06-06 起对所有公众号开放"的日期，公开检索未能找到出处。该断言不承重（承重的是 C# 实现里 `searchbiz`+`fakeid` 本身），标注存疑即可。

---

## 三、已核验为属实的关键断言（抽样列举，供对照）

为避免"审阅=挑刺"的误读，以下断言经逐条核验**成立**：

- §4 统计口径与全部单文件行数（22 个 `.cs` / 6027 行，`find … -not -path "*/bin/*" -not -path "*/obj/*"` 逐字复现）；`PuppeteerSharp 19.0.2`（Core.csproj:12）。
- §5 的全部行号引用（`wechat.ts:102-132/168-186/229-295/244-247/282-285`、`cli.ts` 批量续爬与 sitemap 段、`images.ts` 并发保序 + `wx_fmt`）。
- §6.1 的 apply(ctx)、`defineTool`/`inject:['tools']`/`ctx.tools.register`、参数预校验、`exec.signal`、Config+Schemastery、credentials 两键空间与 `modifyRecord` 唯一写路径、`registerFlow`/`begin`/`ALREADY_IN_FLIGHT`（源码 `authorization/src/index.ts:294-297` 逐字）、打包声明与四种安装方式、"不要预防性拆分"。
- §6.2 的四个"确认"（`dsh.client`+`exports["./client"]`、树外包可加入扫描、`ctx.slots.inject/register` 与 `tool.call.toolview` 插槽、`ctx.webServer.register` 及 disposer）以及"授权接口无图像通道"（`types.ts:19-62`：通知只有 message/url/code，提问只有 text/secret/select）。
- §7.2 接口契约主体：`searchbiz`/`appmsgpublish` 端点与参数、三层嵌套 JSON 解析链（`ApiResponseModels.cs:41-81` 与 `ArticleService.cs:128-154` 精确对应）、`ArticleInfo` 字段全集（14-153）、`publish_time=0` 回退（`:75`）、`200003` 双处（`:403-408`、`:470-475`）、附录 A 登录五步参数（含 `sessionid=毫秒时间戳+随机数`，`:103`）、附录 B 全部行号。
- §7.3、§7.4 的死配置结论（`RequestInterval` 全仓无读取、`RetryCount` 仅 `DownloadService.cs:102` 展示赋值、`IsCacheValid` 零调用点）——grep 全仓证实。
- §10 的核心主张：扩展字段全链路兼容（见 R10）；`runList`/`fetchWechatArticle`/`WechatSource`/`UrlListItem`/`FetchOptions` 均已从 `src/index.ts` 导出；`urlList.ts:19` 确有索引签名。
- 项目版本 v3.0.0（package.json）、`tests/e2e` 存在且与 §17 的"默认跳过"说法一致。

## 四、作者没问到、但应当补进方案的问题

1. **Camoufox 在宿主进程里的运行性没有任何验证项。** 整个 P0 清单都押在 L1 和前端上，而 L2 被当作"现成的、一行不用改"。可 `wechat.ts:212` 是对 `camoufox-js` 的**动态 import** + 启动一个无头 Firefox：宿主环境里这个依赖装不装得上、浏览器二进制（百 MB 级）怎么下载、渲染崩溃会不会连带拖垮 dsh 进程——一个探针都没有。建议加 P0-13：在宿主进程内跑通一次 `fetchWechatArticle`。
2. **`spider-claw` 怎么进入插件的部署。** D1 建议插件独立建仓，那么 `import 'spider-claw' from 'spider-claw'` 要求它被发布到 npm 或以 file:/打包方式随插件分发——本项目没有发布的证据，且 package.json 的 exports 只有 `import` 条件（纯 ESM）。§10 只把"同进程"列为缺点，完全没给依赖落地方案。
3. **`url-list.json` 的跨会话并发写。** `runList` 每处理一条就整文件回写（`cli.ts:144`）。两个 dsh 会话同时跑 E2/E3-4，后写者会覆盖前写者的状态回写——恰是 C# A2 的教训在文件层面的重演。插件侧需要一个进程内互斥（或文档声明"同一时刻只允许一个抓取会话"）。顺带：§12 里 `listPath` 默认 `./url-list.json`，相对谁的 cwd 解析（宿主进程还是工作区）没说，应与第 11 节的输出根目录共用同一套解析规则。
4. **树外包能否注册 `@Remote`/网关命名空间。** 这是 R6 的钥匙：如果可以，二维码状态推送和 R9 的进度上报都有比 HTTP 轮询更顺的文档化通路；如果不行，现有 `/wechat-mp` 路由设计才真正"最优"。现在这个决定性问题悬空，建议直接列为 P0-14。
5. **二维码 `<img>` 的缓存。** 二维码过期重取后 URL 不变，浏览器可能继续显示旧图。§13 的轮询循环里需要 cache-busting（如 `?ts=`）或以 status 响应驱动 `img` 重载。一行代码的事，但按 §6.3 照抄 `<img src="/wechat-mp/qr" />` 会踩。

## 五、措辞与格式

- §1「16 处」vs §8 合计 19（见 R17）。
- 「列文章」的出处行号三种口径（§7.2 `435-455`、附录 A `425-487`、附录 C `425-455`）：指的是同一方法的不同片段（方法体实为 `WeChatMpService.cs:425-487`），建议统一标注方法范围 + 参数段。
- §7.2 扫码状态表的出处 `FrmLogin.cs:118-141` 实际到 163（见 R4）。
- §6.1「会话类记录」「dsh- 前缀约定」「127.0.0.1:3080」三处转述失真（见 R15）。
- §8.1 A1 的「有意思的是，配套那篇文章专门警告过这个做法」——那篇文章不在核验范围内，无法核验。

## 六、无法核验清单

| 事项 | 原因 |
|---|---|
| 端口 3080 默认值 | 文档站全部页面 grep 零命中；仅 `127.0.0.1` 默认有记载 |
| 「配套的那篇文章」的所有引述（含"文章推荐的先停后启""文章专门警告过"） | 文章未提供 |
| 2017-06-06 开放全平台超链接的日期 | 公开检索未找到出处（能力本身有佐证，见 R19） |
| 树外包能否 import `@deepseek-ai/dsh-credentials`（文档 P0-8）与能否注册 `@Remote`（本审阅新增） | 文档站与已抓源码均无记载，维持待实测；后者建议入 P0 |
| client 相关包 README（client-modules 页明说浏览器半细节"记录在包 README 中"） | 未抓取（不影响以上结论，P0-6 实测前建议补读） |
| `tool.call.toolview` 的 cardinality/分发键的权威定义 | 仅存在于生成的 inspect catalog，未发布为文档页；Agent Note 为次级证据 |

---

*审阅依据：本地全部行号引用均实际读取核对；dsh 文档站 11+ 个页面与 GitHub 仓库 20 余个源文件于 2026-09-22 实际抓取（curl/raw），关键结论均有逐字引文留存。文中"推理性结论"已在相应条目显式标注。*
