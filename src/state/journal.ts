/**
 * Workflow Journal 模型（P2.1，P2.5 升级版本身份）
 *
 * 一个 WorkflowRun 是某次 workflow 执行的持久化描述，是 P2 后续
 * resume（P2.2）、trace（P2.4）、TUI（P2.3）、registry（P2.5）的共同基础。
 *
 * 形状：
 *   WorkflowRun
 *   ├─ runId / workflow { id, version }   ← P2.5：版本身份（安全 resume 的依据）
 *   ├─ status / currentStep
 *   ├─ startedAt / completedAt
 *   └─ steps[] { input, output, status, error, timestamps }
 *
 * 可序列化纪律：run 及 steps 的 input/output/error 必须可 JSON 化
 * （不可 JSON 化的值在落盘时被替换为占位描述，见 file-store 的 replacer；
 * 需要被 resume 消费的值应保持 JSON-safe，如 AgentResult { output: string }）。
 */

import type { WorkspaceIdentity } from "../workspace/provider.js"

export type RunStatus = "running" | "completed" | "failed" | "aborted"

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped"

export interface StepErrorRecord {
  /** 错误名（如 WorkflowCheckError） */
  name: string
  message: string
}

/** workflow 版本身份：resume 必须经 registry 解析到精确版本，绝不隐式取最新 */
export interface WorkflowIdentity {
  id: string
  /** 语义化版本（与 WorkflowDefinition.version 一致） */
  version: string
}export interface StepRecord {
  /** 步骤序号（0 起，对应 sequence 下标） */
  index: number
  /** 步骤名（可选，便于定位） */
  name?: string
  status: StepStatus
  /** 步骤输入（序列化后；通常是上一步 output） */
  input?: unknown
  /** 步骤输出（序列化后；resume 时作为后续步骤的 prev） */
  output?: unknown
  /** 失败信息 */
  error?: StepErrorRecord
  startedAt?: number
  completedAt?: number
}

export interface WorkflowRun {
  /** 全局唯一 run 标识（run_<time>_<rand>） */
  runId: string
  /** workflow 版本身份（P2.5：安全 resume 依据，见 registry.resolve） */
  workflow: WorkflowIdentity
  status: RunStatus
  /** 当前/最后尝试的步骤序号；未开始为 -1 */
  currentStep: number
  /** epoch ms（排序与耗时计算用） */
  startedAt: number
  completedAt?: number
  /** 执行参数（重建执行所需的最小上下文，如 topic；由 argsSchema 声明契约） */
  args?: unknown
  /**
   * 隔离工作区身份（P2.7）：resume 必须附着原 workspace——
   * durable resume = journal 状态 + 文件系统状态同时恢复。
   * 清理完成后置 undefined（见 RunJournal.clearWorkspace）。
   */
  workspace?: WorkspaceIdentity
  /**
   * 父 run 的 runId（P2-9 subflow lineage）：subflow 子 run 指回发起它的
   * 父 run；顶层 run 无此字段。跨 run 关系查询/进度树分组依据。
   */
  parentRunId?: string
  /** P2-9 嵌套深度：顶层 0，subflow 子 run = 父 + 1（展示缩进用） */
  depth?: number
  /** 失败/中断原因（run 级别） */
  failure?: StepErrorRecord
  steps: StepRecord[]
}

/** 生成 runId：run_<epochms>_<rand8>（文件名安全字符） */
export function generateRunId(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `run_${Date.now()}_${rand}`
}

/** runId 白名单（防止路径穿越；文件名安全字符集） */
export function isValidRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runId)
}

/** Error -> StepErrorRecord */
export function toErrorRecord(error: unknown): StepErrorRecord {
  if (error instanceof Error) {
    return { name: error.name, message: error.message }
  }
  return { name: "Error", message: String(error) }
}

/** 创建初始 run（全部步骤 pending） */
export function createRun(input: {
  runId?: string
  workflow: WorkflowIdentity
  args?: unknown
  stepNames?: string[]
  stepCount: number
  /** 父 run（P2-9 subflow lineage；顶层 run 省略） */
  parentRunId?: string
  /** 嵌套深度（P2-9；顶层 0） */
  depth?: number
}): WorkflowRun {
  if (!Number.isInteger(input.stepCount) || input.stepCount < 0) {
    throw new Error(`stepCount must be a non-negative integer, got ${input.stepCount}`)
  }
  if (!input.workflow.id || typeof input.workflow.id !== "string") {
    throw new Error("workflow.id must be a non-empty string")
  }
  if (!input.workflow.version || typeof input.workflow.version !== "string") {
    throw new Error("workflow.version must be a non-empty string")
  }
  return {
    runId: input.runId ?? generateRunId(),
    workflow: input.workflow,
    status: "running",
    currentStep: -1,
    startedAt: Date.now(),
    args: input.args,
    ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
    ...(input.depth !== undefined ? { depth: input.depth } : {}),
    steps: Array.from({ length: input.stepCount }, (_, index) => ({
      index,
      name: input.stepNames?.[index],
      status: "pending" as const,
    })),
  }
}
