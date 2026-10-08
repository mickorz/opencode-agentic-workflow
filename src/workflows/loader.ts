/**
 * 声明式 workflow 装载器（P4）—— 用户自定义流程的 JSON 形态
 *
 * 装载契约（详见 dev-docs/planning/P4-custom-workflows.md）：
 *   - 入口：.json 文件路径 或 目录（扫一层 *.json）；相对项目目录
 *   - 步骤七类（互斥键）：agent / checkpoint / verify / fileExists / subflow /
 *     pipeline（条目并发 fan-out，{{item}} 引用条目）/ race（≥2 提示竞速取首胜）
 *   - 模板：{{topic}}、{{args.x}}、{{steps.<name>}}；pipeline 提示额外支持
 *     {{item}}（条目字面替换，先于通用模板解析）；未知变量 = 步骤失败
 *   - 并发步骤的 resume 粒度：pipeline/race 各占一个 journal 步骤单元
 *     （completed 即整体跳过；中断重跑整步——与 sequence 前缀语义一致）
 *   - 错误语义：装载期文件级 skip+warn（不阻断其他文件与内置流程）；
 *     运行期步骤级 failed（走既有 journal/resume 语义）
 *
 * 纪律：本文件属于 Core 侧资产装载，禁止 import OpenCode API
 * （架构不变量）；路径解析基准由调用方（plugin）传入。
 */

import { existsSync, statSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import type { WorkflowDefinition } from "../registry/definition.js"
import type { AnyWorkflowDefinition } from "../registry/registry.js"
import { agent } from "../workflow/agent.js"
import { pipeline } from "../workflow/pipeline.js"
import { race } from "../workflow/race.js"
import { assert } from "../quality/check.js"
import { assertVerify } from "../quality/verify.js"
import { checkpoint } from "../quality/checkpoint.js"
import { fileExists as fileExistsPredicate } from "../quality/predicates.js"

/** 步骤四类的声明形态（互斥键由校验保证） */
interface AgentStepDecl {
  name: string
  agent: string
  /** P1-4 调用级选项（仅 agent 步可用） */
  model?: string
  timeoutMs?: number
  retries?: number
}
interface CheckpointStepDecl {
  name: string
  checkpoint: string
}
interface VerifyStepDecl {
  name: string
  verify: {
    artifact: string
    criteria?: string
    reviewers?: number
    label?: string
    /** P2-11：投票阈值 (0,1]，缺省 1 = 全票 */
    threshold?: number
    /** P2-11：多视角评审（一个 lens 一个评审员，覆盖 reviewers/criteria） */
    lenses?: Array<{ name: string; criteria: string }>
  }
}
interface FileExistsStepDecl {
  name: string
  fileExists: string
}
/** P2-9 子工作流步骤：subflow = 目标 flow id（模板）；args 值支持模板 */
interface SubflowStepDecl {
  name: string
  subflow: string
  args?: Record<string, string | number | boolean>
}
/**
 * 并发流水线步骤（声明式 pipeline）：pipeline = 每条目提示模板（{{item}} 引用条目，
 * 其余变量走通用模板）；items = 条目模板数组（每项解析后原样作为条目值）。
 * 条目并发、单阶段（多阶段链用代码式 combinator）；结果数组（与 items 对齐）
 * 并入 state[outputAs ?? name]。
 */
interface PipelineStepDecl {
  name: string
  pipeline: string
  /** 条目（每项为模板） */
  items: string[]
  /** 结果并入 state 的键（缺省 = 步骤名） */
  outputAs?: string
  /** 失败模式（与代码式 pipeline 同语义，缺省 fail-fast） */
  onFailure?: "fail-fast" | "continue"
  /** agent 调用级选项（每条目同规则透传） */
  model?: string
  timeoutMs?: number
  retries?: number
}
/**
 * 竞速步骤（声明式 race）：race = 竞速提示模板数组（≥2），并发起跑、
 * 首个成功者输出并入 state[outputAs ?? name]；全败抛 WorkflowRaceError。
 */
interface RaceStepDecl {
  name: string
  race: string[]
  /** 结果并入 state 的键（缺省 = 步骤名） */
  outputAs?: string
}
type StepDecl =
  | AgentStepDecl
  | CheckpointStepDecl
  | VerifyStepDecl
  | FileExistsStepDecl
  | SubflowStepDecl
  | PipelineStepDecl
  | RaceStepDecl

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
const STEP_KEYS = ["agent", "checkpoint", "verify", "fileExists", "subflow", "pipeline", "race"] as const

/** 各步骤键开放的可选键（未知键拒绝；无则仅 name + 步骤键本身） */
const OPTION_KEYS_BY_KIND: Record<string, string[]> = {
  agent: ["model", "timeoutMs", "retries"],
  subflow: ["args"],
  pipeline: ["items", "outputAs", "onFailure", "model", "timeoutMs", "retries"],
  race: ["outputAs"],
}

/** agent 调用级选项校验（agent 步与 pipeline 步共用同一规则） */
function checkAgentOptions(step: Record<string, unknown>, index: number): string | undefined {
  if (step.model !== undefined && (typeof step.model !== "string" || !step.model.includes("/"))) {
    return `steps[${index}].model must be "providerID/modelId"`
  }
  if (
    step.timeoutMs !== undefined &&
    (typeof step.timeoutMs !== "number" || !Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)
  ) {
    return `steps[${index}].timeoutMs must be a positive number (ms)`
  }
  if (
    step.retries !== undefined &&
    (typeof step.retries !== "number" || !Number.isInteger(step.retries) || step.retries < 0)
  ) {
    return `steps[${index}].retries must be a non-negative integer`
  }
  return undefined
}

/** 代码流程模块扩展名（P2-14：flows 目录可放 JS 模块，恢复 v1 自定义逻辑能力） */
const CODE_EXTENSIONS = [".js", ".mjs", ".cjs"] as const

function isWorkflowFileName(name: string): boolean {
  return name.endsWith(".json") || CODE_EXTENSIONS.some((ext) => name.endsWith(ext))
}

/** 解析入口路径列表为流程文件列表（目录 = 一层扫描；不存在的入口报错） */
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
      const names = (await readdir(resolved)).filter(isWorkflowFileName).sort()
      if (names.length === 0) {
        errors.push(`${entry}: directory has no workflow files (.json/.js/.mjs/.cjs)`)
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
export function validateWorkflow(raw: unknown, file: string): { ok: true; value: DeclarativeWorkflow } | { ok: false; error: string } {
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
    // 各步骤键开放的可选键（P1-4 agent 调用级选项；P2-9 subflow args；
    // pipeline items/outputAs/onFailure + 调用级选项；race outputAs）
    const optionKeys = OPTION_KEYS_BY_KIND[kind] ?? []
    if (kind === "agent" || kind === "pipeline") {
      const optionError = checkAgentOptions(step, index)
      if (optionError) {
        return { ok: false, error: at(optionError) }
      }
    }
    if (kind === "verify") {
      const v = step.verify
      if (typeof v !== "object" || v === null || typeof (v as Record<string, unknown>).artifact !== "string") {
        return { ok: false, error: at(`steps[${index}].verify must be { artifact: string, criteria?, reviewers?, label?, threshold?, lenses? }`) }
      }
      const vo = v as Record<string, unknown>
      for (const k of Object.keys(vo)) {
        if (!["artifact", "criteria", "reviewers", "label", "threshold", "lenses"].includes(k)) {
          return { ok: false, error: at(`steps[${index}].verify has unknown key "${k}"`) }
        }
      }
      if (vo.reviewers !== undefined && typeof vo.reviewers !== "number") {
        return { ok: false, error: at(`steps[${index}].verify.reviewers must be a number`) }
      }
      // P2-11 投票阈值：数值且在 (0, 1]
      if (
        vo.threshold !== undefined &&
        (typeof vo.threshold !== "number" || !Number.isFinite(vo.threshold) || vo.threshold <= 0 || vo.threshold > 1)
      ) {
        return { ok: false, error: at(`steps[${index}].verify.threshold must be a number in (0, 1]`) }
      }
      // P2-11 多视角：非空数组，每项 { name, criteria } 均为非空字符串
      if (vo.lenses !== undefined) {
        if (!Array.isArray(vo.lenses) || vo.lenses.length === 0) {
          return { ok: false, error: at(`steps[${index}].verify.lenses must be a non-empty array of { name, criteria }`) }
        }
        for (const [li, lens] of (vo.lenses as Array<unknown>).entries()) {
          const lo = lens as Record<string, unknown>
          if (typeof lo !== "object" || lo === null || typeof lo.name !== "string" || lo.name.length === 0 || typeof lo.criteria !== "string" || lo.criteria.length === 0) {
            return { ok: false, error: at(`steps[${index}].verify.lenses[${li}] must be { name: non-empty string, criteria: non-empty string }`) }
          }
          for (const k of Object.keys(lo)) {
            if (!["name", "criteria"].includes(k)) {
              return { ok: false, error: at(`steps[${index}].verify.lenses[${li}] has unknown key "${k}"`) }
            }
          }
        }
      }
    } else if (kind === "subflow") {
      // P2-9：args = 原始值（number/boolean）或字符串模板的对象
      if (step.args !== undefined) {
        if (typeof step.args !== "object" || step.args === null || Array.isArray(step.args)) {
          return { ok: false, error: at(`steps[${index}].args must be an object of primitives or templates`) }
        }
        for (const [argKey, argValue] of Object.entries(step.args as Record<string, unknown>)) {
          if (typeof argValue !== "string" && typeof argValue !== "number" && typeof argValue !== "boolean") {
            return { ok: false, error: at(`steps[${index}].args.${argKey} must be a string (template), number, or boolean`) }
          }
        }
      }
    } else if (kind === "pipeline") {
      // 声明式 pipeline：payload 非空提示模板 + items 非空模板数组 + 可选键类型
      if (typeof step.pipeline !== "string" || step.pipeline.length === 0) {
        return { ok: false, error: at(`steps[${index}].pipeline must be a non-empty string (prompt template, {{item}} references the entry)`) }
      }
      if (
        !Array.isArray(step.items) ||
        step.items.length === 0 ||
        !step.items.every((it) => typeof it === "string" && it.length > 0)
      ) {
        return { ok: false, error: at(`steps[${index}].items must be a non-empty array of non-empty string templates`) }
      }
      if (step.outputAs !== undefined && (typeof step.outputAs !== "string" || !ID_PATTERN.test(step.outputAs))) {
        return { ok: false, error: at(`steps[${index}].outputAs must match ${ID_PATTERN}`) }
      }
      if (step.onFailure !== undefined && step.onFailure !== "fail-fast" && step.onFailure !== "continue") {
        return { ok: false, error: at(`steps[${index}].onFailure must be "fail-fast" | "continue"`) }
      }
    } else if (kind === "race") {
      // 声明式 race：≥2 个非空提示模板（单分支无竞速意义，fail-loud）+ outputAs
      if (
        !Array.isArray(step.race) ||
        step.race.length < 2 ||
        !step.race.every((p) => typeof p === "string" && p.length > 0)
      ) {
        return { ok: false, error: at(`steps[${index}].race must be an array of at least 2 non-empty prompt templates`) }
      }
      if (step.outputAs !== undefined && (typeof step.outputAs !== "string" || !ID_PATTERN.test(step.outputAs))) {
        return { ok: false, error: at(`steps[${index}].outputAs must match ${ID_PATTERN}`) }
      }
    } else if (typeof step[kind] !== "string") {
      return { ok: false, error: at(`steps[${index}].${kind} must be a string (template)`) }
    }
    const unknownStepKeys = Object.keys(step).filter(
      (k) =>
        k !== "name" &&
        !(STEP_KEYS as readonly string[]).includes(k) &&
        !optionKeys.includes(k),
    )
    if (unknownStepKeys.length > 0) {
      return {
        ok: false,
        error: at(
          `steps[${index}] has unknown key(s) [${unknownStepKeys.join(", ")}] ` +
            `(allowed: name + exactly one step key (${STEP_KEYS.join("/")})` +
            `${optionKeys.length > 0 ? ` + optional ${optionKeys.join("/")}` : ""})`,
        ),
      }
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

/** P0-2：声明对象 -> 可注册 definition（workflow_define 内联定义复用同一转换） */
export function toDefinition(dw: DeclarativeWorkflow): AnyWorkflowDefinition {
  // 默认输出来源：最后一个「产出型」步骤（agent 原文 / race 胜者原文；
  // pipeline 为结果数组的 JSON 串——需要可读输出就显式写 output 模板）
  const lastProducerName = [...dw.steps]
    .reverse()
    .find((s): s is AgentStepDecl | PipelineStepDecl | RaceStepDecl => "agent" in s || "pipeline" in s || "race" in s)?.name
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
            // P1-4：声明级调用选项透传（model/timeoutMs/retries）
            const result = await agent(resolve(step.agent), {
              ...(step.model !== undefined ? { model: step.model } : {}),
              ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
              ...(step.retries !== undefined ? { retries: step.retries } : {}),
            })
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
              // P2-11：投票阈值 + 多视角透传
              ...(step.verify.threshold !== undefined
                ? { passThreshold: step.verify.threshold }
                : {}),
              ...(step.verify.lenses !== undefined ? { lenses: step.verify.lenses } : {}),
            })
            return { ...prev, [step.name]: result.passed ? "passed" : "failed" }
          }
        }
        if ("subflow" in step) {
          return async (prev: Record<string, unknown> | undefined) => {
            if (typeof ctx.subflow !== "function") {
              throw new Error(
                `[agentic-workflow] subflow step "${step.name}" requires the journalDir ` +
                  "plugin option (subflow runs are journaled with lineage)",
              )
            }
            // args 值：字符串走模板解析，原始值直传
            const subArgs: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(step.args ?? {})) {
              subArgs[key] = typeof value === "string" ? resolve(value) : value
            }
            const result = await ctx.subflow(resolve(step.subflow), subArgs)
            stepOutputs.set(step.name, result.output)
            return { ...prev, [step.name]: result.output }
          }
        }
        if ("pipeline" in step) {
          return async (prev: Record<string, unknown> | undefined) => {
            // 条目 = 模板数组逐项解析（{{topic}}/{{args.x}}/{{steps.x}}）
            const items = step.items.map((tpl) => resolve(tpl))
            // 每条目一次 agent 调用；{{item}} 先字面替换（replace 用函数形参，
            // 条目含 $ 等特殊字符不受 replacement pattern 影响）再走通用模板
            const results = await pipeline(
              items,
              [
                async (item: string) => {
                  const prompt = resolveTemplate(
                    step.pipeline.replace(/\{\{\s*item\s*\}\}/g, () => item),
                    flowArgs,
                    stepOutputs,
                  )
                  const result = await agent(prompt, {
                    ...(step.model !== undefined ? { model: step.model } : {}),
                    ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
                    ...(step.retries !== undefined ? { retries: step.retries } : {}),
                  })
                  return result.output
                },
              ],
              { ...(step.onFailure !== undefined ? { onFailure: step.onFailure } : {}) },
            )
            stepOutputs.set(step.name, JSON.stringify(results))
            return { ...prev, [step.outputAs ?? step.name]: results }
          }
        }
        if ("race" in step) {
          return async (prev: Record<string, unknown> | undefined) => {
            // 并发起跑，首个成功者的输出胜出（全败抛 WorkflowRaceError）
            const winner = await race(
              step.race.map((tpl) => async () => {
                const result = await agent(resolve(tpl))
                return result.output
              }),
            )
            stepOutputs.set(step.name, winner)
            return { ...prev, [step.outputAs ?? step.name]: winner }
          }
        }
        return async (prev: Record<string, unknown> | undefined) => {
          const target = path.resolve(root, resolve(step.fileExists))
          await assert(() => fileExistsPredicate(target), `${step.name}: ${target} exists in workspace (${root})`)
          return { ...prev, [step.name]: target }
        }
      })

      await ctx.runSteps(built, { stepNames: dw.steps.map((s) => s.name) })

      const output =
        dw.output !== undefined
          ? resolve(dw.output)
          : stepOutputs.get(lastProducerName ?? "") ?? `workflow ${dw.id} completed`
      return { output }
    },
  } satisfies WorkflowDefinition<Record<string, unknown>, { output: string }> as AnyWorkflowDefinition
}

/**
 * 装载入口：读取 + 校验 + 转换。文件级错误收集返回（调用方 warn+跳过），
 * 绝不因单个坏文件中断装载。reservedIds 命中即拒（避免遮蔽内置流程）。
 */
/**
 * 装载代码流程模块（P2-14）：.js/.mjs/.cjs 动态 import，取
 * default / definition / workflow 三种导出形态之一，校验
 * WorkflowDefinition 最小形状（id/version 字符串 + run 函数）。
 * 返回定义或错误文案（含文件名前缀）；不抛出。
 */
async function loadCodeWorkflowModule(
  file: string,
): Promise<{ ok: true; definition: WorkflowDefinition } | { ok: false; error: string }> {
  const at = (msg: string) => `${path.basename(file)}: ${msg}`
  let mod: unknown
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (error) {
    return { ok: false, error: at(`failed to import (${error instanceof Error ? error.message : String(error)})`) }
  }
  if (typeof mod !== "object" || mod === null) {
    return { ok: false, error: at("module must export a workflow (default export or named `definition`)") }
  }
  const candidate = (mod as Record<string, unknown>).default ?? (mod as Record<string, unknown>).definition ?? (mod as Record<string, unknown>).workflow
  if (typeof candidate !== "object" || candidate === null) {
    return {
      ok: false,
      error: at("module must export a workflow (default export or named `definition`): export defineWorkflow({...}) result"),
    }
  }
  const def = candidate as { id?: unknown; version?: unknown; run?: unknown; description?: unknown }
  if (typeof def.id !== "string" || def.id.length === 0) {
    return { ok: false, error: at("workflow.id must be a non-empty string") }
  }
  if (typeof def.version !== "string" || def.version.length === 0) {
    return { ok: false, error: at("workflow.version must be a non-empty string (semver; bump on structure change)") }
  }
  if (typeof def.run !== "function") {
    return { ok: false, error: at("workflow.run must be a function: async run(args, ctx)") }
  }
  return { ok: true, definition: candidate as WorkflowDefinition }
}

/**
 * 装载自定义流程（声明式 JSON + 代码式 JS 模块，P2-14 起统一入口）。
 * 文件级错误 warn+跳过（与装载纪律一致：观测/装载不能成为主链路故障源）。
 */
export async function loadCustomWorkflows(
  entries: string[],
  baseDir: string,
  reservedIds: string[] = [],
): Promise<{ definitions: AnyWorkflowDefinition[]; errors: string[] }> {
  const { files, errors } = await expandEntries(entries, baseDir)
  const definitions: AnyWorkflowDefinition[] = []
  const reserved = new Set(reservedIds)
  const seenIds = new Map<string, string>()
  for (const file of files) {
    if (CODE_EXTENSIONS.some((ext) => file.endsWith(ext))) {
      const loaded = await loadCodeWorkflowModule(file)
      if (!loaded.ok) {
        errors.push(loaded.error)
        continue
      }
      if (reserved.has(loaded.definition.id)) {
        errors.push(`${path.basename(file)}: id "${loaded.definition.id}" is reserved by a built-in workflow`)
        continue
      }
      const key = `${loaded.definition.id}@${loaded.definition.version}`
      const seenIn = seenIds.get(key)
      if (seenIn) {
        errors.push(`${path.basename(file)}: duplicate ${key} (already loaded from ${seenIn})`)
        continue
      }
      seenIds.set(key, path.basename(file))
      definitions.push(loaded.definition)
      continue
    }
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

/** @deprecated 旧名（P2-14 起装载范围扩展到代码流程），等价 loadCustomWorkflows */
export const loadDeclarativeWorkflows = loadCustomWorkflows
