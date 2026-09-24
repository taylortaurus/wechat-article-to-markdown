/** 守护 `src/version.ts` 与 `package.json` 的版本号一致。 */
import { describe, expect, it } from 'vitest';

import pkg from '../../package.json';
import { VERSION } from '../../src/version';

describe('VERSION', () => {
  it('与 package.json 的 version 保持一致', () => {
    expect(VERSION).toBe(pkg.version);
  });
});
