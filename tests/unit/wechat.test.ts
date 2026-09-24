/** 微信来源的离线单测（不联网、不启动浏览器）。 */
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';

import {
  WechatSource,
  extractPublishTime,
  formatTimestamp,
  normalizeWechatUrl,
  processContent,
} from '../../src/sources/wechat';

describe('normalizeWechatUrl', () => {
  it.each([
    [
      '原样保留已规范的 URL',
      'https://mp.weixin.qq.com/s?__biz=ABC&mid=123&idx=1&sn=xyz',
      'https://mp.weixin.qq.com/s?__biz=ABC&mid=123&idx=1&sn=xyz',
    ],
    [
      '还原 zsh 自动转义的反斜杠',
      String.raw`https://mp.weixin.qq.com/s\?__biz=ABC\&mid=123`,
      'https://mp.weixin.qq.com/s?__biz=ABC&mid=123',
    ],
    [
      '解码 HTML 实体',
      'https://mp.weixin.qq.com/s?__biz=ABC&amp;mid=123',
      'https://mp.weixin.qq.com/s?__biz=ABC&mid=123',
    ],
    ['去掉双引号包裹', '"https://mp.weixin.qq.com/s?a=1"', 'https://mp.weixin.qq.com/s?a=1'],
    ['去掉尖括号包裹', '<https://mp.weixin.qq.com/s?a=1>', 'https://mp.weixin.qq.com/s?a=1'],
    ['http 强制升级为 https', 'http://mp.weixin.qq.com/s?a=1', 'https://mp.weixin.qq.com/s?a=1'],
    ['裸域名补全 https', 'mp.weixin.qq.com/s?a=1', 'https://mp.weixin.qq.com/s?a=1'],
    ['协议相对地址补全 https', '//mp.weixin.qq.com/s?a=1', 'https://mp.weixin.qq.com/s?a=1'],
    ['空字符串', '', ''],
    ['纯空白', '  ', ''],
  ])('%s', (_name, raw, expected) => {
    expect(normalizeWechatUrl(raw)).toBe(expected);
  });
});

describe('extractPublishTime', () => {
  it('支持多种 create_time 写法', () => {
    const ts = 1_700_000_000;
    const expected = formatTimestamp(ts);

    expect(extractPublishTime(`create_time:'${ts}'`)).toBe(expected);
    expect(extractPublishTime(`create_time:"${ts}"`)).toBe(expected);
    expect(extractPublishTime(`create_time = ${ts}`)).toBe(expected);
    expect(extractPublishTime(`create_time:JsDecode('${ts}')`)).toBe(expected);
  });

  it('JsDecode 里不是纯数字时原样返回', () => {
    expect(extractPublishTime("create_time:JsDecode('2026-07-06')")).toBe('2026-07-06');
  });

  it('找不到时间时返回空串', () => {
    expect(extractPublishTime('<html>nothing here</html>')).toBe('');
  });
});

describe('formatTimestamp', () => {
  it('按 Asia/Shanghai（UTC+8）格式化', () => {
    // 1700000000 = 2023-11-14 22:13:20 UTC → 2023-11-15 06:13:20 UTC+8
    expect(formatTimestamp(1_700_000_000)).toBe('2023-11-15 06:13:20');
  });
});

describe('processContent', () => {
  it('提取代码块与图片，移除噪声节点', () => {
    const html = `
    <div id="js_content">
      <img data-src="https://example.com/1.png" />
      <img src="https://example.com/1.png" />
      <div class="code-snippet__fix">
        <pre data-lang="python"></pre>
        <code>print('hello')</code>
      </div>
      <script>bad()</script>
    </div>
    `;
    const { html: contentHtml, codeBlocks, imgUrls } = processContent(cheerio.load(html));

    expect(contentHtml).not.toContain('<script');
    expect(imgUrls).toEqual(['https://example.com/1.png']);
    expect(codeBlocks).toEqual([{ lang: 'python', code: "print('hello')" }]);
    expect(contentHtml).toContain('CODEBLOCK-PLACEHOLDER-0');
  });

  it('跳过 CSS counter 泄漏的垃圾行与行号节点', () => {
    const html = `
    <div id="js_content">
      <div class="code-snippet__fix">
        <span class="code-snippet__line-index">1</span>
        <code>counter(line1)</code>
        <code>real_code()</code>
      </div>
    </div>
    `;
    const { codeBlocks } = processContent(cheerio.load(html));

    expect(codeBlocks).toEqual([{ lang: '', code: 'real_code()' }]);
  });

  it('缺少 #js_content 时返回空结果', () => {
    const result = processContent(cheerio.load('<div>nothing</div>'));
    expect(result).toEqual({ html: '', codeBlocks: [], imgUrls: [] });
  });
});

describe('WechatSource', () => {
  const source = new WechatSource();

  it('只识别 mp.weixin.qq.com', () => {
    expect(source.match('https://mp.weixin.qq.com/s/abc')).toBe(true);
    expect(source.match('https://mp.weixin.qq.com.evil.com/s/abc')).toBe(false);
    expect(source.match('https://example.com/s/abc')).toBe(false);
    expect(source.match('not a url')).toBe(false);
  });

  it('去重键为去掉追踪参数 / 锚点的核心路径', () => {
    const a = source.articleId('https://mp.weixin.qq.com/s/abc?chksm=1&scene=2#anchor');
    const b = source.articleId('https://mp.weixin.qq.com/s/abc?chksm=999');
    expect(a).toBe(b);
    expect(a).toBe('https://mp.weixin.qq.com/s/abc');
  });

  it('拒绝非微信域名', async () => {
    await expect(source.fetch('https://example.com/x')).rejects.toThrow(
      '无效的微信文章 URL (mp.weixin.qq.com)',
    );
  });
});
