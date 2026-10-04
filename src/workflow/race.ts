/**
 * race() —— 首达取胜（P1-5，v1-parity）
 *
 * 并发启动全部分支，**首个成功**者胜出、整体 resolve；其余分支不再等待
 * （无法硬杀进行中的 LLM 调用——与 run 控制/超时同一诚实语义，只有「不再等待」）。
 * 全部分支失败 -> WorkflowRaceError（聚合全部原因；fail-loud，不塌缩 null）。
 * 分支数组为空 = 结构性错误，直接抛。
 *
 * 已为所有分支附加吞错处理（胜出后迟到的失败/全败后的迟到成功均被忽略，
 * 不产生 unhandled rejection）。
 */

import { WorkflowRaceError } from "../runtime/errors.js"

export interface RaceOptions {
  /** 分支名（日志用，可选） */
  names?: string[]
}

export async function race<T>(
  branches: Array<() => Promise<T>>,
  options?: RaceOptions,
): Promise<T> {
  if (branches.length === 0) {
    throw new Error("race() requires at least one branch")
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let failureCount = 0
    const failures: Array<{ index: number; error: unknown }> = []

    branches.forEach((branch, index) => {
      // 附加 catch：胜出/全败后迟到的落定一律忽略（吞错防 unhandled rejection）
      Promise.resolve()
        .then(branch)
        .then(
          (value) => {
            if (settled) return
            settled = true
            const name = options?.names?.[index]
            console.log(
              `[agentic-workflow] race winner: #${index}${name ? ` (${name})` : ""}; ` +
                `${branches.length - 1} loser(s) no longer awaited`,
            )
            resolve(value)
          },
          (cause: unknown) => {
            if (settled) return
            failures.push({ index, error: cause })
            failureCount += 1
            if (failureCount === branches.length) {
              settled = true
              reject(new WorkflowRaceError(failures))
            }
          },
        )
    })
  })
}
