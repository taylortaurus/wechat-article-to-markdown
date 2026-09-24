/** 尚未实现的来源占位实现。 */
import { Source } from './base.js';

export class StubSource extends Source {
  readonly name: string = 'stub';

  override match(): boolean {
    return false;
  }

  override articleId(url: string): string {
    return url;
  }

  override async fetch(): Promise<string> {
    throw new Error(`来源「${this.name}」尚未实现，敬请期待。`);
  }
}
