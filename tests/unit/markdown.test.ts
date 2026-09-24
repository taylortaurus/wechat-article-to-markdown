/** 共享 Markdown 核心层（HTML → MD / 图片链接替换 / 头信息拼接）的离线单测。 */
import { describe, expect, it } from 'vitest';

import {
  buildMarkdown,
  convertToMarkdown,
  replaceImageUrls,
} from '../../src/core/markdown';

describe('convertToMarkdown', () => {
  it('还原代码块占位符为带语言标识的围栏代码块', () => {
    const html = '<p>before</p><p>CODEBLOCK-PLACEHOLDER-0</p><p>after</p>';
    const md = convertToMarkdown(html, [{ lang: 'python', code: 'print(1)' }]);

    expect(md).toContain('```python');
    expect(md).toContain('print(1)');
    expect(md).not.toContain('CODEBLOCK-PLACEHOLDER-0');
  });

  it('保留 <pre><code class="language-x"> 的语言标识', () => {
    const md = convertToMarkdown('<pre><code class="language-python">x = 1\n</code></pre>');

    expect(md).toContain('```python');
    expect(md).toContain('x = 1');
  });

  it('标题 / 列表 / 链接 / 加粗按 GFM 风格输出', () => {
    const md = convertToMarkdown(
      '<h2>标题</h2><ul><li>甲</li><li>乙</li></ul>' +
        '<p><a href="https://example.com">链接</a> 与 <strong>粗体</strong></p>',
    );

    expect(md).toContain('## 标题');
    expect(md).toContain('- 甲');
    expect(md).toContain('- 乙');
    expect(md).toContain('[链接](https://example.com)');
    expect(md).toContain('**粗体**');
  });

  it('表格转成 GFM 管道表格', () => {
    const md = convertToMarkdown(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );

    expect(md).toContain('| a | b |');
    expect(md).toContain('| 1 | 2 |');
  });

  it('丢弃 script / style，清理 &nbsp; 与多余空行', () => {
    const md = convertToMarkdown(
      '<div><script>bad()</script><style>.x{}</style>' +
        '<p>a&nbsp;b</p><p></p><p></p><p></p><p>c</p></div>',
    );

    expect(md).not.toContain('bad()');
    expect(md).not.toContain('.x{}');
    expect(md).toContain('a b');
    expect(md).not.toMatch(/\n{4,}/);
  });
});

describe('replaceImageUrls', () => {
  it('精确替换含括号与查询参数的图片链接', () => {
    const md =
      '![](https://example.com/a_(1).png)\n' + '![alt](https://example.com/b.png?x=1&y=2)';
    const out = replaceImageUrls(
      md,
      new Map([
        ['https://example.com/a_(1).png', 'images/a.png'],
        ['https://example.com/b.png?x=1&y=2', 'images/b.png'],
      ]),
    );

    expect(out).toContain('![](images/a.png)');
    expect(out).toContain('![alt](images/b.png)');
  });

  it('不改动正文里的普通链接', () => {
    const md = '[首页](https://example.com/)';
    const out = replaceImageUrls(md, new Map([['https://example.com/', 'images/x.png']]));

    expect(out).toBe(md);
  });
});

describe('buildMarkdown', () => {
  it('拼接头信息后紧跟正文', () => {
    const md = buildMarkdown(
      { title: 'T', author: 'A', publish_time: 'P', source_url: 'U' },
      'body',
    );

    expect(md).toBe('# T\n\n> 作者: A\n> 发布时间: P\n> 原文链接: U\n\n---\nbody\n');
  });

  it('元数据缺失时只保留标题与分隔线', () => {
    expect(buildMarkdown({ title: 'T' }, 'body')).toBe('# T\n\n---\nbody\n');
  });

  it('正文首尾空行被裁掉，文件以单个换行结尾', () => {
    expect(buildMarkdown({ title: 'T' }, '\n\nbody\n\n\n')).toBe('# T\n\n---\nbody\n');
  });
});
