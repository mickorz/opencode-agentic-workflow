/**
 * check / assert —— 确定性验证节点（P1.1）
 *
 * 职责边界：
 *   agent  = 做事（LLM，非确定性）
 *   check  = 确定性验证（谓词求值，可重复）
 *
 * 两个 API：
 *   check(predicate, label)  -> 永不抛错，返回 CheckResult（ok 可能为 false）
 *   assert(predicate, label) -> 失败抛 WorkflowCheckError（fail-fast 基石，
 *                               完整失败语义在 P1.3 定义）
 */

export interface CheckResult {
  /** 本次检查的说明，例如 "tests must pass" */
  label: string
  ok: boolean
  /** 失败原因（谓词抛错时为错误信息；成功时通常为空） */
  detail?: string
}

import { WorkflowError } from "../runtime/errors.js"
import { emitEvent } from "../observability/events.js"

/** assert 失败时抛出的错误，携带完整 CheckResult 供上层失败策略消费 */
export class WorkflowCheckError extends WorkflowError {
  readonly result: CheckResult

  constructor(result: CheckResult) {
    super(
      `[workflow] check failed: ${result.label}` +
        (result.detail ? ` (${result.detail})` : ""),
    )
    this.name = "WorkflowCheckError"
    this.result = result
  }
}

export type CheckPredicate = () => boolean | Promise<boolean>

/** 求值谓词：抛错视为不通过，异常信息进入 detail */
export async function check(
  predicate: CheckPredicate,
  label: string,
): Promise<CheckResult> {
  let ok = false
  let detail: string | undefined
  try {
    ok = (await predicate()) === true
  } catch (error) {
    ok = false
    detail = error instanceof Error ? error.message : String(error)
  }
  const result: CheckResult = { label, ok }
  if (!ok && detail) result.detail = detail
  console.log(`[agentic-workflow] check ${ok ? "ok" : "FAIL"}: ${label}`)
  emitEvent({ type: "check.completed", label, ok })
  return result
}

/** check 的严格版：失败抛 WorkflowCheckError，成功原样返回 CheckResult */
export async function assert(
  predicate: CheckPredicate,
  label: string,
): Promise<CheckResult> {
  const result = await check(predicate, label)
  if (!result.ok) {
    throw new WorkflowCheckError(result)
  }
  return result
}
