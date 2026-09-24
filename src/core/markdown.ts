/**
 * HTML → Markdown 转换、图片链接替换与头信息拼接（与具体来源无关）。
 *
 * Python 版使用 `markdownify`，这里换成语义最接近的 `turndown`：
 * - `codeBlockStyle: 'fenced'` + `<pre><code class="language-x">` → 带语言标识的围栏代码块；
 * - `turndown-plugin-gfm` 提供表格 / 删除线 / 任务列表（对齐 markdownify 的表格支持）；
 * - 微信公众号那种「行号 + 代码块 DOM」先由微信来源替换成占位符，这里再还原。
 */
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

import { escapeRegExp } from './text.js';

/** 从正文 DOM 中抽出的代码块（微信来源使用）。 */
export interface CodeBlock {
  lang: string;
  code: string;
}

/** 文章头信息。 */
export interface ArticleMeta {
  title: string;
  author?: string;
  publish_time?: string;
  source_url?: string;
}

/** 代码块占位符前缀（与微信来源约定一致）。 */
export const CODE_BLOCK_PLACEHOLDER = 'CODEBLOCK-PLACEHOLDER';

function createService(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    br: '  ',
  });
  service.use(gfm);
  // script/style 只留噪声，直接丢弃（turndown 的 _remove 规则优先级高于默认规则）
  service.remove(['script', 'style', 'noscript']);
  // 列表项：turndown 内置规则用「三个空格」对齐（`-   甲`），这里改成单空格，
  // 让输出风格与 Python 版 markdownify 一致（`- 甲`）。
  service.addRule('listItem', {
    filter: 'li',
    replacement: (content, node, options) => {
      const body = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n/gm, '\n  ');
      const parent = node.parentNode as Element | null;
      let prefix = `${options.bulletListMarker} `;
      if (parent && parent.nodeName === 'OL') {
        const start = parent.getAttribute('start');
        const index = Array.from(parent.children).indexOf(node as Element);
        prefix = `${start ? Number(start) + index : index + 1}. `;
      }
      return prefix + body + (node.nextSibling ? '\n' : '');
    },
  });
  return service;
}

let service: TurndownService | undefined;

/** 惰性创建 turndown 单例（首次转换时才初始化）。 */
function getService(): TurndownService {
  service ??= createService();
  return service;
}

/** HTML → Markdown，并还原代码块占位符、清理格式。 */
export function convertToMarkdown(contentHtml: string, codeBlocks: CodeBlock[] = []): string {
  let md = getService().turndown(contentHtml);

  for (const [i, block] of codeBlocks.entries()) {
    const fenced = `\n\`\`\`${block.lang}\n${block.code}\n\`\`\`\n`;
    md = md.split(`${CODE_BLOCK_PLACEHOLDER}-${i}`).join(fenced);
  }

  // 清理 &nbsp; 残留
  md = md.replaceAll('\u00a0', ' ');
  // 清理多余空行
  md = md.replace(/\n{4,}/g, '\n\n\n');
  // 清理行尾多余空格
  md = md.replace(/[ \t]+$/gm, '');

  return md;
}

/**
 * 把 Markdown 中的远程图片链接替换为本地路径。
 *
 * 使用精确 URL 匹配（而非通配正则），因此 URL 里带括号 / 查询参数也不会错位。
 */
export function replaceImageUrls(md: string, urlMap: Map<string, string>): string {
  let out = md;
  for (const [remoteUrl, localPath] of urlMap) {
    const pattern = new RegExp(`!\\[([^\\]]*)\\]\\(${escapeRegExp(remoteUrl)}\\)`, 'g');
    out = out.replace(pattern, (_match, alt: string) => `![${alt}](${localPath})`);
  }
  return out;
}

/** 拼接最终 Markdown 文件内容（来源无关的通用头信息）。 */
export function buildMarkdown(meta: ArticleMeta, bodyMd: string): string {
  const lines = [`# ${meta.title}`, ''];
  if (meta.author) lines.push(`> 作者: ${meta.author}`);
  if (meta.publish_time) lines.push(`> 发布时间: ${meta.publish_time}`);
  if (meta.source_url) lines.push(`> 原文链接: ${meta.source_url}`);
  if (meta.author || meta.publish_time || meta.source_url) lines.push('');
  lines.push('---', '');
  // 正文去掉首尾空行，并保证文件以单个换行结尾
  const body = bodyMd.replace(/^\n+/, '').replace(/\s+$/, '');
  return `${lines.join('\n')}${body}\n`;
}
