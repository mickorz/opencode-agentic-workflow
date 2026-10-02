/**
 * parallel() —— 并行执行多个任务（P1.3 失败语义）
 *
 * onFailure 三种模式：
 *   "fail-fast"（默认）：第一个失败即抛 WorkflowParallelError；
 *                        其余任务不再影响结果（已附加吞错处理，不会产生 unhandled rejection）。
 *   "collect"          ：等全部任务落定；任一失败则抛错，携带全部失败与成功结果（完整可观测）。
 *   "partial"          ：等全部任务落定；返回结果数组，失败槽位为 undefined，不抛错（尽力而为）。
 */

import { WorkflowParallelError } from "../runtime/errors.js"

export interface ParallelOptions {
  /** 失败模式，默认 "fail-fast" */
  onFailure?: "fail-fast" | "collect" | "partial"
}

export async function parallel<T>(
  tasks: Array<() => Promise<T>>,
  options?: ParallelOptions,
): Promise<T[]> {
  const onFailure = options?.onFailure ?? "fail-fast"

  if (tasks.length === 0) return []

  if (onFailure === "fail-fast") {
    return new Promise<T[]>((resolve, reject) => {
      const results: Array<T | undefined> = new Array(tasks.length).fill(undefined)
      let rejected = false
      let pending = tasks.length

      tasks.forEach((task, index) => {
        Promise.resolve()
          .then(task)
          .then((value) => {
            if (rejected) return
            results[index] = value
            pending -= 1
            if (pending === 0) resolve(results as T[])
          })
          .catch((cause: unknown) => {
            if (rejected) return // 已失败：吞掉后续错误，避免 unhandled rejection
            rejected = true
            reject(
              new WorkflowParallelError(
                [{ index, error: cause }],
                results,
                "fail-fast",
              ),
            )
          })
      })
    })
  }

  // collect / partial：等全部落定
  const settled = await Promise.allSettled(tasks.map((task) => task()))
  const results: Array<T | undefined> = new Array(tasks.length).fill(undefined)
  const failures: Array<{ index: number; error: unknown }> = []

  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      results[index] = outcome.value
    } else {
      failures.push({ index, error: outcome.reason })
    }
  })

  if (onFailure === "collect" && failures.length > 0) {
    throw new WorkflowParallelError(failures, results, "collect")
  }

  // partial：失败槽位保持 undefined，仅记录日志
  for (const failure of failures) {
    const message =
      failure.error instanceof Error ? failure.error.message : String(failure.error)
    console.log(`[agentic-workflow] parallel task #${failure.index} failed (partial): ${message}`)
  }

  return results as T[]
}
