/**
 * agent() —— 提交单个子 agent 任务
 *
 * 不感知 ctx / OpenCode：只经由 requireExecutor() 拿到当前绑定的
 * AgentExecutor 并执行。P2.4 起派发 agent.started / completed / failed 事件。
 */

import type { AgentResult } from "../runtime/executor.js"
import { requireExecutor } from "../runtime/engine.js"
import { emitEvent, preview } from "../observability/events.js"

export async function agent(prompt: string): Promise<AgentResult> {
  emitEvent({ type: "agent.started", promptPreview: preview(prompt) })
  const startedAt = Date.now()
  try {
    const result = await requireExecutor().execute({ prompt })
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
