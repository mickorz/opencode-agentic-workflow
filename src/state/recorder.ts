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

import {
  createRun,
  toErrorRecord,
  type WorkflowIdentity,
  type WorkflowRun,
} from "./journal.js"
import type { ExecutionStore } from "./store.js"
import type { WorkspaceIdentity } from "../workspace/provider.js"
import {
  emitEvent,
  getEventBus,
  type RunProgressSnapshot,
} from "../observability/events.js"

export interface JournalStartInput {
  workflow: WorkflowIdentity
  /** 执行参数（重建执行所需的最小上下文） */
  args?: unknown
  /** 步骤名（可选） */
  stepNames?: string[]
  stepCount: number
  /** 显式 runId（缺省自动生成） */
  runId?: string
  /** 父 run（P2-9 subflow lineage；顶层 run 省略） */
  parentRunId?: string
  /** 嵌套深度（P2-9；顶层 0） */
  depth?: number
}

/** run -> 进度快照（P2-8 数据源；不含步骤 output，失败摘要截断 200 字符） */
export function toProgressSnapshot(run: WorkflowRun): RunProgressSnapshot {
  return {
    runId: run.runId,
    workflow: { id: run.workflow.id, version: run.workflow.version },
    status: run.status,
    startedAt: run.startedAt,
    ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
    ...(run.failure !== undefined
      ? { failure: run.failure.message.slice(0, 200) }
      : {}),
    ...(run.parentRunId !== undefined ? { parentRunId: run.parentRunId } : {}),
    ...(run.depth !== undefined ? { depth: run.depth } : {}),
    steps: run.steps.map((step) => ({
      index: step.index,
      ...(step.name !== undefined ? { name: step.name } : {}),
      status: step.status,
      ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
      ...(step.completedAt !== undefined ? { completedAt: step.completedAt } : {}),
      ...(step.usage !== undefined ? { usage: step.usage } : {}),
      ...(step.model !== undefined ? { model: step.model } : {}),
    })),
  }
}

/** 值 -> 单行预览（字符串直用，其余 JSON 化；超长截断加 …） */
function previewValue(value: unknown, max: number): string {
  if (value === undefined) return ""
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`
}

/** 步骤详情（journal 全量记录的 RPC 投影：输出/错误/耗时/token/模型预览） */
export interface RunStepDetail {
  index: number
  name?: string
  status: string
  startedAt?: number
  completedAt?: number
  /** 步骤输入预览（≤200 字符） */
  input?: string
  /** 步骤输出预览（≤500 字符） */
  output?: string
  /** 失败摘要 "Name: message"（≤300 字符） */
  error?: string
  /** 步骤内 agent 调用 token 累计（P2-8b 元数据） */
  usage?: { input: number; output: number; reasoning: number }
  /** 步骤内最后一次 agent 调用的模型（P2-8b 元数据） */
  model?: string
  /** 步骤内各 agent 调用的宿主会话 ID（Open Session 回放；面板据此拉取对话） */
  sessionIDs?: string[]
}

/** run 详情（P2-8b 节点详情 RPC 载荷：journal 单读，含预览化的步骤载荷） */
export interface RunDetail {
  runId: string
  workflow: { id: string; version: string }
  status: string
  startedAt: number
  completedAt?: number
  /** run 级失败摘要（≤300 字符） */
  failure?: string
  parentRunId?: string
  depth?: number
  /** args 预览（≤200 字符；重建执行的最小上下文） */
  args?: string
  steps: RunStepDetail[]
}

/** run -> 详情（journal 事实源；载荷只做预览化，绝不放大体输出） */
export function toRunDetail(run: WorkflowRun): RunDetail {
  return {
    runId: run.runId,
    workflow: { id: run.workflow.id, version: run.workflow.version },
    status: run.status,
    startedAt: run.startedAt,
    ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
    ...(run.failure !== undefined
      ? {
          failure: previewValue(
            `${run.failure.name}: ${run.failure.message}`,
            300,
          ),
        }
      : {}),
    ...(run.parentRunId !== undefined ? { parentRunId: run.parentRunId } : {}),
    ...(run.depth !== undefined ? { depth: run.depth } : {}),
    ...(run.args !== undefined ? { args: previewValue(run.args, 200) } : {}),
    steps: run.steps.map((step) => ({
      index: step.index,
      ...(step.name !== undefined ? { name: step.name } : {}),
      status: step.status,
      ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
      ...(step.completedAt !== undefined ? { completedAt: step.completedAt } : {}),
      ...(step.input !== undefined && previewValue(step.input, 200) !== ""
        ? { input: previewValue(step.input, 200) }
        : {}),
      ...(step.output !== undefined && previewValue(step.output, 500) !== ""
        ? { output: previewValue(step.output, 500) }
        : {}),
      ...(step.error !== undefined
        ? {
            error: previewValue(
              `${step.error.name}: ${step.error.message}`,
              300,
            ),
          }
        : {}),
      ...(step.usage !== undefined ? { usage: step.usage } : {}),
      ...(step.model !== undefined ? { model: step.model } : {}),
      ...(step.sessionIDs !== undefined && step.sessionIDs.length > 0 ? { sessionIDs: step.sessionIDs } : {}),
    })),
  }
}

export class RunJournal {
  private constructor(
    private readonly store: ExecutionStore,
    readonly run: WorkflowRun,
  ) {}

  /**
   * P2-8b 步骤元数据：订阅 agent.completed（runId 过滤）聚合 token/模型
   * 到 currentStep。事件同步 fan-out，先于 stepCompleted 落盘——无需
   * 额外持久化钩子。终态退订防泄漏；reopen 重新订阅。
   */
  private offUsageMeta: (() => void) | undefined

  private subscribeUsageMeta(): void {
    this.offUsageMeta?.()
    this.offUsageMeta = getEventBus().subscribe((event) => {
      if (event.type !== "agent.completed") return
      if (event.runId !== this.run.runId) return
      const step = this.run.steps[this.run.currentStep]
      if (!step || step.status !== "running") return
      if (event.usage) {
        step.usage = {
          input: (step.usage?.input ?? 0) + (event.usage.input ?? 0),
          output: (step.usage?.output ?? 0) + (event.usage.output ?? 0),
          reasoning: (step.usage?.reasoning ?? 0) + (event.usage.reasoning ?? 0),
        }
      }
      if (event.model) step.model = event.model
      // Open Session 回放：会话 ID 按发生顺序累积（pipeline 步 = 多条目多会话）
      if (event.sessionID) {
        step.sessionIDs = [...(step.sessionIDs ?? []), event.sessionID]
      }
    })
  }

  /** 创建新 run 并持久化初始状态 */
  static async start(store: ExecutionStore, input: JournalStartInput): Promise<RunJournal> {
    const run = createRun(input)
    await store.createRun(run)
    emitEvent({ type: "run.progress", run: toProgressSnapshot(run) })
    const journal = new RunJournal(store, run)
    journal.subscribeUsageMeta()
    return journal
  }

  /** 附加到已有 run（resume 场景：读取历史 journal 继续记录）；不存在返回 undefined */
  static async attach(store: ExecutionStore, runId: string): Promise<RunJournal | undefined> {
    const run = await store.getRun(runId)
    if (!run) return undefined
    const journal = new RunJournal(store, run)
    journal.subscribeUsageMeta()
    return journal
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

  /** P2-8：状态转换后派发进度快照（同步 fan-out，handler 抛错被 bus 隔离） */
  private emitProgress(): void {
    emitEvent({ type: "run.progress", run: toProgressSnapshot(this.run) })
  }

  async stepStarted(index: number, input?: unknown): Promise<void> {
    this.assertOpen()
    const step = this.step(index)
    step.status = "running"
    step.input = input
    step.startedAt = Date.now()
    this.run.currentStep = index
    await this.store.saveRun(this.run)
    this.emitProgress()
  }

  async stepCompleted(index: number, output?: unknown): Promise<void> {
    this.assertOpen()
    const step = this.step(index)
    step.status = "completed"
    step.output = output
    step.completedAt = Date.now()
    await this.store.saveRun(this.run)
    this.emitProgress()
  }

  async stepFailed(index: number, error: unknown): Promise<void> {
    this.assertOpen()
    const step = this.step(index)
    step.status = "failed"
    step.error = toErrorRecord(error)
    step.completedAt = Date.now()
    await this.store.saveRun(this.run)
    this.emitProgress()
  }

  /** run 成功收口 */
  async complete(): Promise<void> {
    this.assertOpen()
    this.run.status = "completed"
    this.run.completedAt = Date.now()
    await this.store.saveRun(this.run)
    this.offUsageMeta?.()
    this.offUsageMeta = undefined
    this.emitProgress()
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
    this.offUsageMeta?.()
    this.offUsageMeta = undefined
    this.emitProgress()
  }

  /**
   * run 中止收口（P1-3 run 控制）：协作式 stop 到达步骤边界 / 孤儿 run 被
   * workflow_control stop 收口。与 fail 同构，状态用 aborted——与失败可区分
   * （用户主动停 ≠ 出错）。非 completed/failed 步骤一律标 skipped
   * （含仍处 running 的被中断步骤：穿透式 abort 不经 stepFailed）。
   */
  async abort(reason?: unknown): Promise<void> {
    this.assertOpen()
    this.run.status = "aborted"
    this.run.completedAt = Date.now()
    this.run.failure = reason === undefined ? undefined : toErrorRecord(reason)
    for (const step of this.run.steps) {
      if (step.status !== "completed" && step.status !== "failed") step.status = "skipped"
    }
    await this.store.saveRun(this.run)
    this.offUsageMeta?.()
    this.offUsageMeta = undefined
    this.emitProgress()
  }

  /**
   * 记录 workspace 身份（P2.7 隔离启用时，resume attach 的依据）。
   * 仅限 run 进行中（收口后不可再写）。
   */
  async setWorkspace(identity: WorkspaceIdentity): Promise<void> {
    this.assertOpen()
    this.run.workspace = identity
    await this.store.saveRun(this.run)
  }

  /**
   * 清除 workspace 身份（清理完成后调用）。
   * 维护性操作：允许在 run 收口后执行——否则已清理的 run
   * 在幂等 resume 时会试图 attach 一个已删除的 worktree。
   */
  async clearWorkspace(): Promise<void> {
    if (this.run.workspace === undefined) return
    this.run.workspace = undefined
    await this.store.saveRun(this.run)
  }

  /**
   * 重新打开已收口的 run（resume 场景）：
   * failed/aborted -> running；未完成步骤重置 pending（连同 input/output/时间戳/错误），
   * completed 步骤原样保留（resume 的续跑依据）。
   */
  async reopen(): Promise<void> {
    if (this.run.status === "running") return
    if (this.run.status === "completed") {
      throw new Error(`cannot reopen completed run: ${this.run.runId}`)
    }
    this.run.status = "running"
    this.run.completedAt = undefined
    this.run.failure = undefined
    for (const step of this.run.steps) {
      if (step.status !== "completed") {
        step.status = "pending"
        step.error = undefined
        step.input = undefined
        step.output = undefined
        step.usage = undefined
        step.model = undefined
        step.sessionIDs = undefined
        step.startedAt = undefined
        step.completedAt = undefined
      }
    }
    await this.store.saveRun(this.run)
    this.subscribeUsageMeta()
    this.emitProgress()
  }
}
