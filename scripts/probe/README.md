# P0 探针（一次性工具）

这个目录回答 `docs/wechat-mp-plugin-evaluation.md` 第 15 节里的 **P0-1 ~ P0-5、P0-7**。

**它不是产品代码**：不进 `src/`、不进 CI、不进 `pnpm typecheck`（`tsconfig.json` 的 `include` 只覆盖 `src` / `tests` / 两个 config 文件）。它是用来"问现实"的。

## 快速开始

```bash
# 1) 先确认你能扫那个码（需要你本人是该公众号的管理员或运营者）
# 2) 跑探针，把 - 后面的参数换成目标公众号
pnpm probe:mp -- --query "某个公众号的昵称"
```

跑起来会做这些事：

1. `startlogin` → `getqrcode`：二维码写到 `scripts/probe/out/qrcode.png`
2. 打印一行 `open "..."` 命令 —— **你复制到终端执行，用微信扫码，手机上点确认**
3. 脚本自动轮询状态直到你确认
4. `bizlogin` 拿 token → `getprofile` 拿昵称
5. `searchbiz` 搜号 → `appmsgpublish` 列文章，顺手把 P0-3 / P0-4 / P0-5 都测了

跑完终端最后会打印一份**结论汇总**，同时写到 `scripts/probe/out/summary.txt`。

## 常用参数

| 参数 | 作用 |
|---|---|
| `--query "<昵称>"` | 要搜的公众号（用昵称或微信号都行） |
| `--fakeid <id>` | 跳过搜索，直接用已知的 fakeid |
| `--counts 5,20,50` | 测 `count` 上限时用哪几个值（默认 `5,20,50`） |
| `--pages 3` | 正常节奏翻几页（默认 3） |
| `--page-delay 3000` | 翻页间隔毫秒（默认 3000） |
| `--hammer` | **额外做 P0-2**：不发延时连打 12 次，试探频控阈值。**有触发风控的可能，只在你想测的时候加** |
| `--fresh` | 忽略已保存的 session，强制重新扫码 |
| `--poll-interval 2000` | 轮询扫码状态的间隔毫秒 |

## 复用 session（P0-4 就靠它）

第一次跑完会把 token + cookie 写到 `out/session.json`（权限 0600）。之后**不扫码直接重跑**，脚本会先拿一个便宜接口探一下 token 还活着没：

- 还活着 → 打印"距今 N 天"并跳过扫码
- 返回 `200003` → 提示需要重新扫码

**P0-4 要问的是"token 真实寿命几天"，靠的就是隔几天重跑一次**，把每次运行打印的"距今 N 天"记下来，第一次报 `200003` 的那次就是寿命上限。

## 产物

| 路径 | 内容 |
|---|---|
| `out/qrcode.png` | 二维码图片 |
| `out/session.json` | token + cookie（**权限 0600**） |
| `out/summary.txt` | 结论汇总，可整段誊进结论文档 |
| `out/raw/*.txt` | 原始响应，**含敏感值**，只供本地排错 |
| `out/fixtures/*.json` | **脱敏后**的响应样本，将来可以拷进 `tests/fixtures/` |

**`out/` 整个目录已在 `.gitignore` 里。** 尤其是 `out/raw/` 和 `out/session.json`，绝对不能入库。

## 安全约定

- **token / Cookie 只在内存里流转，绝不打印到终端**（只打长度和 cookie 名字）。
- 脱敏规则：`token` / `cookie` / `nickname` / `nick_name` / `head_img` / `signature` / `alias` / `fakeid` / `cover` 等键的值整体替换；URL 只保留结构（把长 ID 段换成 `<ID>`，查询串只保留键名）。规则见脚本里的 `REDACT_KEYS` / `sanitizeUrl`。
- Cookie 只维护**一个** jar（参考实现踩过"双重 Cookie 管理"的坑，缺陷 A1）；请求头由 jar 派生，不另存第二份字符串。

## 这个脚本覆盖了哪些 P0

| 编号 | 怎么覆盖 |
|---|---|
| P0-1 | 整条链路能否跑通：`getqrcode` 返回合法 PNG、扫码轮询拿到 `status=1`、`bizlogin` 取到 token、`appmsgpublish` 三层嵌套解析出文章；同时打印实际字段集合 |
| P0-2 | 只在加 `--hammer` 时做：连打 12 次，记录第一个非 0 的 `ret` 和 `err_msg` |
| P0-3 | 同一 `begin` 分别用 `5 / 20 / 50` 请求，比对实际返回篇数 |
| P0-4 | 靠反复运行的"距今 N 天" + `ret=200003` 探测 |
| P0-5 | `searchbiz` 分别用 `count=5 / 20`，比对返回条数 |
| P0-7 | 不覆盖 —— `appmsg?action=list_ex` 是另一条端点，需要单独加探测（脚本里预留了 `appmsgpublish` 的参数构造，照着改即可） |

另外顺手核验了文档 7.2 节那张扫码状态码表（`0/1/2/3/4/5/6/其他` 与 `acct_size` 的关系）——脚本会把**本轮实际观察到的所有状态值**列出来，对照一下就知道表对不对。

## 还没做的

- **P0-7**：`appmsg?action=list_ex` 的对比探测（见上）
- **P0-6 / 9 / 10 / 11 / 12 / 14 / 15**：这些是 dsh 侧的，不需要这个脚本。本机已经有一份 dsh 检出（`.../stage-dsh-plugin-qa/deepseek-harness`），可以直接读源码核，结论记在 `docs/wechat-mp-probe-results.md`
- **P0-13**：Camoufox 在宿主进程内跑通。Camoufox 二进制已就位（611MB），单独验一次即可
