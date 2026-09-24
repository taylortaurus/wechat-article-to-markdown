# Legacy: Python implementation

> ⚠️ **归档代码，仅作对照参考，不再维护。**

本目录是 spider-claw 的**历史 Python 实现**。项目已在分支 `dev-dsh-spider-claw` 上用
TypeScript 生态整体重构，可运行的实现位于仓库根目录的 `src/`，入口命令仍为 `spider-claw`。

保留这份代码的原因：

- 便于逐个模块对照重构前后的行为（见 `docs/typescript-refactor-report.md` 的映射表）；
- 重构期间用于「同一篇文章、两种实现」的产物 diff 验证；
- 微信来源的 Camoufox 抓取与公众号 DOM 细节在 Python 侧有更早的踩坑记录。

因此这里的内容**不参与构建、不参与 CI、不再接收修改**。若确认无人再需要对照，
可以整体删除本目录（git 历史里仍可找回）。

## 目录

| 路径 | 原位置 | 说明 |
| --- | --- | --- |
| `spider_claw/` | 仓库根 | Python 包（`cli.py` / `core/` / `sources/`） |
| `tests/` | 仓库根 | pytest 测试 |
| `pyproject.toml` | 仓库根 | 依赖与 console script 声明 |
| `uv.lock` | 仓库根 | uv 锁文件 |

## 若确实需要运行它（不推荐）

```bash
cd legacy/python
uv sync
uv run spider-claw "https://mp.weixin.qq.com/s/XXXXXXXX"
```

对应的设计文档仍在 `docs/wechat-source-design.md`、`docs/blog-source-design.md`。
