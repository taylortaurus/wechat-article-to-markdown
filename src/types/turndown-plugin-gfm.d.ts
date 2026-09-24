/**
 * `turndown-plugin-gfm` 未随包提供类型声明，这里补一份最小声明。
 */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  export type TurndownPlugin = (service: TurndownService) => void;

  /** 一次性挂载 gfm 全部插件（表格 / 删除线 / 任务列表 / 高亮代码块）。 */
  export const gfm: TurndownPlugin;
  export const tables: TurndownPlugin;
  export const strikethrough: TurndownPlugin;
  export const taskListItems: TurndownPlugin;
  export const highlightedCodeBlock: TurndownPlugin;
}
