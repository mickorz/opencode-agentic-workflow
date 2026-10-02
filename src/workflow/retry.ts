/**
 * retry() —— 失败重试组合子（P1.4）
 *
 * 基于统一失败模型（WorkflowError 家族）：默认重试一切失败，
 * 可用 retryOn 过滤（例如对配额类错误不重试，防重试风暴——见经验沉淀）。
 *
 * 防锤击默认值（经验教训 tool-throw-retry-storm-and-concurrency.md）：
 *   attempts=3 / delayMs=1000 / exponential backoff / maxDelayMs=30s
 *
 * 拒绝契约：
 *   - 重试耗尽 -> WorkflowRetryError（attempts + lastError cause 链）
 *   - retryOn 判定不可重试 -> 原样抛出原始异常（调用方自行分类）
 */

import { WorkflowRetryError } from "../runtime/errors.js"

export interface RetryOptions {
  /** 总尝试次数（含首次），默认 3 */
  attempts?: number
  /** 首次重试前等待毫秒，默认 1000；0 表示立即重试 */
  delayMs?: number
  /** 退避策略：fixed 固定间隔 / exponential 指数退避（默认） */
  backoff?: "fixed" | "exponential"
  /** exponential 模式下的单次等待上限，默认 30000 */
  maxDelayMs?: number
  /** 重试过滤器：返回 false 的异常不重试、原样抛出 */
  retryOn?: (error: unknown) => boolean
  /** 日志标签 */
  label?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function retry<T>(
  task: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options?.attempts ?? 3))
  const delayMs = options?.delayMs ?? 1000
  const backoff = options?.backoff ?? "exponential"
  const maxDelayMs = options?.maxDelayMs ?? 30_000
  const retryOn = options?.retryOn ?? (() => true)
  const label = options?.label ?? ""

  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task()
    } catch (cause) {
      lastError = cause

      if (attempt === attempts) {
        throw new WorkflowRetryError(attempts, lastError, label)
      }
      if (!retryOn(cause)) {
        // 不可重试：原样抛出，让调用方的失败策略接手
        throw cause
      }

      const wait =
        backoff === "exponential"
          ? Math.min(delayMs * 2 ** (attempt - 1), maxDelayMs)
          : delayMs
      if (wait > 0) {
        const message = cause instanceof Error ? cause.message : String(cause)
        console.log(
          `[agentic-workflow] retry ${attempt}/${attempts - 1}${label ? ` (${label})` : ""} ` +
            `in ${wait}ms after: ${message}`,
        )
        await sleep(wait)
      }
    }
  }

  /* istanbul ignore next -- 循环必然 return/throw，不可达 */
  throw new WorkflowRetryError(attempts, lastError, label)
}
