/**
 * phase() —— 标记当前工作流阶段
 *
 * P0: metadata + log；P2.4 起升级为事件源（phase.started 派发到事件总线），
 * TUI / metrics / trace / journal 均可消费。
 */

import { emitEvent } from "../observability/events.js"

export function phase(name: string): void {
  console.log(`[agentic-workflow] phase: ${name}`)
  emitEvent({ type: "phase.started", name })
}
