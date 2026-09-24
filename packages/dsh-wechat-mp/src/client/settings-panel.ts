/**
 * 可视化配置工作台（设置页里的一个 section）。
 *
 * 注册形态照抄宿主自己的活样例（`dsh-client-ui-agent-preset`）：
 *
 * ```js
 * ctx.slots.inject("settings.section", () => ctx.slots.register({
 *   name: "settings.section", id: "agent-presets", order: 20,
 *   label: () => …, locale: …, inject: sectionInjected
 * }, AgentPresetSection))
 * ```
 *
 * 数据流：面板从 `GET /wechat-mp/config` 读当前值，保存时
 * `POST /wechat-mp/config`（带自定义头，见 config-routes.ts 的安全说明）。
 */
import { createElement as h, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

export const SECTION_ID = 'wechat-mp';

const CONFIG_URL = '/wechat-mp/config';

interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'checkbox';
  hint: string;
  options?: readonly string[];
}

const FIELDS: readonly FieldSpec[] = [
  { key: 'outputRoot', label: '输出根目录', type: 'text', hint: '留空 = 当前工作区下的 output/' },
  { key: 'listPath', label: '清单文件路径', type: 'text', hint: '留空 = 工作区根目录下的 url-list.json' },
  { key: 'layout', label: '落盘布局', type: 'select', options: ['flat', 'byAccountDate'], hint: 'flat=按标题；byAccountDate=按 账号/年月/日期_标题' },
  { key: 'pageDelayMs', label: '枚举翻页间隔(ms)', type: 'number', hint: '默认 3000。**不要调低** —— 风控代价不对称' },
  { key: 'maxArticles', label: '单次枚举上限(篇)', type: 'number', hint: '默认 500，硬上限' },
  { key: 'fetchTimeoutMs', label: '单篇抓取超时(ms)', type: 'number', hint: '默认 120000。到点自动止损，不会永远卡住' },
  { key: 'proxy', label: '抓取代理', type: 'text', hint: "direct | env | 代理地址" },
  { key: 'fetchAfterSync', label: '枚举完直接抓正文', type: 'checkbox', hint: '默认关：把两步分开，便于中断' },
];

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '640px', fontSize: '13px' },
  row: { display: 'flex', flexDirection: 'column', gap: '3px' },
  labelRow: { display: 'flex', gap: '8px', alignItems: 'baseline' },
  label: { fontWeight: '500' },
  input: {
    font: 'inherit',
    padding: '5px 8px',
    borderRadius: '6px',
    border: '1px solid var(--color-border-secondary, rgba(0,0,0,.25))',
    background: 'transparent',
    color: 'inherit',
  },
  hint: { fontSize: '11.5px', opacity: '0.65' },
  actions: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '4px' },
  button: {
    font: 'inherit',
    padding: '5px 14px',
    borderRadius: '6px',
    border: '1px solid var(--color-border-secondary, rgba(0,0,0,.25))',
    cursor: 'pointer',
  },
  status: { fontSize: '12px' },
  paths: { fontSize: '11.5px', opacity: '0.75', lineHeight: '1.6' },
} as const;

type Values = Record<string, string | boolean>;

/** 从当前配置里取出表单要的值（统一成字符串，checkbox 除外）。 */
function toFormValues(config: Record<string, unknown>): Values {
  const values: Values = {};
  for (const field of FIELDS) {
    const raw = config[field.key];
    values[field.key] = field.type === 'checkbox' ? raw === true : raw === undefined || raw === null ? '' : String(raw);
  }
  return values;
}

/** 把表单值转回请求体（数字字段转回 number，空串不提交）。 */
function toRequestBody(values: Values): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of FIELDS) {
    const value = values[field.key];
    if (field.type === 'checkbox') {
      body[field.key] = value === true || value === 'true';
      continue;
    }
    const text = String(value ?? '').trim();
    if (text.length === 0) continue;
    body[field.key] = field.type === 'number' ? Number(text) : text;
  }
  return body;
}

export function WechatMpSettings(): ReactElement {
  const [values, setValues] = useState<Values>(() => Object.fromEntries(FIELDS.map((f) => [f.key, ''])));
  const [paths, setPaths] = useState<string[]>([]);
  const [status, setStatus] = useState('加载中…');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(CONFIG_URL, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) {
          setStatus(`读取配置失败（HTTP ${res.status}）`);
          return;
        }
        const data = (await res.json()) as { config?: Record<string, unknown>; paths?: Record<string, string> };
        if (data.config) setValues(toFormValues(data.config));
        if (data.paths) {
          setPaths([
            `输出根目录：${data.paths.outputRoot}（${data.paths.outputOrigin}）`,
            `清单文件：${data.paths.listPath}`,
          ]);
        }
        setStatus('');
      } catch {
        setStatus('读取配置失败（服务不可达）');
      }
    })();
    return () => controller.abort();
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setStatus('保存中…');
    try {
      const res = await fetch(CONFIG_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dsh-wechat-mp-client': '1' },
        body: JSON.stringify(toRequestBody(values)),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; config?: Record<string, unknown>; paths?: Record<string, string> };
      if (!res.ok || data.ok !== true) {
        setStatus(`保存失败：${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      if (data.config) setValues(toFormValues(data.config));
      if (data.paths) {
        setPaths([
          `输出根目录：${data.paths.outputRoot}（${data.paths.outputOrigin}）`,
          `清单文件：${data.paths.listPath}`,
        ]);
      }
      setStatus('✅ 已保存并即时生效');
    } catch {
      setStatus('保存失败（服务不可达）');
    } finally {
      setBusy(false);
    }
  };

  return h(
    'div',
    { style: styles.wrap },
    paths.length > 0 ? h('div', { style: styles.paths }, paths.map((line, i) => h('div', { key: i }, line))) : null,
    FIELDS.map((field) =>
      h(
        'div',
        { style: styles.row, key: field.key },
        h('div', { style: styles.labelRow }, h('span', { style: styles.label }, field.label)),
        field.type === 'checkbox'
          ? h('input', {
              type: 'checkbox',
              checked: values[field.key] === true || values[field.key] === 'true',
              onChange: (e: { target: { checked: boolean } }) =>
                setValues((prev) => ({ ...prev, [field.key]: e.target.checked })),
            })
          : field.type === 'select'
            ? h(
                'select',
                {
                  style: styles.input,
                  value: String(values[field.key] ?? ''),
                  onChange: (e: { target: { value: string } }) =>
                    setValues((prev) => ({ ...prev, [field.key]: e.target.value })),
                },
                (field.options ?? []).map((option) => h('option', { key: option, value: option }, option)),
              )
            : h('input', {
                style: styles.input,
                type: field.type,
                value: String(values[field.key] ?? ''),
                onChange: (e: { target: { value: string } }) =>
                  setValues((prev) => ({ ...prev, [field.key]: e.target.value })),
              }),
        field.hint ? h('div', { style: styles.hint }, field.hint) : null,
      ),
    ),
    h(
      'div',
      { style: styles.actions },
      h('button', { style: styles.button, type: 'button', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存'),
      h('span', { style: styles.status }, status),
    ),
    h(
      'div',
      { style: styles.hint },
      '保存后即时生效（写进工作区的 .dsh-wechat-mp/config.json，重启后仍有效）。' +
        '要恢复 cordis.yml 的默认值，把字段清空再保存。',
    ),
  );
}

export default WechatMpSettings;
