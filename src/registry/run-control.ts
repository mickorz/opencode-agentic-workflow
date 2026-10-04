/**
 * Run 控制（v1-parity P1-3：后台运行 + status/stop）
 *
 * 进程内两本账：
 *   - live：本进程存活的 run（start/resume 开始时登记、收口时清除）
 *   - cancelled：已请求停止的 run（步骤边界检查并抛 RunAbortedError）
 *
 * stop 语义（协作式，如实告知）：
 *   - 活着的 run：置取消标记，**下一个步骤边界**生效——正在执行的 LLM 调用
 *     不会被硬杀（无 AbortSignal 注入点），收口为 aborted
 *   - 孤儿 run（journal 里 running 但进程已重启）：无活体可停，直接把
 *     journal 收口为 aborted（外部测试 Watching「杀进程后 run 悬置」的解）
 *
 * 纪律：Core 侧模块，禁止 import OpenCode API（架构不变量）。
 */

const liveRuns = new Set<string>()
const cancelledRuns = new Set<string>()

/** 协作式停止：在步骤边界抛出，由 runner 收口 journal 为 aborted */
export class RunAbortedError extends Error {
  constructor(runId: string) {
    super(`run ${runId} aborted by user (cooperative stop at step boundary)`)
    this.name = "RunAbortedError"
  }
}

export function markLive(runId: string): void {
  liveRuns.add(runId)
  cancelledRuns.delete(runId)
}

export function clearLive(runId: string): void {
  liveRuns.delete(runId)
  cancelledRuns.delete(runId)
}

export function isLive(runId: string): boolean {
  return liveRuns.has(runId)
}

export function requestCancel(runId: string): void {
  cancelledRuns.add(runId)
}

export function isCancelled(runId: string): boolean {
  return cancelledRuns.has(runId)
}

export function throwIfCancelled(runId: string): void {
  if (cancelledRuns.has(runId)) {
    throw new RunAbortedError(runId)
  }
}
