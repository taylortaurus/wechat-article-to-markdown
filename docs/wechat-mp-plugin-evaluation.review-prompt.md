# 独立审阅任务：微信公众号文章批量下载 dsh 插件方案

## 你的角色

你是这次方案评审的独立审阅者。你的任务不是总结、不是夸奖、也不替我润色文档，而是**证伪**：找出这份方案里站不住、说不通、被遗漏、或者被作者过度自信地断言的地方。

请按审阅者的心态工作，而不是助手的心态。对每一条结论都先问：**作者凭什么这么确定？我能不能把它推翻？**

## 背景（必读，否则你会误判）

我们要给 **DeepSeek Harness（简称 dsh）** 写一个插件，用来批量下载微信公众号的文章。dsh 是一个基于 Cordis 框架的 AI Agent 宿主，插件是 TypeScript 模块，最终要交付给用户使用。

方案融合了三个来源：

| 来源 | 位置 | 提供什么 |
|---|---|---|
| 参考实现 | `references/AppWeChatArticleDownloader/`（C# / .NET 8 / WinForms，**只读，不要改动**） | 思路和接口契约，同时也是反例 |
| 宿主生态 | dsh 官方文档与官方源码（在文档站和 GitHub 上） | 插件的形态和骨架 |
| 要融合的项目 | 本仓库根目录 `spider-claw`（TypeScript） | 能力底座和输出：反爬抓取、正文提取、Markdown 转换、图片本地化、断点续爬 |

关键区分：`references/` 里那个 C# 项目是**另一个技术栈的参照物**。我们不会移植它的代码，只借鉴思路。审阅时请守住这条线——如果某个建议实质上是"把 C# 的实现搬过来"，那它就是错的。

## 待审产物

`docs/wechat-mp-plugin-evaluation.md`

这是一份**评估 + 实施方案**文档，状态是"待裁决"，还没有开始写代码。共 20 节 + 3 个附录。请完整读完再动手。

## 可核验的数据链路（本次审阅的重点）

文档里每一条结论都标注了出处。**请逐条去核，不要相信作者的转述。** 数据链路分三段：

### 第一段：本地文件（只读）

**A. 参考实现** `references/AppWeChatArticleDownloader/`

重点核查对象：

- `AppWeChatArticleDownloader.Infrastructure/Http/WeChatMpService.cs` —— 登录四步 + 搜索 + 列文章（545 行）
- `AppWeChatArticleDownloader.Core/Articles/ArticleService.cs` —— 嵌套 JSON 解析、分页
- `AppWeChatArticleDownloader.Core/Downloads/DownloadService.cs` —— 并发控制、任务状态机
- `AppWeChatArticleDownloader.Core/Exporters/ArticleExporter.cs` —— 导出格式、图片下载
- `AppWeChatArticleDownloader.Models/*.cs` —— 数据模型
- `AppWeChatArticleDownloader.WinForms/Forms/FrmLogin.cs` —— 扫码轮询
- `AppWeChatArticleDownloader.WinForms/Forms/FrmMain.cs` —— 主界面编排

注意：`bin/` 和 `obj/` 是编译产物，统计行数和文件数时要排除。

文档第 4 节说"22 个 `.cs` 文件，共 6027 行"。作者的统计口径是：

```
find . -name "*.cs" -not -path "*/bin/*" -not -path "*/obj/*"
```

请核对这个口径是否正确。

**B. 本项目** `src/` 与 `docs/wechat-source-design.md`

- `src/sources/wechat.ts`、`src/core/urlList.ts`、`src/core/images.ts`、`src/index.ts`、`src/cli.ts`、`src/sources/base.ts`

文档第 5 节和第 10 节有多处关于本项目 API 的断言（例如"`UrlListItem` 带索引签名，所以能加扩展字段"、"`src/index.ts` 已导出所有需要的符号"）。**请逐个到 `src/` 里验证。**

### 第二段：dsh 的远程资料（需要联网）

**文档站（中文）：**

- 插件基础：https://deepseek-harness.github.io/deepseek-harness/develop/basic/
- 开发一个工具：https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool
- 插件配置：https://deepseek-harness.github.io/deepseek-harness/develop/basic/config
- 打包与安装：https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish
- 能力的三种角色：https://deepseek-harness.github.io/deepseek-harness/develop/practice/
- 工具编写参考：https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool
- 用户凭据：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/credentials
- Client 模块：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules
- 客户端 Slots：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots
- HTTP 服务器：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-server
- Web Client 架构：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client
- 参考总索引：https://deepseek-harness.github.io/deepseek-harness/reference/

**GitHub 上的官方源码**（文档里几条关键结论依赖这些）：

- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/credentials/authorization/src/index.ts
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/credentials/authorization/src/types.ts
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/client/ui-tool/package.json
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/client/modules/package.json
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/client/tsdown.client.ts
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/client/web/src/platform.ts
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/.agents/notes/implemented/architecture/2026-08-23-client-derived-tool-presentation.zh.md

### 第三段：作者的诚信边界（决定你该把火力放在哪）

以下是作者读资料的实际情况。**请据此判断哪些结论有底气、哪些是在踩薄冰。**

**A. 逐字读过全文的**（结论比较可信，但仍可能有理解偏差）：

`develop/basic/` 四页、`develop/practice/`、`reference/cookbook/adding-a-tool`、`reference/subsystems/` 下的 `credentials`、`client-modules`、`slots`、`web-server`、`web-client`，以及上面列出的那几个 GitHub 源码文件和那份 Agent Note。

**B. 只见过"它存在"、没读正文的**（**作者的薄弱点，请重点查**）：

| 文档引用了什么 | 实际情况 |
|---|---|
| `ctx.fs`（第 11 节用来说"用 ctx.fs 列子目录做目录选择"） | 只在 `reference/` 索引页的导航列表里见过 `reference/subsystems/filesystem` 这个链接，**没读正文**。它到底叫什么、能不能被树外包用、在浏览器侧能不能调用，都没核。 |
| `ctx.workspaces`（第 11 节说"默认输出放在工作区目录下"） | 同理，只在导航列表里见过 `reference/subsystems/workspace`，没读正文。 |
| dsh 的 settings 子系统（第 11 节说"用户改的输出目录优先用 settings 子系统持久化"） | 只在导航列表见过，以及 `reference/cookbook/` 里一个叫「新增设置卡片」的页面标题。**没读正文。** |
| `ctx.jobs` 的完整约定 | 读的是 `adding-a-tool` 里「长时间运行的工作」那一节，**没读 `reference/subsystems/jobs` 子系统页本身**，可能漏掉细节。 |
| 工具执行流水线、扩展点 | 只在 `adding-a-tool` 里读到概述，没读 `reference/subsystems/tools` 和 `reference/tool-execution-pipeline`。 |

**C. 完全没有实测过的运行时事实**（文档第 15 节列的 12 项 P0）：

包括微信后台那几个接口现在还能不能用、频控的真实错误码、`count` 上限、登录凭证的真实寿命、最小前端包能不能被宿主加载、`prefix` 路由会不会和 SPA 兜底冲突等等。

**这 12 项在文档里已明确标注为"待验证"，是设计的一部分，不是文档的缺陷。** 请不要把它们当作错误来报——除非你能指出某一项**根本不该等实测就该提前定下来**，那属于设计问题，可以报。

## 已经拍板、不要重新讨论的前提

用户在上一轮已明确回答三个问题，这些是**前提**，不是待议项：

1. **两种使用方式并存**：一是扫码搜号后批量下载**某一个公众号**的文章；二是消费 `url-list.json` 批量下载列表里的文章，**列表里不一定是同一个号，所以这条链路不需要扫码**。
2. **输出目录必须可配置**。插件要提供界面入口让用户选下载根目录，或用可配置的默认值。**禁止硬编码路径。**
3. 有了三种使用方式之后，架构需要相应调整。

如果你认为这些决定本身会导致方案走不通，**可以指出**（那属于重大问题）；但不要提"要不要支持第二种用法"这类已经定了的问题。

## 请重点攻击的方向

按价值排序，前两个是作者最没底的地方：

**1. 第 6.2 / 6.3 节的二维码方案。**

作者的推理是：注册到 `tool.call.toolview` 的卡片在工具执行期间拿不到结果数据，而且没有"执行中途推送"的通道，所以二维码只能由卡片主动去拉——插件自己开一条同源 HTTP 路由，卡片里放一个 `<img>`。

- 这个推理链条完整吗？是不是漏掉了 dsh 里某种"执行中途向界面推数据"的机制（比如 `agent.inject()`、`conversation.chat.node`、事件流、审批机制的副作用）？
- 单例路由（`/wechat-mp/qr` 不带任何 ID）真的安全吗？多个浏览器标签页、多个会话并发时会发生什么？
- `ctx.webServer` 的 `prefix` 路由注册之后，和 SPA 兜底、和插件的加载/卸载生命周期会不会打架？

**2. 第 6.3 节的前端构建契约。**

作者是从 `packages/client/tsdown.client.ts` 的注释和代码里**反推**出产物形态（闭包工厂 + banner/footer）和那 10 项外部依赖白名单的。官方**没有第三方可用的预设包**，而且**没找到任何官方的第三方示例仓库**（文档里提到的 `turtle-ui` 已经 404）。

- 反推出的产物形态够不够？**是否遗漏了让界面能正常工作所必需的东西？**
- 那 10 项白名单和 banner/footer 是否就是全部约束？还有没有别的运行时要求（比如必须导出什么名字、注册顺序、sourcemap 的具体格式、资源怎么加载）？

**3. 第 2 节的"登录边界"结论。**

作者断言「正文页 `/s/xxx` 游客可见，所以 L2 抓取链路完全不需要登录」。这个断言对**所有**微信文章都成立吗？有没有哪类文章会让这个前提失效，进而让"L2 永久免登录"这个架构基石塌掉？

**4. 第 10 节的 `url-list.json` 衔接方案。**

作者加了一批扩展字段（`aid`、`title`、`publish_time`、`fakeid`），依据是 `UrlListItem` 带索引签名。请实际读代码验证：加这些字段后，`loadUrlList`、`saveUrlList`、`runList` 的去重逻辑、以及 `status` 的回写，是不是真的都正常？还有没有别的地方会被这些字段搞坏？

**5. 第 7 / 8 节对 C# 源码的判断。**

作者列了 7 条架构级缺陷、12 条实现级缺陷，都写了具体的 `文件:行`。请抽查若干条，看有没有**归因错误**或**说过头**的地方。

作者自己最担心被反驳的一个例子：缺陷「A1：Cookie 管了两遍」——断言同时用 `CookieContainer` 又手动加 `Cookie` 头会导致"刚登录就提示失效"这类 bug。这到底是**真的会出问题**，还是只是**冗余但无害**？如果是后者，作者就把它说重了。

**6. 第 7.1 节的 7 条"架构级借鉴"。**

这 7 条是作者自己归纳的，不像接口契约那样有硬证据。请判断它们是不是真的值得借鉴，还是作者在给一个普通项目硬找优点。

## 不要做的事

- **不要重写文档。** 只需给出发现。
- **不要把"还没实测"当成错误**（见第三段 C 点）。
- **不要提已经拍板的前提**（见上面的前提清单）。
- **不要建议移植 C# 的代码**，也不要建议把本项目已有能力重写一遍。
- **不要只报措辞、格式、错别字问题。** 那些可以单独列一小节，但不要占主要篇幅。
- **不要在没有核验的情况下附和作者的结论。** 如果你读不到某个来源，就说读不到。

## 输出要求

把审阅结果写成文件：`docs/wechat-mp-plugin-evaluation.review-zcode.md`

格式：

1. **开头一段结论**：这份方案整体能不能照着做？最大的风险是哪一条？
2. **发现清单**，按严重程度从高到低排。每条包含：
   - 严重程度：**阻断**（会导致方案作废）/ **重大**（会导致返工）/ **中等**（需要补上）/ **轻微**（措辞或小遗漏）
   - 你反对或补充的具体说法，**引用文档的节号**
   - 你的证据（本地文件路径加行号，或远程 URL）
   - **你尝试怎么推翻它、结果如何** —— 这一栏必须写。如果是靠推理而不是靠证据得出的结论，请明说
3. **作者没问到、但你认为重要的问题**（你自己发现的漏洞）
4. **措辞和格式问题**（简短列出即可）

## 无法核验的时候怎么办

如果某个来源读不到（网络不通、页面 404、文件不存在），**明确写"无法核验"并说明原因**，不要猜，也不要因此就默认作者是对的。

如果整份文档都读不到，直接停下来说明，不要凭猜测写审阅意见。
