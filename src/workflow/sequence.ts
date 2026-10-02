/**
 * sequence() —— 顺序执行步骤，上一步结果作为下一步入参（P1.3 失败语义）
 *
 * onFailure 两种模式：
 *   "fail-fast"（默认）：第一个失败步骤抛 WorkflowSequenceError，剩余步骤不再执行。
 *   "continue"        ：失败步骤被记录，后续步骤仍执行（prev = 最后一次成功值），
 *                       全部执行完后若存在失败，仍抛 WorkflowSequenceError（累积全部错误）。
 *
 * 两种模式下 sequence() 的 rejection 都是 WorkflowSequenceError（区别只是错误条数）。
 */

import {
  WorkflowSequenceError,
  WorkflowStepError,
} from "../runtime/errors.js"

export interface SequenceOptions {
  /** 失败模式，默认 "fail-fast" */
  onFailure?: "fail-fast" | "continue"
  /** 步骤名（用于错误定位），可选 */
  stepNames?: string[]
}

export async function sequence<T>(
  steps: Array<(prev?: T) => Promise<T>>,
  options?: SequenceOptions,
): Promise<T | undefined> {
  const onFailure = options?.onFailure ?? "fail-fast"
  const errors: WorkflowStepError[] = []
  let result: T | undefined

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (!step) continue
    try {
      result = await step(result)
    } catch (cause) {
      const stepError = new WorkflowStepError(i, cause, options?.stepNames?.[i])
      if (onFailure === "fail-fast") {
        throw new WorkflowSequenceError([stepError], result)
      }
      errors.push(stepError)
      // continue 模式：result 保持为最后一次成功值
    }
  }

  if (errors.length > 0) {
    throw new WorkflowSequenceError(errors, result)
  }
  return result
}
