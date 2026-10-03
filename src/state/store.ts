/**
 * ExecutionStore —— 持久化执行记录的存储抽象（P2.1）
 *
 * 依赖倒置（与 AgentExecutor / CheckpointGate 同思路）：
 *   Workflow Core 只依赖本接口；实现可以是
 *   FileExecutionStore（本地 JSON）/ SQLiteExecutionStore /
 *   OpenCodeStorageAdapter（P2 后期，经 ctx.storage）。
 *
 * 写入契约：
 *   - saveRun 为全量覆写（journal 每次状态变更后整体落盘）
 *   - 实现必须保证单个 run 文件的写入原子性（读不到半截 JSON）
 */

import type { WorkflowRun } from "./journal.js"

export interface ExecutionStore {
  /** 新建 run（已存在同 runId 时抛错，防止覆盖历史记录） */
  createRun(run: WorkflowRun): Promise<void>
  /** 全量覆写保存 run */
  saveRun(run: WorkflowRun): Promise<void>
  /** 读取 run；不存在返回 undefined */
  getRun(runId: string): Promise<WorkflowRun | undefined>
  /** 列出 runs；可选按 workflow id 过滤（不区分版本），按 startedAt 倒序 */
  listRuns(workflowId?: string): Promise<WorkflowRun[]>
}
