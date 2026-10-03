/**
 * Args JSON Schema 子集（P2.5）
 *
 * 项目保持零依赖：不引入 Zod，实现最小 JSON Schema 校验
 * （type/properties/required/enum/items/description，支持嵌套与联合类型）。
 * 该契约同时用于：tool schema 生成、args 校验、未来 TUI 表单 / Hub 展示。
 */

/** 最小 JSON Schema 子集（声明 args 契约用） */
export interface ArgsSchema {
  type?: string | string[]
  properties?: Record<string, ArgsSchema>
  required?: string[]
  enum?: unknown[]
  items?: ArgsSchema
  description?: string
}

/** args 校验：返回问题列表（空数组 = 合法） */
export function validateArgs(schema: ArgsSchema | undefined, args: unknown): string[] {
  if (!schema) return []
  return validateValue(schema, args, "args")
}

function validateValue(schema: ArgsSchema, value: unknown, path: string): string[] {
  const problems: string[] = []

  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!expected.some((t) => matchesType(t, value))) {
      problems.push(`${path}: expected type ${expected.join("|")}, got ${typeName(value)}`)
      return problems // 类型不对，后续检查无意义
    }
  }

  if (schema.enum && !schema.enum.some((candidate) => candidate === value)) {
    problems.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`)
  }

  if (typeof value === "object" && value !== null && schema.properties) {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in record) || record[key] === undefined) {
        problems.push(`${path}: missing required property "${key}"`)
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (key in record && record[key] !== undefined) {
        problems.push(...validateValue(childSchema, record[key], `${path}.${key}`))
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      problems.push(...validateValue(schema.items!, item, `${path}[${index}]`))
    })
  }

  return problems
}

function matchesType(expected: string, value: unknown): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number" && !Number.isNaN(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "boolean":
      return typeof value === "boolean"
    case "array":
      return Array.isArray(value)
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
    case "null":
      return value === null
    default:
      return true // 未知类型名不设限（前向兼容）
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}
