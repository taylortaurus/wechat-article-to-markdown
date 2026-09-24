/**
 * 解析链测试。
 *
 * 这一组是整份方案里最该被保护的测试 —— 它覆盖参考实现里最容易写错的几处：
 * 三层嵌套 JSON、缺字段容错、`publish_time` 回退、已删除过滤。
 */
import { describe, expect, it } from 'vitest';

import { formatTimestamp } from 'spider-claw';

import {
  filterArticles,
  parseAccountList,
  parseAppMsgPublish,
  parseMaybeJson,
  toMpArticle,
  unpackPublishPage,
} from '../../src/provider/parse.js';
import {
  appmsgpublishBadInner,
  appmsgpublishEmpty,
  appmsgpublishOk,
  articleDeletedPaid,
  articleNoPublishTime,
  articleOriginal,
  searchbizOk,
} from '../fixtures/responses.js';

describe('parseMaybeJson', () => {
  it('对象原样返回', () => {
    expect(parseMaybeJson({ a: 1 })).toEqual({ a: 1 });
  });

  it('字符串会再解析一次', () => {
    expect(parseMaybeJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('非法 JSON / 非对象返回 undefined，不抛', () => {
    expect(parseMaybeJson('{{{')).toBeUndefined();
    expect(parseMaybeJson('"just a string"')).toBeUndefined();
    expect(parseMaybeJson('[1,2]')).toBeUndefined();
    expect(parseMaybeJson(undefined)).toBeUndefined();
    expect(parseMaybeJson('')).toBeUndefined();
  });
});

describe('三层嵌套解析（publish_page → publish_list[].publish_info → appmsgex）', () => {
  it('能把完整响应剥到文章层', () => {
    const raw = unpackPublishPage((appmsgpublishOk as { publish_page: unknown }).publish_page);
    expect(raw.raw).toHaveLength(3);
    expect(raw.publishCount).toBe(2);
    expect(raw.totalCount).toBe(42);
  });

  it('parseAppMsgPublish 映射出领域对象', () => {
    const parsed = parseAppMsgPublish(appmsgpublishOk);
    expect(parsed.articles).toHaveLength(3);
    expect(parsed.totalCount).toBe(42);

    const first = parsed.articles[0]!;
    expect(first.aid).toBe(articleOriginal.aid);
    expect(first.title).toBe(articleOriginal.title);
    expect(first.link).toBe(articleOriginal.link);
    expect(first.authorName).toBe(articleOriginal.author_name);
    expect(first.isOriginal).toBe(true);
    expect(first.itemShowType).toBe('article');
    expect(first.albumNames).toEqual(['合集甲']);
  });

  it('空页解析出 0 篇（翻页终止条件可靠）', () => {
    const parsed = parseAppMsgPublish(appmsgpublishEmpty);
    expect(parsed.articles).toHaveLength(0);
  });

  it('中间层 JSON 非法时不抛异常，只是解析不出文章', () => {
    expect(() => parseAppMsgPublish(appmsgpublishBadInner)).not.toThrow();
    expect(parseAppMsgPublish(appmsgpublishBadInner).articles).toHaveLength(0);
  });

  it('publish_page 缺失 / 不是字符串时不炸', () => {
    expect(parseAppMsgPublish({}).articles).toHaveLength(0);
    expect(parseAppMsgPublish({ publish_page: null }).articles).toHaveLength(0);
    expect(parseAppMsgPublish({ publish_page: 123 }).articles).toHaveLength(0);
  });
});

describe('字段级容错', () => {
  it('publish_time 为 0 时回退到 update_time', () => {
    const article = toMpArticle(articleNoPublishTime as unknown as Record<string, unknown>);
    expect(article.publishTimeUnix).toBe(articleNoPublishTime.update_time);
    expect(article.publishTime).toBe(formatTimestamp(articleNoPublishTime.update_time));
  });

  it('完全空的对象也能映射出一个结构完整的对象', () => {
    const article = toMpArticle({});
    expect(article.aid).toBe('');
    expect(article.title).toBe('');
    expect(article.publishTime).toBe('');
    expect(article.publishTimeUnix).toBe(0);
    expect(article.isDeleted).toBe(false);
    expect(article.isPaySubscribe).toBe(false);
    expect(article.itemShowType).toBe('other');
    expect(article.albumNames).toEqual([]);
  });

  it('字符串形式的数字也能读出来', () => {
    const article = toMpArticle({
      appmsgid: '100000009',
      create_time: '1758000000',
      publish_time: '1758000000',
    });
    expect(article.appmsgid).toBe(100000009);
    expect(article.createTimeUnix).toBe(1758000000);
  });

  it('is_pay_subscribe 用 1 / "1" / true 都算真', () => {
    expect(toMpArticle({ is_pay_subscribe: 1 }).isPaySubscribe).toBe(true);
    expect(toMpArticle({ is_pay_subscribe: '1' }).isPaySubscribe).toBe(true);
    expect(toMpArticle({ is_pay_subscribe: true }).isPaySubscribe).toBe(true);
    expect(toMpArticle({ is_pay_subscribe: 0 }).isPaySubscribe).toBe(false);
  });

  it('item_show_type 分类正确', () => {
    expect(toMpArticle({ item_show_type: 10 }).itemShowType).toBe('article');
    expect(toMpArticle({ item_show_type: 66 }).itemShowType).toBe('image');
    expect(toMpArticle({ item_show_type: 62 }).itemShowType).toBe('video');
    expect(toMpArticle({ item_show_type: 7 }).itemShowType).toBe('other');
  });

  it('isOriginal 要 copyright_stat 与 copyright_type 同时为 1', () => {
    expect(toMpArticle({ copyright_stat: 1, copyright_type: 1 }).isOriginal).toBe(true);
    expect(toMpArticle({ copyright_stat: 1, copyright_type: 0 }).isOriginal).toBe(false);
    expect(toMpArticle({ copyright_stat: 0, copyright_type: 1 }).isOriginal).toBe(false);
  });

  it('合集里没有 title 的条目会被跳过', () => {
    const article = toMpArticle({ appmsg_album_infos: [{ album_id: 1 }, { title: '有效' }] });
    expect(article.albumNames).toEqual(['有效']);
  });
});

describe('parseAccountList', () => {
  it('解析出候选，并丢掉没有 fakeid 的条目', () => {
    const accounts = parseAccountList(searchbizOk);
    expect(accounts).toHaveLength(2);
    expect(accounts[0]!.fakeid).toBe('MzIxMDAwMDAwMQ==');
    expect(accounts[0]!.avatarUrl).toBe('https://mmbiz.qpic.cn/head1');
    expect(accounts[1]!.serviceType).toBe(1);
  });

  it('list 缺失时返回空数组', () => {
    expect(parseAccountList({})).toEqual([]);
    expect(parseAccountList({ list: 'nope' })).toEqual([]);
  });
});

describe('filterArticles（本地筛选）', () => {
  const articles = parseAppMsgPublish(appmsgpublishOk).articles;

  it('默认过滤掉已删除的文章', () => {
    const kept = filterArticles(articles, { fakeid: 'x' });
    expect(kept.some((a) => a.aid === articleDeletedPaid.aid)).toBe(false);
    expect(kept).toHaveLength(2);
  });

  it('includeDeleted 为真时保留已删除的文章', () => {
    const kept = filterArticles(articles, { fakeid: 'x', includeDeleted: true });
    expect(kept).toHaveLength(3);
  });

  it('originalOnly 只留原创', () => {
    const kept = filterArticles(articles, { fakeid: 'x', originalOnly: true });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.isOriginal).toBe(true);
  });

  it('按合集筛选（大小写不敏感的部分匹配）', () => {
    expect(filterArticles(articles, { fakeid: 'x', albumName: '合集' })).toHaveLength(1);
    expect(filterArticles(articles, { fakeid: 'x', albumName: '不存在的合集' })).toHaveLength(0);
  });

  it('时间区间按日期前缀比较', () => {
    const sample = articles[0]!;
    const day = sample.publishTime.slice(0, 10);
    expect(filterArticles(articles, { fakeid: 'x', since: day })).toHaveLength(2);
    expect(filterArticles(articles, { fakeid: 'x', until: '1970-01-01' })).toHaveLength(0);
  });

  it('publishTime 为空串的文章不会被时间筛选误留', () => {
    const kept = filterArticles([toMpArticle({})], { fakeid: 'x', since: '1970-01-01' });
    expect(kept).toHaveLength(0);
  });
});
