/**
 * 扫码状态机与登录相关的解析测试。
 *
 * 重点覆盖评估文档 R4 指出的那个问题：参考实现的 `switch` 里有 7 个分支，
 * 而文档初版只列了 5 个（漏了 `2` 和 `5`）。这组测试把**全部**分支钉住。
 */
import { describe, expect, it } from 'vitest';

import {
  extractTokenFromRedirect,
  parseProfile,
  parseScanStatus,
  readEnvelope,
} from '../../src/provider/parse.js';
import { buildStartLoginBody, buildAppMsgPublishUrl, SCAN_STATUS } from '../../src/provider/endpoints.js';
import {
  bizloginOk,
  profileOk,
  scanStatuses,
  scanStatusResponse,
} from '../fixtures/responses.js';

describe('parseScanStatus —— 全状态码分支', () => {
  it('0 = 等待扫描', () => {
    const s = parseScanStatus(scanStatusResponse(SCAN_STATUS.WAITING, 0));
    expect(s.phase).toBe('waiting');
    expect(s.raw).toBe(0);
  });

  it('4 / 6 且 acctSize>=1 = 已扫码待确认', () => {
    for (const raw of [SCAN_STATUS.SCANNED_A, SCAN_STATUS.SCANNED_B]) {
      const s = parseScanStatus(scanStatusResponse(raw, 1));
      expect(s.phase).toBe('scanned');
      expect(s.message).toContain('确认');
    }
  });

  it('4 / 6 但 acctSize=0 = 没有可用账号（不是"待确认"）', () => {
    const s = parseScanStatus(scanStatusResponse(SCAN_STATUS.SCANNED_A, 0));
    expect(s.phase).toBe('error');
    expect(s.message).toContain('没有可用账号');
  });

  it('1 = 已确认', () => {
    expect(parseScanStatus(scanStatusResponse(SCAN_STATUS.CONFIRMED, 1)).phase).toBe('confirmed');
  });

  it('**2 和 3 都是过期**（初版文档漏了 2）', () => {
    expect(parseScanStatus(scanStatusResponse(SCAN_STATUS.EXPIRED_A, 0)).phase).toBe('expired');
    expect(parseScanStatus(scanStatusResponse(SCAN_STATUS.EXPIRED_B, 0)).phase).toBe('expired');
  });

  it('**5 = 账号未绑定邮箱**，是独立分支（初版文档完全没提）', () => {
    const s = parseScanStatus(scanStatusResponse(SCAN_STATUS.NO_EMAIL, 0));
    expect(s.phase).toBe('no-email');
    expect(s.message).toContain('邮箱');
  });

  it('未知状态码归为 error，并带上服务端提示', () => {
    const s = parseScanStatus({ base_resp: { ret: -1, err_msg: '会话过期' }, status: 99, acct_size: 0 });
    expect(s.phase).toBe('error');
    expect(s.errMsg).toBe('会话过期');
  });

  it('字段全缺时不炸', () => {
    const s = parseScanStatus({});
    expect(s.raw).toBe(-1);
    expect(s.phase).toBe('error');
  });

  it('对照表：所有已知状态码都有确定的语义归属', () => {
    for (const entry of scanStatuses) {
      const s = parseScanStatus(scanStatusResponse(entry.raw, entry.acctSize));
      expect(['waiting', 'scanned', 'confirmed', 'expired', 'no-email', 'error']).toContain(s.phase);
      // 原始码永远保留，便于排查
      expect(s.raw).toBe(entry.raw);
    }
  });
});

describe('extractTokenFromRedirect', () => {
  it('从相对 redirect_url 里取 token', () => {
    expect(extractTokenFromRedirect('/cgi-bin/home?t=home/index&lang=zh_CN&token=1862390040')).toBe('1862390040');
  });

  it('从绝对 URL 里取 token', () => {
    expect(extractTokenFromRedirect('https://mp.weixin.qq.com/cgi-bin/home?token=abc123')).toBe('abc123');
  });

  it('没有 token 参数时返回 undefined', () => {
    expect(extractTokenFromRedirect('/cgi-bin/home?lang=zh_CN')).toBeUndefined();
    expect(extractTokenFromRedirect('')).toBeUndefined();
    expect(extractTokenFromRedirect(undefined)).toBeUndefined();
    expect(extractTokenFromRedirect('/no-query')).toBeUndefined();
  });

  it('token 为空串时也返回 undefined（不要造出一个空 token 会话）', () => {
    expect(extractTokenFromRedirect('/x?token=')).toBeUndefined();
  });

  it('URL 畸形时有兜底的手工解析路径', () => {
    expect(extractTokenFromRedirect(':::not a url:::?token=fallback1')).toBe('fallback1');
  });

  it('真实响应样本里的 redirect_url 能取到 token', () => {
    const record = bizloginOk as { redirect_url: string };
    expect(extractTokenFromRedirect(record.redirect_url)).toBe('1862390040');
  });
});

describe('parseProfile', () => {
  it('取出昵称与头像', () => {
    const p = parseProfile(profileOk);
    expect(p.nickname).toBe('测试公众号');
    expect(p.avatarUrl).toBe('https://mmbiz.qpic.cn/head1');
  });

  it('字段缺失时给空串', () => {
    expect(parseProfile({})).toEqual({ nickname: '', avatarUrl: '' });
  });
});

describe('readEnvelope', () => {
  it('读出 ret 与 err_msg', () => {
    expect(readEnvelope({ base_resp: { ret: 200003, err_msg: 'expired' } })).toEqual({
      ret: 200003,
      errMsg: 'expired',
    });
  });

  it('缺失时 ret 为 0（宽容处理）', () => {
    expect(readEnvelope({})).toEqual({ ret: 0, errMsg: '' });
  });
});

describe('endpoints 构造', () => {
  it('startlogin 的 sessionid 是「毫秒时间戳 + 3 位随机数」', () => {
    const body = buildStartLoginBody(1758000000000, 7);
    expect(body.get('sessionid')).toBe('1758000000000007');
    expect(body.get('login_type')).toBe('3');
    expect(body.get('f')).toBe('json');
  });

  it('列文章默认走 list 模式', () => {
    const url = buildAppMsgPublishUrl({ token: 't', fakeid: 'f', begin: 0, count: 20 });
    expect(url).toContain('sub=list');
    expect(url).toContain('search_field=null');
    expect(url).toContain('sub_action=list_ex');
    expect(url).toContain('type=101_1');
    expect(url).toContain('free_publish_type=1');
  });

  it('给了关键词就切到 search 模式', () => {
    const url = buildAppMsgPublishUrl({ token: 't', fakeid: 'f', begin: 0, count: 20, keyword: '测试' });
    expect(url).toContain('sub=search');
    expect(url).toContain('search_field=7');
    expect(url).toContain(`query=${encodeURIComponent('测试')}`);
  });
});
