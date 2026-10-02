/**
 * observeWorkflow —— workflow 级事件包装器（P2.4）
 *
 * 包住任意 async workflow 函数，派发 workflow.started / completed / failed。
 * 嵌套调用会产生嵌套事件流（P2 单 workflow 场景不依赖强制去重）。
 */

import { emitEvent } from "./events.js"

export async function observeWorkflow<T>(
  workflowId: string,
  fn: () => Promise<T>,
  args?: Record<string, unknown>,
): Promise<T> {
  emitEvent({ type: "workflow.started", workflowId, args })
  const startedAt = Date.now()
  try {
    const result = await fn()
    emitEvent({
      type: "workflow.completed",
      workflowId,
      durationMs: Date.now() - startedAt,
    })
    return result
  } catch (error) {
    emitEvent({
      type: "workflow.failed",
      workflowId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
