/**
 * Workflow Journal 模型（P2.1）
 *
 * 一个 WorkflowRun 是某次 workflow 执行的持久化描述，是 P2 后续
 * resume（P2.2）、trace（P2.4）、TUI（P2.3）、registry（P2.5）的共同基础。
 *
 * 形状（与 P2 规划一致）：
 *   WorkflowRun
 *   ├─ runId / workflowId
 *   ├─ status / currentStep
 *   ├─ startedAt / completedAt
 *   └─ steps[] { input, output, status, error, timestamps }
 *
 * 可序列化纪律：run 及 steps 的 input/output/error 必须可 JSON 化
 * （不可 JSON 化的值在落盘时被替换为占位描述，见 file-store 的 replacer；
 * 需要被 resume 消费的值应保持 JSON-safe，如 AgentResult { output: string }）。
 */

export type RunStatus = "running" | "completed" | "failed" | "aborted"

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped"

export interface StepErrorRecord {
  /** 错误名（如 WorkflowCheckError） */
  name: string
  message: string
}

export interface StepRecord {
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
  /** workflow 标识（如 "reliable"、"smoke"） */
  workflowId: string
  status: RunStatus
  /** 当前/最后尝试的步骤序号；未开始为 -1 */
  currentStep: number
  startedAt: number
  completedAt?: number
  /** 执行参数（重建执行所需的最小上下文，如 topic） */
  args?: Record<string, unknown>
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
  workflowId: string
  args?: Record<string, unknown>
  stepNames?: string[]
  stepCount: number
}): WorkflowRun {
  if (!Number.isInteger(input.stepCount) || input.stepCount < 0) {
    throw new Error(`stepCount must be a non-negative integer, got ${input.stepCount}`)
  }
  return {
    runId: input.runId ?? generateRunId(),
    workflowId: input.workflowId,
    status: "running",
    currentStep: -1,
    startedAt: Date.now(),
    args: input.args,
    steps: Array.from({ length: input.stepCount }, (_, index) => ({
      index,
      name: input.stepNames?.[index],
      status: "pending" as const,
    })),
  }
}
