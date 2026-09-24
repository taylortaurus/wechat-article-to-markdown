/** 跨来源共享的字符串工具。 */

/** 转义正则元字符，用于把 URL 当作字面量拼进正则。 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把文章标题转成安全的目录 / 文件名。
 *
 * 与 Python 版一致：替换掉跨平台非法字符，并截断到 80 个字符
 * （避免超出文件系统的单个路径长度限制）。
 */
export function toSafeTitle(title: string): string {
  return title.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 80);
}

/** 折叠连续空白并去除首尾空白（等价于「取纯文本」的常用语义）。 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 常见命名字符实体（未列出的实体原样保留，保持保守语义）。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/** 解码常见 HTML 实体（`&amp;` / `&#38;` / `&#x26;` …）。 */
export function unescapeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, ref: string) => {
    if (ref.startsWith('#x') || ref.startsWith('#X')) {
      const code = Number.parseInt(ref.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (ref.startsWith('#')) {
      const code = Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ref] ?? match;
  });
}
