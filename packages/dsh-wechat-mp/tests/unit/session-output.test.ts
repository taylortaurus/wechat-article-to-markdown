/**
 * 输出层测试：会话不可变（缺陷 A2）、凭据字段校验（缺陷 A5 的准确版本）、
 * 内容防护、路径解析优先级、落盘布局。
 */
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  deserializeSession,
  FileSessionStore,
} from '../../src/auth/session-store.js';
import { invalidateSession, isSessionUsable, makeSession } from '../../src/definition/types.js';
import {
  GUARD_CONFIG,
  bodyCharCount,
  inspectContent,
  shouldQueueForFetch,
} from '../../src/output/guard.js';
import {
  resolveListPath,
  resolveOutputRoot,
  resolveSessionPath,
  describeOrigin,
} from '../../src/output/root.js';
import { articleDirectory, sanitizeSegment } from '../../src/output/layout.js';
import { articleToListItem, dedupKeyOf, summarizeList } from '../../src/output/url-list.js';
import { markdownEmpty, markdownHealthy, markdownPaywalled } from '../fixtures/responses.js';

describe('会话不可变（缺陷 A2 的回归测试）', () => {
  const session = makeSession('tok', 'k=v', '2026-09-22 20:00:00');

  it('invalidateSession 返回新对象，不改原对象', () => {
    const invalidated = invalidateSession(session, '收到 200003');
    expect(invalidated).not.toBe(session);
    expect(invalidated.invalid).toBe(true);
    // 原对象必须还是有效的 —— 已经发出的请求不应该被中途改写
    expect(session.invalid).toBe(false);
    expect(session.token).toBe('tok');
  });

  it('标记失效不清空字段（清空会让并发读到的 token 变成 null）', () => {
    const invalidated = invalidateSession(session, 'expired');
    expect(invalidated.token).toBe('tok');
    expect(invalidated.cookie).toBe('k=v');
  });

  it('isSessionUsable 认 invalid 标记', () => {
    expect(isSessionUsable(session)).toBe(true);
    expect(isSessionUsable(invalidateSession(session, 'x'))).toBe(false);
  });
});

describe('凭据字段校验（缺陷 A5 的准确版本）', () => {
  it('完整凭据能反序列化', () => {
    const raw = JSON.stringify({ token: 't', cookie: 'k=v', savedAt: '2026-09-22 20:00:00' });
    const session = deserializeSession(raw);
    expect(session?.token).toBe('t');
    expect(session?.invalid).toBe(false);
  });

  it('**缺 token / cookie / savedAt 任意一项就视为未配置**', () => {
    expect(deserializeSession(JSON.stringify({ cookie: 'k=v', savedAt: 'x' }))).toBeUndefined();
    expect(deserializeSession(JSON.stringify({ token: 't', savedAt: 'x' }))).toBeUndefined();
    expect(deserializeSession(JSON.stringify({ token: 't', cookie: 'k=v' }))).toBeUndefined();
  });

  it('空字符串也算缺失', () => {
    expect(deserializeSession(JSON.stringify({ token: '', cookie: 'k=v', savedAt: 'x' }))).toBeUndefined();
  });

  it('非法 JSON / 非对象不炸', () => {
    expect(deserializeSession('{{{')).toBeUndefined();
    expect(deserializeSession('"str"')).toBeUndefined();
    expect(deserializeSession('[1]')).toBeUndefined();
    expect(deserializeSession('null')).toBeUndefined();
  });

  it('带 invalid 标记的凭据反序列化后仍然无效', () => {
    const raw = JSON.stringify({ token: 't', cookie: 'k=v', savedAt: 'x', invalid: true });
    const session = deserializeSession(raw);
    expect(session?.invalid).toBe(true);
    expect(isSessionUsable(session)).toBe(false);
  });

  it('**不看本地时钟判断过期** —— 只有 invalid 标记与服务端 200003 说了算', () => {
    // 一份"很旧"的凭据：只要没被服务端拒绝就仍然可用
    const raw = JSON.stringify({ token: 't', cookie: 'k=v', savedAt: '2020-01-01 00:00:00' });
    expect(isSessionUsable(deserializeSession(raw))).toBe(true);
  });
});

describe('内容防护（5.2 节的例外）', () => {
  it('正常长度的正文不误报', () => {
    const verdict = inspectContent({ markdown: markdownHealthy });
    expect(verdict.isLikelyPaywall).toBe(false);
  });

  it('付费墙试读页会被识别', () => {
    const verdict = inspectContent({ markdown: markdownPaywalled });
    expect(verdict.isLikelyPaywall).toBe(true);
    expect(verdict.reason).toContain('付费墙特征词');
  });

  it('正文过短（渲染失败）会被识别', () => {
    const verdict = inspectContent({ markdown: markdownEmpty });
    expect(verdict.isLikelyPaywall).toBe(true);
  });

  it('清单标记 is_pay_subscribe 时直接判可疑', () => {
    const verdict = inspectContent({ markdown: markdownHealthy, isPaySubscribe: true });
    expect(verdict.isLikelyPaywall).toBe(true);
    expect(verdict.reason).toContain('is_pay_subscribe');
  });

  it('视频 / 图片类文章判可疑', () => {
    expect(inspectContent({ markdown: markdownHealthy, rawItemShowType: 62 }).isLikelyPaywall).toBe(true);
    expect(inspectContent({ markdown: markdownHealthy, rawItemShowType: 66 }).isLikelyPaywall).toBe(true);
    expect(inspectContent({ markdown: markdownHealthy, rawItemShowType: 10 }).isLikelyPaywall).toBe(false);
  });

  it('bodyCharCount 会剔掉头信息区与图片标记', () => {
    expect(bodyCharCount(markdownEmpty)).toBeLessThan(GUARD_CONFIG.minBodyChars);
    expect(bodyCharCount(markdownHealthy)).toBeGreaterThan(GUARD_CONFIG.minBodyChars);
  });

  it('shouldQueueForFetch 排除已删除与非图文类', () => {
    expect(shouldQueueForFetch({ isDeleted: true, itemShowType: 'article', isPaySubscribe: false }).queue).toBe(false);
    expect(shouldQueueForFetch({ isDeleted: false, itemShowType: 'video', isPaySubscribe: false }).queue).toBe(false);
    expect(shouldQueueForFetch({ isDeleted: false, itemShowType: 'image', isPaySubscribe: false }).queue).toBe(false);
    expect(shouldQueueForFetch({ isDeleted: false, itemShowType: 'article', isPaySubscribe: true }).queue).toBe(true);
  });
});

describe('路径解析优先级（用户明确要求：不能写死）', () => {
  const cwd = '/tmp/proj';

  it('显式参数 > 配置 > 工作区 > cwd', () => {
    expect(resolveOutputRoot({ explicit: '/a', configured: '/b', workspaceRoot: '/c', cwd }).origin).toBe('explicit');
    expect(resolveOutputRoot({ configured: '/b', workspaceRoot: '/c', cwd }).origin).toBe('configured');
    expect(resolveOutputRoot({ workspaceRoot: '/c', cwd }).origin).toBe('workspace');
    expect(resolveOutputRoot({ cwd }).origin).toBe('cwd');
  });

  it('工作区默认值是「工作区下的 output/」，不是硬编码绝对路径', () => {
    expect(resolveOutputRoot({ workspaceRoot: '/ws', cwd }).absolute).toBe('/ws/output');
  });

  it('空白字符串不算有效配置', () => {
    expect(resolveOutputRoot({ explicit: '   ', workspaceRoot: '/ws', cwd }).origin).toBe('workspace');
  });

  it('相对路径按 cwd 解析成绝对路径', () => {
    expect(resolveOutputRoot({ explicit: 'out', cwd }).absolute).toBe(path.join(cwd, 'out'));
  });

  it('列表路径与输出根目录共用同一套基准', () => {
    const list = resolveListPath({ workspaceRoot: '/ws', cwd });
    expect(list.absolute).toBe('/ws/url-list.json');
    expect(list.origin).toBe('workspace');
  });

  it('列表的相对路径按工作区解析（不是跟着插件乱飘）', () => {
    expect(resolveListPath({ explicit: 'lists/a.json', workspaceRoot: '/ws', cwd }).absolute).toBe('/ws/lists/a.json');
  });

  it('没有工作区时退化到 cwd', () => {
    expect(resolveListPath({ cwd }).absolute).toBe(path.join(cwd, 'url-list.json'));
  });

  it('会话文件放在隐藏目录里，不污染输出', () => {
    const p = resolveSessionPath({ workspaceRoot: '/ws', cwd });
    expect(p).toBe('/ws/.dsh-wechat-mp/session.json');
  });

  it('describeOrigin 能说清路径来路', () => {
    expect(describeOrigin('workspace')).toContain('工作区');
    expect(describeOrigin('explicit')).toContain('参数');
  });
});

describe('落盘布局与路径段净化', () => {
  it('flat 模式直接用标题做目录', () => {
    const dir = articleDirectory({ root: '/out', mode: 'flat', title: '我的文章', publishTime: '2026-09-21 10:00:00' });
    expect(dir).toBe(path.join('/out', '我的文章'));
  });

  it('byAccountDate 模式按 账号/年-月/日期_标题 分层', () => {
    const dir = articleDirectory({
      root: '/out',
      mode: 'byAccountDate',
      title: '我的文章',
      publishTime: '2026-09-21 10:00:00',
      accountName: '测试号',
    });
    expect(dir).toBe(path.join('/out', '测试号', '2026-09', '2026-09-21_我的文章'));
  });

  it('时间缺失时用当天兜底', () => {
    const now = new Date(2026, 8, 22);
    const dir = articleDirectory({ root: '/out', mode: 'byAccountDate', title: 'T', publishTime: '', accountName: 'A', now });
    expect(dir).toContain(path.join('A', '2026-09', '2026-09-22_T'));
  });

  it('标题过长会截断到 50 字（byAccountDate）', () => {
    const long = '很'.repeat(120);
    const dir = articleDirectory({ root: '/out', mode: 'byAccountDate', title: long, publishTime: '2026-09-21', accountName: 'A' });
    const leaf = path.basename(dir);
    expect(leaf.replace(/^\d{4}-\d{2}-\d{2}_/, '').length).toBeLessThanOrEqual(50);
  });

  it('**处理 Windows 保留名**（参考实现没做这件事）', () => {
    expect(sanitizeSegment('CON')).toBe('_CON');
    expect(sanitizeSegment('nul')).toBe('_nul');
    expect(sanitizeSegment('COM1')).toBe('_COM1');
    expect(sanitizeSegment('正常名字')).toBe('正常名字');
  });

  it('路径分隔符与非法字符被替换', () => {
    expect(sanitizeSegment('a/b\\c')).not.toContain('/');
    expect(sanitizeSegment('a/b\\c')).not.toContain('\\');
    expect(sanitizeSegment('a:b*c?')).not.toContain(':');
  });

  it('空标题有兜底', () => {
    expect(sanitizeSegment('')).toBe('untitled');
    expect(sanitizeSegment('   ')).toBe('untitled');
  });

  it('单个路径段有长度上限', () => {
    expect(sanitizeSegment('x'.repeat(500)).length).toBeLessThanOrEqual(80);
  });
});

describe('url-list 条目构造', () => {
  it('扩展字段齐全，便于抓取前先筛', () => {
    const item = articleToListItem(
      {
        aid: 'a1',
        appmsgid: 1,
        title: '标题',
        link: 'https://mp.weixin.qq.com/s/TESTAAAA',
        authorName: '作者',
        publishTime: '2026-09-21 10:00:00',
        createTimeUnix: 0,
        updateTimeUnix: 0,
        publishTimeUnix: 0,
        digest: '摘要',
        cover: '',
        picCdnUrl2351: '',
        picCdnUrl169: '',
        copyrightStat: 1,
        copyrightType: 1,
        isOriginal: true,
        itemShowType: 'article',
        rawItemShowType: 10,
        isPaySubscribe: false,
        isDeleted: false,
        albumNames: ['合集甲'],
      },
      '测试号',
    );
    expect(item.url).toBe('https://mp.weixin.qq.com/s/TESTAAAA');
    expect(item.source).toBe('wechat');
    expect(item.status).toBe('pending');
    expect(item['aid']).toBe('a1');
    expect(item['title']).toBe('标题');
    expect(item['is_pay_subscribe']).toBe(false);
    expect(item['account']).toBe('测试号');
  });

  it('去重键忽略追踪参数（同一篇文章带不同 chksm 也算同一条）', () => {
    const a = dedupKeyOf('https://mp.weixin.qq.com/s/TESTAAAA');
    const b = dedupKeyOf('https://mp.weixin.qq.com/s/TESTAAAA?chksm=abc&scene=126');
    expect(a).toBe(b);
    expect(a.startsWith('wechat:')).toBe(true);
  });

  it('不同文章得到不同的键', () => {
    expect(dedupKeyOf('https://mp.weixin.qq.com/s/AAAA')).not.toBe(
      dedupKeyOf('https://mp.weixin.qq.com/s/BBBB'),
    );
  });

  it('summarizeList 统计各种状态', () => {
    const summary = summarizeList([
      { url: 'a', status: 'done' },
      { url: 'b', status: 'failed' },
      { url: 'c', status: 'pending' },
      { url: 'd' },
      { url: 'e', status: 'weird' },
    ]);
    expect(summary).toEqual({ total: 5, done: 1, failed: 1, pending: 2, other: 1 });
  });
});

describe('FileSessionStore', () => {
  it('读不到文件时返回 undefined，不抛', async () => {
    const store = new FileSessionStore('/tmp/definitely-not-exists-dsh-wechat-mp/session.json');
    await expect(store.load()).resolves.toBeUndefined();
  });

  it('source 标识为 file（用于向用户说明凭据来源）', () => {
    expect(new FileSessionStore('/tmp/x.json').source).toBe('file');
  });
});
