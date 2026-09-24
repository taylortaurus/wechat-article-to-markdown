/**
 * 输出目录 / 状态面板。
 *
 * **关于它注册在哪里（一个诚实的取舍）**：
 *
 * 理想形态是常驻面板（比如右侧栏或设置区的一个 section）。但那些槽位的
 * cardinality 与 owner props 我没有逐字核验过 —— 往未声明或形状不符的槽位注册会在
 * **插件激活时直接失败**，而且同一槽位重复声明 owner 也是硬错误。
 *
 * 所以 v1 先注册在**已经核验过的** `tool.call.toolview` 上，键是 `wechat_output_info`：
 * 用户（或 agent）调用查看输出的工具时，就会看到这张卡片，里面有输出根目录、
 * 清单路径、布局与限速配置，以及一个"复制路径"的按钮。
 *
 * **升级路径**：等确认了 `settings.section`（或 `sidebar.right.pane.tab`）的声明契约，
 * 把同一个组件注册到那边即可 —— 组件本身不用改。
 */
import { createElement as h, useState } from 'react';
import type { ReactElement } from 'react';

/** 与 Node 侧 `wechat_output_info` 的规范值对应（字段名保持一致）。 */
export interface OutputInfo {
  outputRoot?: string;
  outputOrigin?: string;
  listPath?: string;
  listOrigin?: string;
  sessionPath?: string;
  layout?: string;
  pageDelayMs?: number;
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', lineHeight: '1.7' },
  row: { display: 'flex', gap: '8px', alignItems: 'baseline' },
  label: { minWidth: '84px', opacity: '0.7' },
  value: { fontFamily: 'var(--font-mono, ui-monospace, monospace)', wordBreak: 'break-all' },
  actions: { display: 'flex', gap: '8px', marginTop: '4px' },
  button: {
    font: 'inherit',
    fontSize: '12px',
    padding: '3px 10px',
    borderRadius: '6px',
    border: '1px solid var(--color-border-secondary, rgba(0,0,0,.25))',
    background: 'transparent',
    cursor: 'pointer',
  },
  note: { fontSize: '12px', opacity: '0.7', marginTop: '4px' },
} as const;

function Row(label: string, value: string | undefined): ReactElement {
  return h(
    'div',
    { style: styles.row },
    h('span', { style: styles.label }, label),
    h('span', { style: styles.value }, value && value.length > 0 ? value : '(未设置)'),
  );
}

/** 面板组件。props 由 card model 从 `ToolCallBlock` 派生，这里只用到内容。 */
export function OutputPanel(props: Record<string, unknown>): ReactElement {
  // ui-tool 会把工具结果内容一并传进来；不同版本字段名可能不同，所以宽松取。
  const info = pickInfo(props);
  const [copied, setCopied] = useState(false);

  const onCopy = (): void => {
    const text = info.outputRoot ?? '';
    if (text.length === 0) return;
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return h(
    'div',
    { style: styles.wrap },
    Row('输出根目录', info.outputRoot),
    info.outputOrigin !== undefined ? h('div', { style: styles.note }, `来源：${info.outputOrigin}`) : null,
    Row('清单文件', info.listPath),
    Row('凭据文件', info.sessionPath),
    Row('落盘布局', info.layout),
    Row('翻页间隔', info.pageDelayMs === undefined ? undefined : `${info.pageDelayMs} 毫秒`),
    h(
      'div',
      { style: styles.actions },
      h('button', { style: styles.button, onClick: onCopy, type: 'button' }, copied ? '已复制' : '复制输出路径'),
    ),
    h(
      'div',
      { style: styles.note },
      '要改输出目录：让 agent 调用 wechat_set_output_root，或把 outputRoot 写进插件配置。',
    ),
  );
}

/** 从一堆可能的形状里尽力取出结构化信息。 */
function pickInfo(props: Record<string, unknown>): OutputInfo {
  const direct = props['info'];
  if (isOutputInfo(direct)) return direct;

  const value = props['value'];
  if (isOutputInfo(value)) return value;

  const meta = props['meta'];
  if (isOutputInfo(meta)) return meta;

  return {};
}

function isOutputInfo(value: unknown): value is OutputInfo {
  return typeof value === 'object' && value !== null && ('outputRoot' in value || 'listPath' in value);
}

export default OutputPanel;
