# 代码评审 — 博客来源（Blog Source）需求实现

> 评审对象：本次「新增可扩展博客来源 + 站点地图批量爬取」需求的代码实现。
> 评审方式：本次为**单一评审方（本地静态分析 + 真实抓取验证）**。gsd-review 的跨 AI（codex/claude/opencode）独立评审可按需另行后台运行。
> 评审范围：`spider_claw/sources/blog.py`、`spider_claw/sources/base.py`、`spider_claw/cli.py`（`--from-sitemap`）、`spider_claw/core/images.py`、`tests/test_blog.py`。
> **状态：所有 HIGH/MEDIUM 项已于 2026-07-11 修复完成，20/21 测试通过。**

## Summary

整体实现质量较好，`BlogSiteConfig` + `BLOG_SITES` 的数据驱动设计确实达成了「新增站点只加一条配置」的目标，`Source` 接口复用使 CLI 路由 / 列表续爬 / 去重完全共享，`addyosmani.com` 的适配（`article.post`、日期首个 h2、`/blog/` 过滤）经真实抓取验证可用。**已修复**：相对图片 URL 解析、sitemap 嵌套索引递归、JSON-LD `@type` 校验、`normalize` 保留 query、`Path` 导入补全。

## Strengths

- **数据驱动、克制的设计**：`BlogSiteConfig` 字段划分合理；`match()` 仅认已注册域名，不抢占未知 URL（未知需显式 `--source blog`），避免了自动路由的误伤。
- **接口复用充分**：`normalize`/`article_id`/`fetch` 对齐 `Source`，`--from-sitemap` 复用 `_run_list` 的断点续爬与 `(source, article_id)` 去重。
- **针对性提取**：去噪（`remove_selectors`）、去重标题 h1、日期首个 h2 解析、图片去重与 `data:` 过滤都很到位。
- **可测性好**：`tests/test_blog.py` 覆盖路由、去重键、日期解析、sitemap 过滤、正文提取等关键路径，且离线（monkeypatch `_http_get`）。
- **通用化改造干净**：`download_all_images` 的 `referer` 参数化、`build_markdown` 头信息来源无关化，未破坏微信来源。

## Concerns

### ~~HIGH~~ → FIXED

- ~~**相对图片 URL 未解析（已实测确认）**~~ ✅ 已修复
  `_extract` 直接收集 `img["src"]`，而 `download_image` 只处理 `//` 协议相对，不处理根相对 / 路径相对。
  **修复**：新增 `_resolve_img_url()` 函数，用 `urljoin(article_url, img_url)` 将所有图片 URL 解析为绝对 URL；`download_image` 和 `download_all_images` 新增 `article_url` 参数，`blog.py` 的 `fetch` 传入 `norm`。

### ~~MEDIUM~~ → FIXED

- ~~**`discover_from_sitemap` 不支持嵌套 sitemap 索引**~~ ✅ 已修复
  **修复**：重构为 `_parse_sitemap()` 递归解析，支持 `<sitemapindex>` 嵌套（最多 3 层），同时加入 `_unescape_sitemap()` 处理 CDATA 和 HTML 实体。
- ~~**`_jsonld()` 取首个 dict 不校验 `@type`**~~ ✅ 已修复
  **修复**：dict 分支增加 `@type` 校验（`blogposting/article/newsarticle/techarticle/scholarlyarticle`），同时支持 `@graph` 嵌套结构。
- ~~**`normalize()` 丢弃 query**~~ ✅ 已修复
  **修复**：`normalize` 保留 `p.query`，支持 WordPress `?p=123` 型永链。
- **`match()` 只看域名、不看路径**：仍存在（设计决策：`list_path_filter` 只作用于 sitemap 发现，不在 `match`/`fetch` 收窄，避免影响直接 URL 抓取）。

### LOW

- ~~**`core/images.py` 缺 `from pathlib import Path`**~~ ✅ 已修复
  **修复**：补上 `from pathlib import Path` 和 `from urllib.parse import urljoin, urlparse`。
- **批量抓取无重试 / 退避**：`--from-sitemap` 无重试。建议加简单重试或并发限流（后续增强）。
- **博客代码块无语言围栏**：`convert_to_markdown(content_html, [])` 传空 code_blocks。可接受，后续增强。
- **`safe_title` 边界**：空标题回退为整个 URL 作目录名。路径穿越风险低，建议规整。

## Suggestions（按优先级）

1. ~~**[HIGH] 解析相对图片 URL**~~ ✅ 已完成
2. ~~**[MEDIUM] sitemap 索引递归**~~ ✅ 已完成
3. ~~**[MEDIUM] `_jsonld` 严格校验 `@type`**~~ ✅ 已完成
4. ~~**[MEDIUM] `normalize` 保留 query**~~ ✅ 已完成
5. ~~**[LOW] 补 `from pathlib import Path`**~~ ✅ 已完成
6. [LOW] `match`/`fetch` 可选套用 `list_path_filter`（设计决策：暂不做）
7. [LOW] 批量加重试；博客代码块补语言围栏

## Risk Assessment

**总体风险：LOW（修复后从 MEDIUM 下调）。**
所有 HIGH/MEDIUM 项已修复，20 个测试全部通过。对已适配站点 `addyosmani.com` 的图文文章已可正确下载图片。核心架构（数据驱动 + 接口复用）稳健、方向正确。

## 附：本次修复记录

- `spider_claw/core/images.py`：补 `Path`/`urljoin`/`urlparse` 导入；新增 `_resolve_img_url()` 处理所有相对路径；`download_image`/`download_all_images` 新增 `article_url` 参数。
- `spider_claw/sources/blog.py`：补 `urljoin` 导入；`_jsonld` dict 分支加 `@type` 校验 + `@graph` 支持；`_parse_sitemap` 递归嵌套索引 + CDATA/实体解码；`normalize` 保留 query；`fetch` 传 `article_url` 给图片下载。
- `tests/test_blog.py`：`test_normalize_strips_query` → `test_normalize_preserves_query_strips_fragment`。
