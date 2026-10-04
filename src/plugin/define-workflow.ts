/**
 * workflow_define 核心（v1-parity P0-2：自然语言 → 声明式 JSON 生成链路）
 *
 * 主 agent 在对话中把需求整理成声明式 JSON，经本函数「校验 → 注册 → 落盘」，
 * 全程无需人工编辑文件——v1「零代码」体验在 v2 的声明式形态。
 *
 * 语义（与既有纪律对齐）：
 * - 校验复用装载器同一套规则（validateWorkflow），错误逐一指名
 * - 内置保留 id 直接拒绝（防遮蔽，同装载器 reservedIds 语义）
 * - 注册先行、落盘其后：同 id@version 重复注册被拦（版本契约）；
 *   内容相同的重复 define = 幂等成功（agent 重试友好）；
 *   内容不同 = 拒绝并提示升 version（registry 同 id 多版本共存，取最新）
 * - 落盘失败 fail-loud 报告（会话内已注册但未持久化，明确说出后果与修法）
 *
 * 纪律：Core 侧逻辑，禁止 import OpenCode API（架构不变量）。
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { WorkflowRegistrationError } from "../registry/errors.js"
import type { WorkflowRegistry } from "../registry/registry.js"
import { toDefinition, validateWorkflow } from "../workflows/loader.js"

export interface DefineOutcome {
  ok: boolean
  /** 给主 agent 看的结果文案（成功含调用指引，失败含精确修法） */
  message: string
}

export async function defineWorkflow(params: {
  registry: WorkflowRegistry
  /** 内置流程 id（防遮蔽）；与 init 装载用的 reservedIds 同源 */
  reservedIds: readonly string[]
  /** 待定义的声明式 JSON（未经校验的原始对象） */
  raw: unknown
  /** 已配置的 flows 候选目录（绝对路径；来自插件 options.workflows 的解析） */
  flowsDirs: readonly string[]
  /** 显式目标目录覆盖（绝对路径） */
  dir?: string
}): Promise<DefineOutcome> {
  const { registry, reservedIds, raw, flowsDirs, dir } = params

  const checked = validateWorkflow(raw, "workflow_define")
  if (!checked.ok) {
    return { ok: false, message: `[agentic-workflow] invalid workflow definition: ${checked.error}` }
  }
  const dw = checked.value

  if (reservedIds.includes(dw.id)) {
    return {
      ok: false,
      message: `[agentic-workflow] id "${dw.id}" is reserved by a built-in workflow; pick a different id`,
    }
  }

  const targetDir = dir && dir.length > 0 ? dir : flowsDirs[0] ?? ""
  if (!targetDir) {
    return {
      ok: false,
      message:
        "[agentic-workflow] no flows directory configured: add " +
        '\\"workflows\\": ["flows"] to the plugin options (opencode.json) and define again',
    }
  }

  const definition = toDefinition(dw)
  try {
    registry.register(definition)
  } catch (error) {
    if (error instanceof WorkflowRegistrationError) {
      // 同 id@version 已注册：内容相同 = 幂等成功；不同 = 版本契约拒绝
      if (isSameDefinition(registry, dw.id, dw.version ?? "1.0.0", definition)) {
        return {
          ok: true,
          message:
            `[agentic-workflow] ${dw.id}@${dw.version} already defined (identical) - ready to call. ` +
            "No changes were needed.",
        }
      }
      return {
        ok: false,
        message:
          `[agentic-workflow] ${dw.id}@${dw.version} is already registered with DIFFERENT content: ` +
          'bump "version" to publish the change (the registry keeps versions side by side and ' +
          "runs the latest; resume still resolves old journals against their exact version).",
      }
    }
    throw error
  }

  const filePath = path.join(targetDir, `${dw.id}.json`)
  try {
    await mkdir(targetDir, { recursive: true })
    await writeFile(filePath, JSON.stringify(dw, null, 2) + "\n", "utf8")
  } catch (error) {
    return {
      ok: false,
      message:
        `[agentic-workflow] registered ${dw.id}@${dw.version} for THIS session, but persisting to ` +
        `${filePath} failed: ${error instanceof Error ? error.message : String(error)}. The definition ` +
        "will be lost on restart - fix the directory, then define again with a bumped version " +
        "(the already-registered error for this version is expected; the file on disk wins after restart).",
    }
  }

  return {
    ok: true,
    message:
      `[agentic-workflow] defined ${dw.id}@${dw.version} ` +
      `(${(definition.stepNames ?? []).join(" -> ")})\n` +
      `persisted: ${filePath} (auto-loads on every start)\n` +
      `call it: workflow tool with flow="${dw.id}", topic=<...>` +
      (dw.args ? " plus the args your schema declares" : ""),
  }
}

/** 与已注册的同 id@version 定义比对「声明层」等价性（run 闭包无法深比较） */
function isSameDefinition(
  registry: WorkflowRegistry,
  id: string,
  version: string,
  candidate: { description?: string; argsSchema?: unknown; stepNames?: string[] },
): boolean {
  let existing: { description?: string; argsSchema?: unknown; stepNames?: string[] } | undefined
  try {
    existing = registry.resolve(id, version)
  } catch {
    return false
  }
  if (!existing) return false
  return (
    existing.description === candidate.description &&
    JSON.stringify(existing.argsSchema) === JSON.stringify(candidate.argsSchema) &&
    JSON.stringify(existing.stepNames) === JSON.stringify(candidate.stepNames)
  )
}
