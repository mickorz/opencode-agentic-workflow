/**
 * RunJournal —— run 生命周期记录器（P2.1）
 *
 * 包装 ExecutionStore：每次状态变更后全量落盘（journal = 一串原子快照）。
 * P2.2 的 sequence resume 将基于这些记录重建执行（attach -> 读已完成步骤 -> 续跑）。
 *
 * 典型生命周期：
 *   start()            -> run 创建并落盘（全部步骤 pending）
 *   stepStarted(i)     -> 步骤开始（input 记录）
 *   stepCompleted(i)   -> 步骤成功（output 记录，resume 时的续跑依据）
 *   stepFailed(i, e)   -> 步骤失败（error 记录）
 *   complete()/fail(e) -> run 收口（fail 时仍为 pending 的步骤标记 skipped）
 *
 * status=aborted 预留给中断场景（交互拒绝/人工打断，P2.3+）。
 */

import { createRun, toErrorRecord, type WorkflowRun } from "./journal.js"
import type { ExecutionStore } from "./store.js"

export interface JournalStartInput {
  workflowId: string
  /** 执行参数（重建执行所需的最小上下文） */
  args?: Record<string, unknown>
  /** 步骤名（可选） */
  stepNames?: string[]
  stepCount: number
  /** 显式 runId（缺省自动生成） */
  runId?: string
}

export class RunJournal {
  private constructor(
    private readonly store: ExecutionStore,
    readonly run: WorkflowRun,
  ) {}

  /** 创建新 run 并持久化初始状态 */
  static async start(store: ExecutionStore, input: JournalStartInput): Promise<RunJournal> {
    const run = createRun(input)
    await store.createRun(run)
    return new RunJournal(store, run)
  }

  /** 附加到已有 run（resume 场景：读取历史 journal 继续记录）；不存在返回 undefined */
  static async attach(store: ExecutionStore, runId: string): Promise<RunJournal | undefined> {
    const run = await store.getRun(runId)
    return run ? new RunJournal(store, run) : undefined
  }

  private assertOpen(): void {
    if (this.run.status !== "running") {
      throw new Error(`journal closed (status=${this.run.status}): run ${this.run.runId}`)
    }
  }

  private step(index: number) {
    const step = this.run.steps[index]
    if (!step) {
      throw new Error(`step index out of range: ${index} (run ${this.run.runId})`)
    }
    return step
  }

  async stepStarted(index: number, input?: unknown): Promise<void> {
    this.assertOpen()
    const step = this.step(index)
    step.status = "running"
    step.input = input
    step.startedAt = Date.now()
    this.run.currentStep = index
    await this.store.saveRun(this.run)
  }

  async stepCompleted(index: number, output?: unknown): Promise<void> {
    this.assertOpen()
    const step = this.step(index)
    step.status = "completed"
    step.output = output
    step.completedAt = Date.now()
    await this.store.saveRun(this.run)
  }

  async stepFailed(index: number, error: unknown): Promise<void> {
    this.assertOpen()
    const step = this.step(index)
    step.status = "failed"
    step.error = toErrorRecord(error)
    step.completedAt = Date.now()
    await this.store.saveRun(this.run)
  }

  /** run 成功收口 */
  async complete(): Promise<void> {
    this.assertOpen()
    this.run.status = "completed"
    this.run.completedAt = Date.now()
    await this.store.saveRun(this.run)
  }

  /** run 失败收口：仍为 pending 的步骤标记 skipped（fail-fast 下它们不会被执行） */
  async fail(error: unknown): Promise<void> {
    this.assertOpen()
    this.run.status = "failed"
    this.run.completedAt = Date.now()
    this.run.failure = toErrorRecord(error)
    for (const step of this.run.steps) {
      if (step.status === "pending") step.status = "skipped"
    }
    await this.store.saveRun(this.run)
  }
}
