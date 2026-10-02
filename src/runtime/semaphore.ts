/**
 * Semaphore —— 并发上限控制
 *
 * 环境约束：模型 API 最多支持 3 个并发请求。
 * parallel() 本身不限流（保持 Core 语义纯净），限流在执行器包装层完成：
 *   withConcurrencyLimit(executor, 3)
 */

import type { AgentExecutor, AgentResult, AgentTask } from "./executor.js"

export class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error(`Semaphore limit must be >= 1, got ${limit}`)
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => this.queue.push(resolve))
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) {
      next() // 保持 active 不变：槽位直接移交给下一个等待者
    } else {
      this.active -= 1
    }
  }
}

/** 默认并发上限：模型 API 最多支持 3 个并发 */
export const DEFAULT_MAX_CONCURRENCY = 3

/**
 * 包装一个 AgentExecutor，限制同时执行的 agent 任务数。
 * 超出上限的任务排队等待（FIFO），不拒绝。
 */
export function withConcurrencyLimit(
  executor: AgentExecutor,
  limit: number = DEFAULT_MAX_CONCURRENCY,
): AgentExecutor {
  const semaphore = new Semaphore(limit)
  return {
    async execute(task: AgentTask): Promise<AgentResult> {
      return semaphore.run(() => executor.execute(task))
    },
  }
}
