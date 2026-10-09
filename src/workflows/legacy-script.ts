/**
 * v1 脚本适配层 —— opencode-dynamic-workflows（v1）脚本体在 v2 原生运行
 *
 * v0.8.0 产品决策：v1 脚本（`export const meta = {...}` + 魔法全局
 * `phase/agent/parallel/...` + 顶层 `return`）不改写、不迁移，flows 目录
 * 内与 .mjs 流程同权装载。
 *
 * 形态识别：源码含 `export const meta =` 且不含 `defineWorkflow`。
 * 装载：剥离 meta 语句 → 包裹为 `export default async function (...globals)`
 * 模块（顶层 return/await 因此合法）→ 走既有临时文件 import 机制。
 * 运行：definition.run 绑定 19 个 v1 全局到 v2 原语，语义对位：
 *   - agent() → core agent()，journal 记一步；返回 .output（schema 时 .structured）
 *   - 可恢复失败（agent 超时/schema、check 未通过）在 parallel/pipeline/
 *     sequence 中塌缩为 null（v1 语义）；结构性错误上抛
 *   - checkpoint() 返回 boolean（拒绝=false 不抛）；无 gate 时回落 {default}
 *   - verify/judgePanel：v1 实现原味移植（构建于 agent+parallel 之上）
 *   - fileExists 同步（v1 语义，相对 workspaceRoot/cwd）；commandSuccess 异步
 *   - setConcurrency()：v2 并发由 executor 统一管理——响亮警告 + 不生效
 *   - phase() → core phase()（日志 + 事件；v2 TUI 无阶段分组，步骤行=叶子调用）
 *
 * journal 语义：步骤不预声明（stepNames 缺省），叶子调用（agent/checkpoint/
 * subflow）经 recorder.appendStep 动态记录——与 v1 树的可见节点粒度一致。
 * resume = 整体重跑（无步骤前缀跳过；v1 脚本无静态步骤序）。
 *
 * 纪律：禁止 import OpenCode API（架构不变量，同 loader）。
 */

import { exec } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

import type { WorkflowDefinition, WorkflowContext } from "../registry/definition.js"
import type { RunJournal } from "../state/recorder.js"
import { agent as coreAgent, AgentTimeoutError, AgentSchemaError, type AgentCallOptions } from "../workflow/agent.js"
import { fallback as coreFallback } from "../workflow/fallback.js"
import { race as coreRace } from "../workflow/race.js"
import { phase as corePhase } from "../workflow/phase.js"
import {
  checkpoint as coreCheckpoint,
  getCheckpointGate,
  WorkflowCheckpointError,
} from "../quality/checkpoint.js"

/** v1 全局注入参数表（顺序即包裹函数形参序） */
export const LEGACY_GLOBAL_PARAMS = [
  "phase",
  "agent",
  "parallel",
  "pipeline",
  "sequence",
  "fallback",
  "race",
  "check",
  "fileExists",
  "commandSuccess",
  "log",
  "args",
  "setConcurrency",
  "verify",
  "judgePanel",
  "retry",
  "checkpoint",
  "workflow",
  "console",
] as const

/** v1 脚本形态识别：含 export const meta 且不含 defineWorkflow */
export function detectLegacyScript(source: string): boolean {
  return (
    !source.includes("defineWorkflow") &&
    /(?:^|[\n;])\s*export\s+const\s+meta\s*=/.test(source)
  )
}

/**
 * 剥离 `export const meta = {...}` 语句（字符串感知配平）。
 * 返回 meta 语句原文（保留 export，随包裹模块再导出）与剩余 body。
 */
export function splitLegacyMeta(
  source: string,
): { ok: true; metaStatement: string; rest: string } | { ok: false; error: string } {
  const match = /export\s+const\s+meta\s*=/.exec(source)
  if (match === null) {
    return { ok: false, error: "legacy script must start with `export const meta = { ... }`" }
  }
  let i = match.index + match[0].length
  while (i < source.length && /\s/.test(source[i]!)) i++
  if (source[i] !== "{") {
    return { ok: false, error: "`export const meta` must be an object literal ({ ... })" }
  }
  // 字符串感知的花括号配平
  let depth = 0
  let quote: string | null = null
  let j = i
  for (; j < source.length; j++) {
    const ch = source[j]!
    if (quote !== null) {
      if (ch === "\\") {
        j++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      continue
    }
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        j++
        break
      }
    }
  }
  if (depth !== 0 || quote !== null) {
    return { ok: false, error: "unbalanced braces in `export const meta` literal" }
  }
  let end = j
  if (source[end] === ";") end++
  return {
    ok: true,
    metaStatement: source.slice(match.index, end),
    rest: source.slice(0, match.index) + source.slice(end),
  }
}

/**
 * 构建可 import 的包裹模块：meta 原文再导出 + body 作为带全局形参的
 * async 函数默认导出（顶层 return/await 因此合法）。
 */
export function wrapLegacyModule(
  metaStatement: string,
  rest: string,
): { ok: true; wrapped: string } | { ok: false; error: string } {
  if (/(?:^|\n)\s*import\s*[^(]/.test(rest)) {
    return {
      ok: false,
      error: "legacy scripts cannot use static import statements (globals are injected); convert to a v2 .mjs flow if you need imports",
    }
  }
  if (/(?:^|\n)\s*export\b/.test(rest)) {
    return {
      ok: false,
      error: "legacy scripts may only contain `export const meta` (other exports are not supported)",
    }
  }
  const body = `export default async function (${LEGACY_GLOBAL_PARAMS.join(", ")}) {\n${rest}\n}\n`
  return { ok: true, wrapped: `${metaStatement}\n${body}` }
}

/** v1 meta 形状（name 必填 snake_case；description 可选） */
export interface LegacyMeta {
  name: string
  description?: string
  phases?: unknown
}

/** 装载期 meta 校验（v1 validateMeta 对位；shape 宽松、fail-loud） */
export function validateLegacyMeta(meta: unknown): { ok: true; meta: LegacyMeta } | { ok: false; error: string } {
  if (typeof meta !== "object" || meta === null) {
    return { ok: false, error: "`export const meta` must evaluate to an object" }
  }
  const name = (meta as { name?: unknown }).name
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]*$/i.test(name)) {
    return { ok: false, error: "meta.name must be a non-empty snake_case string" }
  }
  const description = (meta as { description?: unknown }).description
  if (description !== undefined && typeof description !== "string") {
    return { ok: false, error: "meta.description must be a string" }
  }
  return { ok: true, meta: { name, ...(description !== undefined ? { description } : {}) } }
}

/** check() 未通过（可恢复：parallel/pipeline 塌缩 null、sequence 停止返 null） */
class LegacyCheckError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LegacyCheckError"
  }
}

function isRecoverableFailure(error: unknown): boolean {
  return (
    error instanceof AgentTimeoutError ||
    error instanceof AgentSchemaError ||
    error instanceof LegacyCheckError
  )
}

/** journal 步骤 input 预览（截断，避免大 prompt 落盘膨胀） */
function previewText(value: unknown, max = 160): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  return text.length > max ? text.slice(0, max) + "…" : text
}

/** 叶子调用统一 journal：动态追加步骤 + 完成/失败收口 */
async function journaledStep<T>(
  journal: RunJournal | undefined,
  name: string,
  input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  if (journal === undefined) return fn()
  const index = await journal.appendStep(name, previewText(input))
  try {
    const value = await fn()
    await journal.stepCompleted(index, previewText(value))
    return value
  } catch (error) {
    await journal.stepFailed(index, error)
    throw error
  }
}

/** v1 agent 选项（label 为 journal/树标签；其余透传 v2 core agent） */
interface LegacyAgentOptions extends AgentCallOptions {
  label?: string
}

/** v1 verify 的对抗评审返回（脚本消费 verdict.real / verdict.realCount） */
interface LegacyVerifyResult {
  real: boolean
  realCount: number
  total: number
  votes: Array<{ real?: boolean; reason?: string }>
}

/** v1 judgePanel 胜出者（best.index / best.score / best.attempt） */
interface LegacyJudged {
  index: number
  attempt: unknown
  score: number
  judgments: Array<{ score?: number; reason?: string }>
}

const VERIFY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { real: { type: "boolean" }, reason: { type: "string" } },
  required: ["real"],
}

const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { score: { type: "number" }, reason: { type: "string" } },
  required: ["score"],
}

function normalizeFanout(value: unknown, fallback: number, optionName: string): number {
  const count = value === undefined ? fallback : value
  if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count < 1) {
    throw new TypeError(`${optionName} 必须是大于等于 1 的整数`)
  }
  return count
}

/**
 * 构造 v1 脚本的 WorkflowDefinition：run() 绑定全部全局并执行 body。
 * 步骤动态 journal（叶子粒度）；resume = 整体重跑（无静态步骤序）。
 */
export function buildLegacyDefinition(
  meta: LegacyMeta,
  bodyFn: (...globals: unknown[]) => Promise<unknown>,
): WorkflowDefinition {
  return {
    id: meta.name,
    version: "1.0.0",
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    argsSchema: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
    async run(args: Record<string, unknown>, ctx: WorkflowContext) {
      const journal = ctx.journal
      const workspaceRoot = ctx.workspaceRoot ?? process.cwd()
      let agentCount = 0

      const log = (...values: unknown[]) => {
        console.log(`[agentic-workflow] ${values.map((v) => (typeof v === "string" ? v : JSON.stringify(v) ?? String(v))).join(" ")}`)
      }

      const agent = (prompt: string, opts?: LegacyAgentOptions): Promise<unknown> => {
        if (typeof prompt !== "string" || prompt.length === 0) {
          throw new TypeError("agent(prompt, opts?) 需要非空提示词")
        }
        const label = opts?.label ?? `agent-${++agentCount}`
        const passThrough: AgentCallOptions = {}
        for (const key of ["model", "timeoutMs", "retries", "retryDelayMs", "schema"] as const) {
          const value = opts?.[key]
          if (value !== undefined) (passThrough as Record<string, unknown>)[key] = value
        }
        return journaledStep(journal, label, prompt, async () => {
          const result = await coreAgent(prompt, passThrough)
          return opts?.schema !== undefined ? result.structured : result.output
        })
      }

      const parallel = async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> => {
        if (!Array.isArray(thunks)) {
          throw new TypeError("parallel() 期望函数数组")
        }
        if (thunks.some((t) => typeof t !== "function")) {
          throw new TypeError("parallel() 期望函数数组而非 Promise 数组，请用 () => agent(...) 包裹")
        }
        const settled = await Promise.all(
          thunks.map(async (thunk) => {
            try {
              return { ok: true as const, value: await thunk() }
            } catch (error) {
              return { ok: false as const, error }
            }
          }),
        )
        for (const item of settled) {
          if (!item.ok && !isRecoverableFailure(item.error)) throw item.error
        }
        return settled.map((item) => (item.ok ? item.value : null))
      }

      const pipeline = async (
        items: unknown[],
        stages: Array<(value: unknown, original: unknown, index: number) => Promise<unknown> | unknown>,
      ): Promise<unknown[]> => {
        if (!Array.isArray(items)) throw new TypeError("pipeline() 期望条目数组")
        if (!Array.isArray(stages) || stages.length === 0) return [...items]
        const settled = await Promise.all(
          items.map(async (item, index) => {
            let value = item
            try {
              for (const stage of stages) {
                value = await stage(value, item, index)
              }
              return { ok: true as const, value }
            } catch (error) {
              return { ok: false as const, error }
            }
          }),
        )
        for (const item of settled) {
          if (!item.ok && !isRecoverableFailure(item.error)) throw item.error
        }
        return settled.map((item) => (item.ok ? item.value : null))
      }

      const sequence = async (nodes: Array<(prev?: unknown) => Promise<unknown>>): Promise<unknown> => {
        if (!Array.isArray(nodes)) throw new TypeError("sequence() 期望节点函数数组")
        let value: unknown
        for (const [index, node] of nodes.entries()) {
          try {
            value = await node(value)
          } catch (error) {
            if (isRecoverableFailure(error)) {
              const message = error instanceof Error ? error.message : String(error)
              log(`sequence[${index}] 失败，序列停止: ${message}`)
              return null
            }
            throw error
          }
        }
        return value
      }

      const fallback = (candidates: Array<() => Promise<unknown>>): Promise<unknown> => {
        if (!Array.isArray(candidates) || candidates.length === 0) {
          throw new TypeError("fallback() 期望非空候选函数数组")
        }
        return coreFallback(candidates)
      }

      const race = (branches: Array<() => Promise<unknown>>): Promise<unknown> => {
        if (!Array.isArray(branches) || branches.length === 0) {
          throw new TypeError("race() 期望至少一个分支")
        }
        return coreRace(branches)
      }

      const check = async (
        condition: () => boolean | Promise<boolean>,
        message?: string,
      ): Promise<boolean> => {
        if (typeof condition !== "function") {
          throw new TypeError("check(condition, message?) 需要函数条件")
        }
        let passed: boolean
        try {
          passed = await condition()
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          throw new TypeError(`check 条件执行出错（不是验证未通过，是检查代码出错）：${reason}`)
        }
        if (passed === true) return true
        throw new LegacyCheckError(message ?? "check 验证未通过")
      }

      /** 同步（v1 语义）：相对 workspaceRoot/cwd 的存在性 */
      const fileExists = (target: string): boolean => {
        if (typeof target !== "string" || target.trim().length === 0) return false
        return existsSync(path.resolve(workspaceRoot, target))
      }

      /** 命令退出码 0（异步；超时视为失败）——v1 语义 */
      const commandSuccess = (command: string, timeoutMs = 30_000): Promise<boolean> => {
        return new Promise((resolve) => {
          if (typeof command !== "string" || command.trim().length === 0) {
            resolve(false)
            return
          }
          exec(
            command,
            { cwd: workspaceRoot, timeout: timeoutMs, windowsHide: true },
            (error) => resolve(error === null || error === undefined),
          )
        })
      }

      const setConcurrency = (value: number): void => {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
          throw new TypeError(`setConcurrency 需要正整数，收到 ${String(value)}`)
        }
        console.warn(
          `[agentic-workflow] setConcurrency(${value}) is ignored: v2 executor concurrency is managed globally (legacy adapter)`,
        )
      }

      /** 对抗式评审（v1 原味移植；每个 reviewer 一个 journal 步骤） */
      const verify = async (
        item: unknown,
        opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
      ): Promise<LegacyVerifyResult> => {
        const reviewerSlots = normalizeFanout(opts.reviewers, 2, "verify() reviewers")
        const threshold = opts.threshold ?? 0.5
        const lenses = opts.lens !== undefined ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : []
        const claim = typeof item === "string" ? item : JSON.stringify(item) ?? String(item)
        const votes = (await parallel(
          Array.from({ length: reviewerSlots }, (_v, i) => () =>
            agent(
              `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length > 0 ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
              { label: `verify ${i + 1}`, schema: VERIFY_SCHEMA },
            ),
          ),
        )) as Array<LegacyVerifyResult["votes"][number] | null>
        const valid = votes.filter((v): v is LegacyVerifyResult["votes"][number] => v != null)
        const realCount = valid.filter((v) => v?.real === true).length
        return {
          real: valid.length > 0 && realCount / valid.length >= threshold,
          realCount,
          total: valid.length,
          votes: valid,
        }
      }

      /** 评审团（v1 原味移植；judge 打分经 agent journal 步骤可见） */
      const judgePanel = async (
        attempts: unknown[],
        opts: { judges?: number; rubric?: string } = {},
      ): Promise<LegacyJudged> => {
        const judgeSlots = normalizeFanout(opts.judges, 3, "judgePanel() judges")
        const candidates = Array.isArray(attempts)
          ? attempts.map((attempt, index) => ({ attempt, index })).filter((c) => c.attempt != null)
          : []
        if (candidates.length === 0) throw new TypeError("judgePanel() 需要非空候选数组")
        const rubric = opts.rubric ?? "overall quality and correctness"
        const scored = (await parallel(
          candidates.map(({ attempt, index }) => async () => {
            const text = typeof attempt === "string" ? attempt : JSON.stringify(attempt) ?? String(attempt)
            const judgments = (await parallel(
              Array.from({ length: judgeSlots }, (_v, j) => () =>
                agent(
                  `Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`,
                  { label: `judge ${index + 1}.${j + 1}`, schema: JUDGE_SCHEMA },
                ),
              ),
            )) as Array<{ score?: number } | null>
            const valid = judgments.filter((j): j is { score?: number } => j != null)
            const score =
              valid.length > 0
                ? valid.reduce((sum, v) => sum + (Number(v?.score) || 0), 0) / valid.length
                : 0
            return { index, attempt, score, judgments: valid }
          }),
        )) as Array<LegacyJudged | null>
        const valid = scored.filter((s): s is LegacyJudged => s != null)
        if (valid.length === 0) throw new TypeError("judgePanel() 全部候选评审失败")
        // 最高均分；同分稳定取输入顺序靠前者（v1 同款）
        let best = valid[0]!
        for (const s of valid) {
          if (s.score > best.score || (s.score === best.score && s.index < best.index)) best = s
        }
        return best
      }

      /** 有界重试糖：直到 until 通过或耗尽，返回最后一次结果（不抛错）——v1 语义 */
      const retry = async (
        thunk: (attempt: number) => Promise<unknown> | unknown,
        opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
      ): Promise<unknown> => {
        const attempts = Math.max(1, opts.attempts ?? 3)
        let last: unknown
        for (let i = 0; i < attempts; i++) {
          last = await thunk(i)
          if (opts.until?.(last) === true) return last
        }
        return last
      }

      /** 人工审批：批准=true / 拒绝=false（不抛）；无 gate 时回落 default —— v1 语义 */
      const checkpoint = async (
        message: string,
        opts: { label?: string; default?: boolean } = {},
      ): Promise<boolean> => {
        const label = opts.label ?? "checkpoint"
        return journaledStep(journal, `checkpoint:${label}`, message, async () => {
          if (getCheckpointGate() === undefined) {
            if (opts.default !== undefined) {
              log(`checkpoint(${label}) 无交互 gate，回落 default=${String(opts.default)}`)
              return opts.default
            }
            throw new Error(
              `checkpoint(${label}) 需要交互 gate 或 { default } 选项（headless 场景请传 default）`,
            )
          }
          try {
            await coreCheckpoint(message, { label })
            return true
          } catch (error) {
            if (error instanceof WorkflowCheckpointError) return false
            throw error
          }
        })
      }

      /** 子工作流（v1 workflow 全局 → ctx.subflow；需要 journalDir） */
      const workflow = async (
        id: string,
        subArgs?: unknown,
      ): Promise<{ runId: string; output: string }> => {
        if (ctx.subflow === undefined) {
          throw new Error(
            `workflow(${id}) 子流程需要 journalDir（ExecutionStore）；未配置的 run 不提供 subflow`,
          )
        }
        return journaledStep(journal, `subflow:${id}`, subArgs, () => ctx.subflow!(id, subArgs))
      }

      const consoleShim = {
        log,
        info: log,
        warn: (m: unknown) => log(`[warn] ${typeof m === "string" ? m : JSON.stringify(m) ?? String(m)}`),
        error: (m: unknown) => log(`[error] ${typeof m === "string" ? m : JSON.stringify(m) ?? String(m)}`),
      }

      const globals: unknown[] = [
        corePhase,
        agent,
        parallel,
        pipeline,
        sequence,
        fallback,
        race,
        check,
        fileExists,
        commandSuccess,
        log,
        args,
        setConcurrency,
        verify,
        judgePanel,
        retry,
        checkpoint,
        workflow,
        consoleShim,
      ]

      const result = await bodyFn(...globals)
      return result as never
    },
  }
}
