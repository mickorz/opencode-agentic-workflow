/**
 * agent() —— 提交单个子 agent 任务
 *
 * 不感知 ctx / OpenCode：只经由 requireExecutor() 拿到当前绑定的
 * AgentExecutor 并执行。P2.4 起派发 agent.started / completed / failed 事件。
 *
 * P1-4 调用级选项（v1 parity）：
 *   - model：覆盖本次调用的子会话模型（"providerID/modelId" 或对象），
 *     经 AgentTask.model 透传，executor 以 task.model 优先于构造期默认
 *   - timeoutMs：单次尝试超时（Promise.race，超时抛 AgentTimeoutError）；
 *     超时不会中断底层会话（无 AbortSignal 注入点），只是不再等待——
 *     与 run 控制的协作式停止同一诚实语义
 *   - retries / retryDelayMs：失败重试（对超时同样生效——每次尝试独立计时）
 *
 * 纪律：事件保持调用级一对 started/completed|failed（不按尝试拆分）。
 */

import type { AgentResult } from "../runtime/executor.js"
import { requireExecutor } from "../runtime/engine.js"
import { currentRunContext } from "../runtime/run-context.js"
import { emitEvent, preview } from "../observability/events.js"
import { currentWorkspace } from "../workspace/ambient.js"
import { validateArgs, type ArgsSchema } from "../registry/schema.js"

export interface AgentCallOptions {
  /** 覆盖本次调用的模型："providerID/modelId"（或对象形式，含 variant） */
  model?: string | { providerID: string; id: string; variant?: string }
  /** 单次尝试超时（ms）；超时抛 AgentTimeoutError */
  timeoutMs?: number
  /** 失败重试次数（0 = 不重试；对超时同样生效） */
  retries?: number
  /** 重试间隔 ms（默认 0） */
  retryDelayMs?: number
  /**
   * P1-6 结构化输出 shim：要求子 agent 按 JSON Schema 返回 JSON 值，
   * 输出经解析 + validateArgs 校验后挂到 result.structured。
   * 注意：OpenCode v2 会话 API 无原生结构化输出（PromptInput.Prompt 2.0.22
   * 仅 text/files/agents/skills，无 v1 的 format 字段）——本 shim 靠
   * prompt 指令 + 校验 + 失败可重试（retries）保证可靠性，非宿主级约束。
   */
  schema?: ArgsSchema
}

/** 结构化输出解析/校验失败（配合 retries 可重试） */
export class AgentSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentSchemaError"
  }
}

/** 从子 agent 文本输出提取 JSON 值：直接解析，失败则截取首个 { 到最后一个 } */
function extractJson(output: string): unknown {
  const text = output.trim()
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1))
    }
    throw new AgentSchemaError(
      `agent output is not valid JSON: "${text.slice(0, 80)}"`,
    )
  }
}

/** 单次尝试超时（步骤级失败、journal 可见；底层会话不被硬杀） */
export class AgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`agent call timed out after ${timeoutMs}ms`)
    this.name = "AgentTimeoutError"
  }
}

function parseModelRef(model: NonNullable<AgentCallOptions["model"]>): {
  providerID: string
  id: string
  variant?: string
} {
  if (typeof model !== "string") return model
  const sep = model.indexOf("/")
  if (sep <= 0 || sep === model.length - 1) {
    throw new Error(
      `[agentic-workflow] invalid model "${model}": expected "providerID/modelId"`,
    )
  }
  return { providerID: model.slice(0, sep), id: model.slice(sep + 1) }
}

async function withTimeout<T>(run: () => Promise<T>, timeoutMs?: number): Promise<T> {
  if (timeoutMs === undefined) return run()
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AgentTimeoutError(timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function withRetries<T>(run: () => Promise<T>, retries: number, delayMs: number): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    try {
      return await run()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export async function agent(prompt: string, options: AgentCallOptions = {}): Promise<AgentResult> {
  const workspace = currentWorkspace()
  // P1-6 结构化输出 shim：schema 存在时给 prompt 追加 JSON 指令，
  // 输出经解析 + validateArgs 校验后挂到 result.structured
  const effectivePrompt =
    options.schema === undefined
      ? prompt
      : prompt +
        "\n\nRespond with ONLY a JSON value matching this schema - no markdown fences, no commentary:\n" +
        JSON.stringify(options.schema)
  const task = {
    prompt: effectivePrompt,
    ...(options.model !== undefined ? { model: parseModelRef(options.model) } : {}),
    ...(workspace ? { cwd: workspace.root } : {}),
  }
  const retries = options.retries ?? 0
  const retryDelayMs = options.retryDelayMs ?? 0

  // runId 标注（P2-8b）：run 作用域内的调用可被 journal 侧聚合到 currentStep；
  // 作用域外（inline 无 journal 等）省略
  const runId = currentRunContext()?.runId

  emitEvent({ type: "agent.started", promptPreview: preview(prompt), ...(runId ? { runId } : {}) })
  const startedAt = Date.now()
  try {
    const result = await withRetries(
      () =>
        withTimeout(async () => {
          const executed = await requireExecutor().execute(task)
          // P1-6：解析+校验放进重试环内——违规输出与执行失败同等可重试
          if (options.schema !== undefined) {
            const parsed = extractJson(executed.output)
            const violations = validateArgs(options.schema, parsed)
            if (violations.length > 0) {
              throw new AgentSchemaError(
                `agent output does not match schema: ${violations.join("; ")}`,
              )
            }
            executed.structured = parsed
          }
          return executed
        }, options.timeoutMs),
      retries,
      retryDelayMs,
    )
    emitEvent({
      type: "agent.completed",
      durationMs: Date.now() - startedAt,
      outputLength: result.output.length,
      usage: result.usage,
      costUSD: result.costUSD,
      model: result.model,
      ...(runId ? { runId } : {}),
    })
    return result
  } catch (error) {
    emitEvent({
      type: "agent.failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      ...(runId ? { runId } : {}),
    })
    throw error
  }
}
