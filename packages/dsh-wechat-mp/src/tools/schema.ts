/**
 * 工具 schema 的小工具。
 *
 * **为什么有这个文件**：dsh 对工具 schema 有一条硬性规定 ——
 * **显式对象节点必须声明 `additionalProperties: true | false`**，否则 `defineTool`
 * 在注册时直接抛 `JsonSchemaError: unsupported JSON schema`。
 *
 * 这条规则是集成测试（`tests/unit/apply.test.ts`）发现的，而且坑在于：
 * **`defineTool` 是在"定义时"就校验的**，不是在注册时。所以任何"在注册边界上兜底"
 * 的做法都太晚 —— 必须在**调用 `defineTool` 之前**把 schema 补好。
 *
 * 因此这个文件同时提供两样东西：
 *  1. `object` / `array` / `string` … 这些构造函数，让新写的工具**天生就是对的**；
 *  2. 一个包装过的 `defineTool`，在转发给 dsh 之前先规范化整棵 schema，
 *     保证"漏写一个字段"不会让整个插件加载失败。
 *
 * 规则出处：`/reference/cookbook/adding-a-tool` 的「execute() 约定的规则」——
 * "显式对象节点必须声明 `additionalProperties: true | false`；隐式参数根对象保持开放"。
 */
import { defineTool as dshDefineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';

import { normalizeToolSchema } from './normalize-schema.js';

/**
 * 包装过的 `defineTool`。
 *
 * 与 dsh 的签名完全一致，只是在转发前把 `parameters` 与 `output.schema` 里的
 * 对象节点补上 `additionalProperties`。
 *
 * **本插件里的工具一律用这个，不要直接用 `@deepseek-ai/dsh-tools` 的那个。**
 */
export function defineTool<A, V>(definition: ToolDefinition<A, V>): unknown {
  return dshDefineTool(normalizeToolSchema(definition) as ToolDefinition<A, V>);
}

/** 一个对象节点。**默认 `additionalProperties: false`**（收紧，不放开未声明的字段）。 */
export function object(
  properties: Record<string, unknown>,
  options: { additionalProperties?: boolean; required?: readonly string[] } = {},
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    additionalProperties: options.additionalProperties ?? false,
    ...(options.required === undefined ? {} : { required: [...options.required] }),
  };
}

/** 一个数组节点。`items` 必填 —— 不声明 items 的数组在严格校验下同样不合法。 */
export function array(items: unknown): Record<string, unknown> {
  return { type: 'array', items };
}

/** 字符串。 */
export const string = { type: 'string' } as const;
/** 数字。 */
export const number = { type: 'number' } as const;
/** 布尔。 */
export const boolean = { type: 'boolean' } as const;

/**
 * 参数声明（输入侧）。
 *
 * 输入侧的形状和输出侧不同：它用 `required: true` 标在字段上，而不是一个 `required` 数组。
 */
export function param(
  type: 'string' | 'number' | 'boolean',
  description: string,
  required = false,
): Record<string, unknown> {
  return { type, description, ...(required ? { required: true } : {}) };
}

/** 只描述形状、不校验的"任意对象"（比如透传的元数据块）。 */
export const looseObject: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
};
