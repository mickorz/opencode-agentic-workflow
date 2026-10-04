/**
 * 声明式 workflow 装载器（P4）—— 用户自定义流程的 JSON 形态
 *
 * 装载契约（详见 dev-docs/planning/P4-custom-workflows.md）：
 *   - 入口：.json 文件路径 或 目录（扫一层 *.json）；相对项目目录
 *   - 步骤四类（互斥键）：agent / checkpoint / verify / fileExists
 *   - 模板：{{topic}}、{{args.x}}、{{steps.<name>}}；未知变量 = 步骤失败
 *   - 错误语义：装载期文件级 skip+warn（不阻断其他文件与内置流程）；
 *     运行期步骤级 failed（走既有 journal/resume 语义）
 *
 * 纪律：本文件属于 Core 侧资产装载，禁止 import OpenCode API
 * （架构不变量）；路径解析基准由调用方（plugin）传入。
 */

import { existsSync, statSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import type { WorkflowDefinition } from "../registry/definition.js"
import type { AnyWorkflowDefinition } from "../registry/registry.js"
import { agent } from "../workflow/agent.js"
import { assert } from "../quality/check.js"
import { assertVerify } from "../quality/verify.js"
import { checkpoint } from "../quality/checkpoint.js"
import { fileExists as fileExistsPredicate } from "../quality/predicates.js"

/** 步骤四类的声明形态（互斥键由校验保证） */
interface AgentStepDecl {
  name: string
  agent: string
}
interface CheckpointStepDecl {
  name: string
  checkpoint: string
}
interface VerifyStepDecl {
  name: string
  verify: { artifact: string; criteria?: string; reviewers?: number; label?: string }
}
interface FileExistsStepDecl {
  name: string
  fileExists: string
}
type StepDecl = AgentStepDecl | CheckpointStepDecl | VerifyStepDecl | FileExistsStepDecl

export interface DeclarativeWorkflow {
  id: string
  version?: string
  description?: string
  /** argsSchema（JSON Schema）；缺省 = 仅 topic（工具恒传） */
  args?: Record<string, unknown>
  steps: StepDecl[]
  /** 输出模板；缺省 = 最后一个 agent 步的输出 */
  output?: string
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/
const STEP_KEYS = ["agent", "checkpoint", "verify", "fileExists"] as const

/** 解析入口路径列表为 .json 文件列表（目录 = 一层扫描；不存在的入口报错） */
async function expandEntries(entries: string[], baseDir: string): Promise<{ files: string[]; errors: string[] }> {
  const files: string[] = []
  const errors: string[] = []
  for (const entry of entries) {
    const resolved = path.isAbsolute(entry) ? entry : path.join(baseDir, entry)
    if (!existsSync(resolved)) {
      errors.push(`${entry}: no such file or directory (${resolved})`)
      continue
    }
    const stat = statSync(resolved)
    if (stat.isDirectory()) {
      const names = (await readdir(resolved)).filter((n) => n.endsWith(".json")).sort()
      if (names.length === 0) {
        errors.push(`${entry}: directory has no *.json workflow files`)
        continue
      }
      files.push(...names.map((n) => path.join(resolved, n)))
    } else {
      files.push(resolved)
    }
  }
  return { files, errors }
}

/** 单文件校验：返回声明对象或错误文案（含文件名前缀） */
function validateWorkflow(raw: unknown, file: string): { ok: true; value: DeclarativeWorkflow } | { ok: false; error: string } {
  const at = (msg: string) => `${path.basename(file)}: ${msg}`
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: at("workflow file must be a JSON object") }
  }
  const dw = raw as Record<string, unknown>
  for (const key of Object.keys(dw)) {
    if (!["id", "version", "description", "args", "steps", "output"].includes(key)) {
      return { ok: false, error: at(`unknown top-level key "${key}" (allowed: id, version, description, args, steps, output)`) }
    }
  }
  if (typeof dw.id !== "string" || !ID_PATTERN.test(dw.id)) {
    return { ok: false, error: at(`"id" must match ${ID_PATTERN} (kebab-case, tool flow 参数直接用它)`) }
  }
  const version = typeof dw.version === "string" && dw.version.length > 0 ? dw.version : "1.0.0"
  if (dw.version !== undefined && version !== dw.version) {
    return { ok: false, error: at(`"version" must be a non-empty string`) }
  }
  if (dw.description !== undefined && typeof dw.description !== "string") {
    return { ok: false, error: at(`"description" must be a string`) }
  }
  if (dw.args !== undefined && (typeof dw.args !== "object" || dw.args === null)) {
    return { ok: false, error: at(`"args" must be a JSON Schema object`) }
  }
  if (!Array.isArray(dw.steps) || dw.steps.length === 0) {
    return { ok: false, error: at(`"steps" must be a non-empty array`) }
  }
  const names = new Set<string>()
  for (const [index, stepRaw] of dw.steps.entries()) {
    if (typeof stepRaw !== "object" || stepRaw === null) {
      return { ok: false, error: at(`steps[${index}] must be an object`) }
    }
    const step = stepRaw as Record<string, unknown>
    if (typeof step.name !== "string" || !ID_PATTERN.test(step.name)) {
      return { ok: false, error: at(`steps[${index}].name must match ${ID_PATTERN}`) }
    }
    if (names.has(step.name)) {
      return { ok: false, error: at(`duplicate step name "${step.name}"`) }
    }
    names.add(step.name)
    const present = STEP_KEYS.filter((k) => step[k] !== undefined)
    if (present.length !== 1) {
      return {
        ok: false,
        error: at(`steps[${index}] ("${step.name}") must have exactly one of ${STEP_KEYS.join("/")}, got [${present.join("/") || "none"}]`),
      }
    }
    const kind = present[0]!
    if (kind === "verify") {
      const v = step.verify
      if (typeof v !== "object" || v === null || typeof (v as Record<string, unknown>).artifact !== "string") {
        return { ok: false, error: at(`steps[${index}].verify must be { artifact: string, criteria?, reviewers?, label? }`) }
      }
      const vo = v as Record<string, unknown>
      for (const k of Object.keys(vo)) {
        if (!["artifact", "criteria", "reviewers", "label"].includes(k)) {
          return { ok: false, error: at(`steps[${index}].verify has unknown key "${k}"`) }
        }
      }
      if (vo.reviewers !== undefined && typeof vo.reviewers !== "number") {
        return { ok: false, error: at(`steps[${index}].verify.reviewers must be a number`) }
      }
    } else if (typeof step[kind] !== "string") {
      return { ok: false, error: at(`steps[${index}].${kind} must be a string (template)`) }
    }
    const unknownStepKeys = Object.keys(step).filter((k) => k !== "name" && !(STEP_KEYS as readonly string[]).includes(k))
    if (unknownStepKeys.length > 0) {
      return { ok: false, error: at(`steps[${index}] has unknown key(s) [${unknownStepKeys.join(", ")}] (allowed: name + 恰好一个步骤键)`) }
    }
  }
  if (dw.output !== undefined && typeof dw.output !== "string") {
    return { ok: false, error: at(`"output" must be a string (template)`) }
  }
  return {
    ok: true,
    value: {
      id: dw.id,
      version,
      description: dw.description,
      args: dw.args as Record<string, unknown> | undefined,
      steps: dw.steps as StepDecl[],
      output: dw.output,
    },
  }
}

/**
 * 模板解析：{{topic}} / {{args.x}} / {{steps.<name>}}（允许空白）。
 * 未知变量抛错（步骤级失败、journal 可见，绝不静默空串）。
 */
export function resolveTemplate(template: string, args: Record<string, unknown>, stepOutputs: ReadonlyMap<string, string>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, ref: string) => {
    if (ref === "topic") {
      const topic = args.topic
      if (topic === undefined) throw new Error(`[agentic-workflow] template variable {{topic}} is not provided (flow args lack topic)`)
      return String(topic)
    }
    if (ref.startsWith("args.")) {
      const key = ref.slice("args.".length)
      const value = (args as Record<string, unknown>)[key]
      if (value === undefined) throw new Error(`[agentic-workflow] template variable {{args.${key}}} is not provided`)
      return String(value)
    }
    if (ref.startsWith("steps.")) {
      const name = ref.slice("steps.".length)
      const value = stepOutputs.get(name)
      if (value === undefined) {
        throw new Error(
          `[agentic-workflow] template variable {{steps.${name}}} not found ` +
            `(available step outputs: [${[...stepOutputs.keys()].join(", ") || "none"}])`,
        )
      }
      return value
    }
    throw new Error(`[agentic-workflow] unknown template variable {{${ref}}} (supported: {{topic}}, {{args.x}}, {{steps.<name>}})`)
  })
}

function toDefinition(dw: DeclarativeWorkflow): AnyWorkflowDefinition {
  const lastAgentName = [...dw.steps].reverse().find((s): s is AgentStepDecl => "agent" in s)?.name
  return {
    id: dw.id,
    version: dw.version ?? "1.0.0",
    description: dw.description ?? `custom workflow (${dw.steps.length} steps)`,
    argsSchema:
      dw.args ?? {
        type: "object",
        properties: { topic: { type: "string", description: "主题（工具恒传参数）" } },
        required: ["topic"],
      },
    stepNames: dw.steps.map((s) => s.name),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async run(args: any, ctx: any) {
      const flowArgs = (args ?? {}) as Record<string, unknown>
      const stepOutputs = new Map<string, string>()
      const resolve = (template: string) => resolveTemplate(template, flowArgs, stepOutputs)
      const root = ctx.workspaceRoot ?? process.cwd()

      const built = dw.steps.map((step) => {
        if ("agent" in step) {
          return async (prev: Record<string, unknown> | undefined) => {
            const result = await agent(resolve(step.agent))
            stepOutputs.set(step.name, result.output)
            return { ...prev, [step.name]: result.output }
          }
        }
        if ("checkpoint" in step) {
          return async (prev: Record<string, unknown> | undefined) => {
            await checkpoint(resolve(step.checkpoint), { label: step.name })
            return { ...prev, [step.name]: "approved" }
          }
        }
        if ("verify" in step) {
          return async (prev: Record<string, unknown> | undefined) => {
            const result = await assertVerify(resolve(step.verify.artifact), {
              criteria: step.verify.criteria,
              reviewers: step.verify.reviewers,
              label: step.verify.label ?? step.name,
            })
            return { ...prev, [step.name]: result.passed ? "passed" : "failed" }
          }
        }
        return async (prev: Record<string, unknown> | undefined) => {
          const target = path.resolve(root, resolve(step.fileExists))
          await assert(() => fileExistsPredicate(target), `${step.name}: ${target} exists in workspace (${root})`)
          return { ...prev, [step.name]: target }
        }
      })

      await ctx.runSteps(built, { stepNames: dw.steps.map((s) => s.name) })

      const output = dw.output !== undefined ? resolve(dw.output) : stepOutputs.get(lastAgentName ?? "") ?? `workflow ${dw.id} completed`
      return { output }
    },
  } satisfies WorkflowDefinition<Record<string, unknown>, { output: string }> as AnyWorkflowDefinition
}

/**
 * 装载入口：读取 + 校验 + 转换。文件级错误收集返回（调用方 warn+跳过），
 * 绝不因单个坏文件中断装载。reservedIds 命中即拒（避免遮蔽内置流程）。
 */
export async function loadDeclarativeWorkflows(
  entries: string[],
  baseDir: string,
  reservedIds: string[] = [],
): Promise<{ definitions: AnyWorkflowDefinition[]; errors: string[] }> {
  const { files, errors } = await expandEntries(entries, baseDir)
  const definitions: AnyWorkflowDefinition[] = []
  const reserved = new Set(reservedIds)
  const seenIds = new Map<string, string>()
  for (const file of files) {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(file, "utf8"))
    } catch (error) {
      errors.push(`${path.basename(file)}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
      continue
    }
    const validated = validateWorkflow(raw, file)
    if (!validated.ok) {
      errors.push(validated.error)
      continue
    }
    const dw = validated.value
    if (reserved.has(dw.id)) {
      errors.push(`${path.basename(file)}: id "${dw.id}" is reserved by a built-in workflow`)
      continue
    }
    const seenIn = seenIds.get(`${dw.id}@${dw.version}`)
    if (seenIn) {
      errors.push(`${path.basename(file)}: duplicate ${dw.id}@${dw.version} (already loaded from ${seenIn})`)
      continue
    }
    seenIds.set(`${dw.id}@${dw.version}`, path.basename(file))
    definitions.push(toDefinition(dw))
  }
  return { definitions, errors }
}
