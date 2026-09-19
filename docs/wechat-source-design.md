# 微信公众号来源（WeChat Source）设计与实现

> 项目最早的来源实现，核心难点是**反检测抓取**与**公众号特有的 DOM 结构解析**。

## 1. 概述

微信文章（`mp.weixin.qq.com/s/...`）页面由 JS 动态渲染，且对自动化抓取有较强风控（验证码、内容隐藏）。`WechatSource` 的解决方案：

- 用 **Camoufox**（基于 Firefox 的反指纹浏览器）渲染页面，规避基础反爬；
- 解析固定正文容器 `#js_content`，处理懒加载图片与「图片化」代码块；
- 元数据（标题/作者/时间）来自固定 DOM 节点与内联脚本；
- 图片下载携带 `mp.weixin.qq.com` 的 `Referer` 以通过防盗链；
- 触发验证码时保存原始 HTML 到 `debug.html` 便于排查。

## 2. 总体流程

```
WechatSource.fetch(url, output_dir, no_proxy)
  ├─ 校验 url 前缀 https://mp.weixin.qq.com/
  ├─ AsyncCamoufox(headless=True)        # 反检测浏览器
  │    ├─ page.goto(url, wait_until="domcontentloaded")
  │    ├─ wait_for_selector("#js_content", timeout=10s)  # 等正文
  │    ├─ sleep(2)                        # 等 JS 执行
  │    └─ page.content()                  # 取完整 HTML
  ├─ BeautifulSoup 解析
  ├─ extract_metadata(soup, html)        # 标题 / 作者 / 发布时间
  │    └─ 标题为空 → 保存 debug.html 并抛错（疑似验证码）
  ├─ process_content(soup)               # 正文预处理
  ├─ convert_to_markdown(content_html, code_blocks)
  ├─ download_all_images(..., referer="https://mp.weixin.qq.com/")
  ├─ replace_image_urls(...)
  └─ build_markdown(meta, md)            # 写文件
```

## 3. URL 归一化（`normalize_wechat_url`）

公众号文章 URL 常因复制粘贴污染，需清理：

- 去除包裹的引号 / 尖括号；
- 还原终端（zsh 等）自动转义的 `\\&`、`\\?`、`\\=` 等；
- 解码 HTML 实体（`&amp;` → `&`）；
- 允许裸 `mp.weixin.qq.com/...`（补全 `https://`）；
- 强制 `https` scheme。

```python
def normalize_wechat_url(raw: str) -> str:
    ...  # 见 spider_claw/sources/wechat.py
```

`match(url)` 仅对 `mp.weixin.qq.com` 主机名返回 `True`；`article_id` 以核心路径（去参/去锚/去尾斜杠）作为去重键。

## 4. 元数据提取

### 4.1 标题与作者（来自固定 DOM）

```python
title_el  = soup.select_one("#activity-name")   # 文章标题
author_el = soup.select_one("#js_name")         # 公众号名（作者）
```

二者均为微信页面固定节点，`get_text(strip=True)` 取得纯净文本。

### 4.2 发布时间（来自内联脚本）

微信把发布时间藏在页面脚本的 `create_time` 字段里，且可能是 `JsDecode(...)` 加密或纯数字时间戳：

```python
def extract_publish_time(html: str) -> str:
    # 1) JsDecode('...') 形式 → 解密为整数时间戳
    # 2) create_time: '1234567890' 纯数字
    # 3) create_time = "1234567890" / :"..." 兼容双引号与 = 赋值
```

时间戳经 `format_timestamp(ts)` 转换为 `YYYY-MM-DD HH:mm:ss`（**Asia/Shanghai, UTC+8**）。

## 5. 正文预处理（`process_content`）

输入 `#js_content` 容器，输出 `(content_html, code_blocks, img_urls)`。

### 5.1 懒加载图片

微信正文图片 `src` 常被替换为占位图，真实地址在 `data-src`：

```python
for img in content_el.find_all("img"):
    data_src = img.get("data-src")
    if data_src:
        img["src"] = data_src
```

### 5.2 代码块处理（图片/行号 → 源码）

微信「代码块」常被渲染成带行号、可能含 SVG 截图的 DOM（`.code-snippet__fix`），无法直接转 MD。处理：

1. 删除行号节点 `.code-snippet__line-index`；
2. 取 `pre[data-lang]` 的语言标识与 `code` 文本；
3. 跳过 CSS counter 泄漏的垃圾行（如 `counter(line`）；
4. 将整块替换为占位符 `CODEBLOCK-PLACEHOLDER-{i}`，保留 `(lang, code)`；
5. 后续由 `convert_to_markdown` 还原为围栏代码块（fenced code block）。

> 注意：部分代码块是**图片/SVG 渲染**，无法提取为源码，只能保留图片。

### 5.3 噪声移除

```python
for sel in ("script", "style", ".qr_code_pc", ".reward_area"):
    tag.decompose()
```

`script`/`style` 与二维码、打赏区等无关节点被剔除。

### 5.4 图片 URL 收集

遍历处理后的 `img[src]`，去重得到 `img_urls` 用于本地化。

## 6. Markdown 转换（共享核心层）

`convert_to_markdown`（位于 `core/markdownify_.py`，来源无关）将 HTML 转为 MD：

- `markdownify` 指定 ATX 标题、`-` 列表，白名单标签转换；
- 还原 `CODEBLOCK-PLACEHOLDER-{i}` 为带语言标识的围栏代码块；
- 清理 `&nbsp;`、多余空行、行尾空格。

最终 `build_markdown(meta, body_md)` 拼接头信息：

```markdown
# {title}

> 作者: {author}
> 发布时间: {publish_time}
> 原文链接: {source_url}

---
{body}
```

## 7. 图片本地化

```python
url_map = await download_all_images(
    img_urls, img_dir,
    proxy=None if no_proxy else _USE_ENV_PROXY,
    referer="https://mp.weixin.qq.com/",     # 防盗链必需
)
md = replace_image_urls(md, url_map)
```

- 并发下载（信号量限流），按序命名 `img_001.png` 等；
- 扩展名从 `wx_fmt` 参数或 URL 推断；
- `--proxy` 控制是否走环境代理（默认直连，连 `*_PROXY` 环境变量也一并忽略）；
- 下载后把 MD 中的远程图链精确替换为本地相对路径。

### 代理与环境变量（踩坑记录）

HTTP 客户端统一由 `spider_claw/core/http.py` 的 `async_client` / `sync_client` 构造：

- `proxy=None`（默认）→ `trust_env=False`，真正直连，不读任何环境变量；
- `proxy=_USE_ENV_PROXY`（`--proxy`）→ 读环境变量，先净化 `NO_PROXY`，仍解析失败则
  告警并降级为直连，不中断抓取。

原因：httpx 在**构造 Client 时**就把 `NO_PROXY` 转成 mount 规则，
`NO_PROXY` 中的 IPv6 CIDR（如 `::1/128`）会生成 `all://[::1/128]`，
解析时抛 `InvalidURL("Invalid port: ':1'")` —— 且 `httpx.Client(proxy=None)`
同样会读环境变量，因此连"直连"模式都会在建客户端时崩掉。

## 8. 反检测与验证码兜底

- 使用 `AsyncCamoufox`（Firefox 内核 + 反指纹），`headless=True`；
- 等待 `#js_content` 出现再取 HTML，超时也继续（尽力解析）；
- 若提取不到标题，判定可能触发验证码：保存原始 HTML 到 `output/debug.html` 并抛出明确错误提示。

## 9. 调用入口

- CLI：单条 `spider-claw "<url>"`、列表 `--list url-list.json`、显式 `--source wechat`；
- 模块级 `fetch_article(url, output_dir, no_proxy)` 供脚本/测试直接调用（自动归一化 URL）。

## 10. 已知限制

- 部分代码块是图片/SVG 渲染，无法转为源码；
- 高频抓取可能触发微信验证码，此时 `debug.html` 可供人工排查；
- 依赖 Camoufox 本地浏览器二进制（首次运行需下载）。

## 11. 相关文件

- `spider_claw/sources/wechat.py` — 微信来源实现
- `spider_claw/sources/base.py` — `Source` 抽象接口
- `spider_claw/core/markdownify_.py` — 通用 Markdown 转换与头信息
- `spider_claw/core/images.py` — 图片下载（Referer / 代理）
- `spider_claw/cli.py` — 路由与批量续爬
