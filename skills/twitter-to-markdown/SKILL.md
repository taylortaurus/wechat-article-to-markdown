---
name: twitter-to-markdown
description: (STUB) Fetch a Tweet / thread from Twitter / X and convert to Markdown. Not yet implemented in spider-claw. Twitter/X 文章转 Markdown（尚未实现，占位）。
author: jackwener
version: "0.0.1"
tags:
  - twitter
  - 推特
  - x
  - markdown
  - article
  - converter
  - stub
  - spider-claw
---

# Twitter / X → Markdown (spider-claw / twitter source — STUB)

> ⚠️ **Not implemented yet.** This skill is a placeholder for the `twitter` source of
> [`spider-claw`](../../SKILL.md). Running it currently fails with
> `来源「twitter」尚未实现，敬请期待。`.

## Planned behavior

```bash
spider-claw --source twitter "https://twitter.com/<handle>/status/<id>"
```

- Auth/session-based fetch (Twitter requires a logged-in context; cookie/session
  injection planned).
- Thread expansion, media localization, and Markdown conversion.
- Anti-bot / rate-limit handling.

## Current status

The `twitter` source is registered in `src/sources/twitter.ts` as a stub
(`StubSource`). Until implemented, invoking it (auto-detected or via
`--source twitter`) fails with a clear "尚未实现" message and the batch list entry is
marked `failed` accordingly.

## When it will be useful

When you need to archive tweets/threads as Markdown for summarization or RAG. Until
then, use the [`wechat-to-markdown`](../wechat-to-markdown) or
[`blog-to-markdown`](../blog-to-markdown) source, or implement
`TwitterSource.fetch`.
