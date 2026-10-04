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
import { emitEvent, preview } from "../observability/events.js"
import { currentWorkspace } from "../workspace/ambient.js"

export interface AgentCallOptions {
  /** 覆盖本次调用的模型："providerID/modelId"（或对象形式，含 variant） */
  model?: string | { providerID: string; id: string; variant?: string }
  /** 单次尝试超时（ms）；超时抛 AgentTimeoutError */
  timeoutMs?: number
  /** 失败重试次数（0 = 不重试；对超时同样生效） */
  retries?: number
  /** 重试间隔 ms（默认 0） */
  retryDelayMs?: number
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
  const task = {
    prompt,
    ...(options.model !== undefined ? { model: parseModelRef(options.model) } : {}),
    ...(workspace ? { cwd: workspace.root } : {}),
  }
  const retries = options.retries ?? 0
  const retryDelayMs = options.retryDelayMs ?? 0

  emitEvent({ type: "agent.started", promptPreview: preview(prompt) })
  const startedAt = Date.now()
  try {
    const result = await withRetries(
      () => withTimeout(() => requireExecutor().execute(task), options.timeoutMs),
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
    })
    return result
  } catch (error) {
    emitEvent({
      type: "agent.failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
