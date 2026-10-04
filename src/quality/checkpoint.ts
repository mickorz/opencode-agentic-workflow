/**
 * checkpoint —— Human-in-the-loop 审批节点（P1.5）
 *
 * 执行语义（本文件负责证明的部分）：
 *   workflow 执行到 checkpoint(message) 时阻塞，等待人工批准：
 *     approved=true  -> 继续（返回 undefined，可参与 sequence 传值）
 *     approved=false -> 抛 WorkflowCheckpointError，链路中断
 *
 * 宿主交互抽象：CheckpointGate。Core 不知道「人工」在哪里：
 *   - PolicyCheckpointGate（plugin 层）：按策略自动批准/拒绝（P1 headless 验收用）
 *   - P2：交互式门（TUI dialog / 权限请求），经 setCheckpointGate 注入同一抽象
 */

import { WorkflowError } from "../runtime/errors.js"
import { emitEvent } from "../observability/events.js"
import { phase } from "../workflow/phase.js"
import { currentRunContext } from "../runtime/run-context.js"

export interface CheckpointRequest {
  label: string
  message: string
}

export interface CheckpointDecision {
  approved: boolean
  /** 拒绝原因（可选，进入错误信息） */
  reason?: string
}

export interface CheckpointGate {
  ask(request: CheckpointRequest): Promise<CheckpointDecision>
}

/** checkpoint 被拒绝（或按策略判定不通过）时抛出 */
export class WorkflowCheckpointError extends WorkflowError {
  readonly label: string
  readonly reason?: string

  constructor(label: string, reason?: string) {
    super(
      `checkpoint rejected: ${label}` + (reason ? ` (${reason})` : ""),
    )
    this.name = "WorkflowCheckpointError"
    this.label = label
    this.reason = reason
  }
}

export interface CheckpointOptions {
  /** 节点标签，默认 "checkpoint" */
  label?: string
}

/** ---- gate 注册（P2-9 起支持 run 级覆盖，ALS 优先） ---- */

let gate: CheckpointGate | undefined

/** 注入全局 CheckpointGate（plugin 初始化时调用；传 undefined 表示解除绑定） */
export function setCheckpointGate(value: CheckpointGate | undefined): void {
  gate = value
}

/**
 * 当前生效的 gate：run 上下文（subflow/scheduler/调用级覆盖）优先，
 * 回落全局绑定。嵌套 run 未显式覆盖时继承父作用域。
 */
export function getCheckpointGate(): CheckpointGate | undefined {
  return currentRunContext()?.gate ?? gate
}

/** 获取当前 gate；未注入时抛错 */
export function requireCheckpointGate(): CheckpointGate {
  const current = getCheckpointGate()
  if (!current) {
    throw new Error(
      "[agentic-workflow] no checkpoint gate bound: call setCheckpointGate() first",
    )
  }
  return current
}

/**
 * 人工审批节点：阻塞等待批准；拒绝抛 WorkflowCheckpointError。
 * 批准时返回 undefined，不改变 sequence 的传值流。
 */
export async function checkpoint(
  message: string,
  options?: CheckpointOptions,
): Promise<void> {
  const label = options?.label ?? "checkpoint"
  phase(`Checkpoint(${label})`)

  emitEvent({ type: "checkpoint.waiting", label, message })

  const decision = await requireCheckpointGate().ask({ label, message })

  console.log(
    `[agentic-workflow] checkpoint ${label}: ${decision.approved ? "approved" : "rejected"}`,
  )

  emitEvent({ type: "checkpoint.completed", label, approved: decision.approved })

  if (!decision.approved) {
    throw new WorkflowCheckpointError(label, decision.reason)
  }
}
