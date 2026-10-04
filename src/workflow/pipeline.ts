/**
 * pipeline() —— 多条目 × 多阶段流水线（P1-5，v1-parity）
 *
 * items 并发流经同一组 stages（顺序执行）：每个条目 value = stage(value, original, index)，
 * 阶段间串联、条目间互不干扰（单条目失败不拖垮其他条目——由 onFailure 决定收口方式）。
 *
 * onFailure（与 sequence 同语义）：
 *   "fail-fast"（默认）：第一个失败条目即抛 WorkflowPipelineError，其余条目不再影响结果
 *                        （已附加吞错处理，不产生 unhandled rejection）。
 *   "continue"        ：跑完全部条目；存在失败则最后抛 WorkflowPipelineError（聚合全部失败）。
 *
 * 空条目数组返回 []；空 stages 返回原条目（v1 同语义）。
 * 并发不在此限流——实际 LLM 并发由 executor 层信号量统一约束。
 */

import { WorkflowPipelineError } from "../runtime/errors.js"

export interface PipelineOptions {
  /** 失败模式，默认 "fail-fast" */
  onFailure?: "fail-fast" | "continue"
}

/** 阶段函数：入参（当前值, 原始条目, 条目下标），返回下一阶段值 */
export type PipelineStage<T> = (value: T, original: T, index: number) => Promise<T> | T

export async function pipeline<T>(
  items: T[],
  stages: Array<PipelineStage<T>>,
  options?: PipelineOptions,
): Promise<T[]> {
  const onFailure = options?.onFailure ?? "fail-fast"
  if (items.length === 0) return []
  if (stages.length === 0) return [...items]

  const runItem = async (item: T, index: number): Promise<T> => {
    let value = item
    for (const stage of stages) {
      value = await stage(value, item, index)
    }
    return value
  }

  if (onFailure === "fail-fast") {
    return new Promise<T[]>((resolve, reject) => {
      const results: Array<T | undefined> = new Array(items.length).fill(undefined)
      let rejected = false
      let pending = items.length

      items.forEach((item, index) => {
        Promise.resolve()
          .then(() => runItem(item, index))
          .then((value) => {
            if (rejected) return
            results[index] = value
            pending -= 1
            if (pending === 0) resolve(results as T[])
          })
          .catch((cause: unknown) => {
            if (rejected) return // 已失败：吞掉后续错误，避免 unhandled rejection
            rejected = true
            reject(new WorkflowPipelineError([{ index, error: cause }], results, "fail-fast"))
          })
      })
    })
  }

  // continue：等全部条目落定，存在失败则聚合抛出
  const settled = await Promise.allSettled(items.map((item, index) => runItem(item, index)))
  const results: Array<T | undefined> = new Array(items.length).fill(undefined)
  const failures: Array<{ index: number; error: unknown }> = []
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      results[index] = outcome.value
    } else {
      failures.push({ index, error: outcome.reason })
    }
  })
  if (failures.length > 0) {
    throw new WorkflowPipelineError(failures, results, "continue")
  }
  return results as T[]
}
