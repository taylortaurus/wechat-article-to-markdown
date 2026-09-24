/** Twitter / X 来源（占位，尚未实现）。 */
import { StubSource } from './stub.js';

export class TwitterSource extends StubSource {
  override readonly name: string = 'twitter';
  // TODO: 基于登录态/会话抓取推文与线程，处理鉴权、anti-bot、限流。
}
