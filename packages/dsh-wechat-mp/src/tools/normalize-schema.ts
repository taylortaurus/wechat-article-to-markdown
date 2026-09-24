/**
 * 工具 schema 的规范化层。
 *
 * **为什么需要它**：dsh 要求**显式对象节点必须声明 `additionalProperties: true | false`**，
 * 否则 `defineTool` 注册时直接抛 `JsonSchemaError: unsupported JSON schema:
 * schema.additionalProperties must be explicitly true or false` —— 而且报错不会告诉你是
 * 哪个工具，整个插件都会加载失败。
 *
 * 这条规则是集成测试发现的（`tests/unit/apply.test.ts`）。手写 schema 时，任何一个
 * 嵌套对象漏掉这个字段都会炸，所以除了提供 `schema.ts` 里的构造函数之外，
 * 这里再做一道**兜底**：注册前把整棵 schema 走一遍，给所有对象节点补上该字段。
 *
 * 两道防线是有意的：
 *  - `schema.ts` 让新写的工具**自己就是对的**（可读、显式）；
 *  - 这里的规范化保证**已写好的、或将来别人写的**工具不会因为漏一个字段而整体挂掉。
 *
 * 规范化是幂等的：已经有 `additionalProperties` 的节点不会被改动。
 * 规则出处：`/reference/cookbook/adding-a-tool`。
 */

/** 递归地给所有对象节点补 `additionalProperties: false`（已声明的保持原样）。 */
export function normalizeValueSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeValueSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = normalizeValueSchema(value);
  }

  // 只有"显式对象节点"需要这个字段。`type: 'object'` 就是显式声明。
  if (out['type'] === 'object' && !('additionalProperties' in out)) {
    out['additionalProperties'] = false;
  }
  return out;
}

/** 工具定义里需要规范化的地方：`parameters` 与 `output.schema`。 */
export function normalizeToolSchema(tool: unknown): unknown {
  if (tool === null || typeof tool !== 'object') return tool;
  const source = tool as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };

  if (source['parameters'] !== undefined) {
    out['parameters'] = normalizeValueSchema(source['parameters']);
  }
  const output = source['output'];
  if (output !== null && typeof output === 'object') {
    const outputRecord = output as Record<string, unknown>;
    out['output'] = {
      ...outputRecord,
      ...(outputRecord['schema'] === undefined
        ? {}
        : { schema: normalizeValueSchema(outputRecord['schema']) }),
    };
  }
  return out;
}

/** 一个会做 schema 规范化的工具注册表包装。 */
export interface ToolRegistryLike {
  register(tool: unknown): unknown;
}

/**
 * 包一层注册表：注册前先规范化 schema。
 *
 * 用它替换掉直接把 `ctx.tools` 传下去的做法 —— 这样任何一个工具定义漏了
 * `additionalProperties` 也不会让插件整体加载失败。
 */
export function withNormalizedSchemas(
  tools: ToolRegistryLike,
  beforeExecute?: (exec: unknown) => void,
): ToolRegistryLike {
  return {
    register(tool: unknown) {
      const normalized = normalizeToolSchema(tool);
      const wrapped = beforeExecute ? wrapExecute(normalized, beforeExecute) : normalized;
      return tools.register(wrapped);
    },
  };
}

/**
 * 把 `execute` 包一层：执行前先跑一个钩子。
 *
 * 用在这里是为了让**每个工具都在执行时刷新"当前会话的工作目录"**，
 * 而不是靠每个工具自觉去调 —— 漏一个就会把产物写到错误的地方。
 */
function wrapExecute(tool: unknown, beforeExecute: (exec: unknown) => void): unknown {
  if (tool === null || typeof tool !== 'object') return tool;
  const source = tool as Record<string, unknown>;
  const execute = source['execute'];
  if (typeof execute !== 'function') return tool;

  return {
    ...source,
    execute: async (args: unknown, exec: unknown) => {
      try {
        beforeExecute(exec);
      } catch {
        // 钩子失败不能连累工具本身
      }
      return (execute as (a: unknown, e: unknown) => Promise<unknown>).call(source, args, exec);
    },
  };
}
