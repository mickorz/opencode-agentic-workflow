/**
 * fallback() —— 降级候选组合子（P1.4）
 *
 * 依序尝试候选任务，第一个成功者胜出；全部失败抛 WorkflowFallbackError
 * （errors 按尝试顺序排列，保留每个候选的失败原因）。
 *
 * 与 retry 的组合即用户链路：
 *   agent -> check fail -> retry -> still fail -> fallback
 *   fallback([() => retry(primary), () => degraded])
 */

import { WorkflowFallbackError } from "../runtime/errors.js"

export interface FallbackOptions {
  /** 日志标签 */
  label?: string
}

export async function fallback<T>(
  candidates: Array<() => Promise<T>>,
  options?: FallbackOptions,
): Promise<T> {
  const label = options?.label ?? ""
  const errors: unknown[] = []

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    if (!candidate) continue
    try {
      const value = await candidate()
      console.log(
        `[agentic-workflow] fallback resolved by candidate #${i}${label ? ` (${label})` : ""}`,
      )
      return value
    } catch (cause) {
      errors.push(cause)
      const message = cause instanceof Error ? cause.message : String(cause)
      console.log(
        `[agentic-workflow] fallback candidate #${i} failed${label ? ` (${label})` : ""}: ${message}`,
      )
    }
  }

  throw new WorkflowFallbackError(errors, label)
}
