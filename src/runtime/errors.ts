/**
 * Workflow 错误分类法（P1.3 失败语义的基础）
 *
 * 统一家族：所有「workflow 层」的失败都继承 WorkflowError，
 * 后续 retry / fallback（P1.4）只捕获该家族，业务异常经 cause 链保留。
 */

/** workflow 层失败信号的基类 */
export class WorkflowError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "WorkflowError"
  }
}

/** 单个步骤失败：携带步骤位置与原始异常 */
export class WorkflowStepError extends WorkflowError {
  readonly stepIndex: number
  readonly stepName?: string

  constructor(stepIndex: number, cause: unknown, stepName?: string) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(
      `step #${stepIndex}${stepName ? ` (${stepName})` : ""} failed: ${message}`,
      { cause },
    )
    this.name = "WorkflowStepError"
    this.stepIndex = stepIndex
    this.stepName = stepName
  }
}

/** sequence 整体失败：fail-fast（1 条）或 continue（累积多条） */
export class WorkflowSequenceError extends WorkflowError {
  /** 按发生顺序排列的步骤失败 */
  readonly errors: WorkflowStepError[]
  /** 最后一次成功步骤的返回值（失败后仍可取已产出结果） */
  readonly lastValue: unknown

  constructor(errors: WorkflowStepError[], lastValue: unknown) {
    super(
      `sequence failed (${errors.length} step${errors.length > 1 ? "s" : ""}): ` +
        errors.map((e) => e.message).join("; "),
    )
    this.name = "WorkflowSequenceError"
    this.errors = errors
    this.lastValue = lastValue
  }
}

/** parallel 任务失败：fail-fast（首个）或 collect（全部） */
export interface ParallelFailure {
  /** 失败任务的序号（0 起） */
  index: number
  error: unknown
}

/** parallel 整体失败 */
export class WorkflowParallelError extends WorkflowError {
  readonly failures: ParallelFailure[]
  /** 成功任务的结果（失败槽位为 undefined）；fail-fast 下可能不完整 */
  readonly results: ReadonlyArray<unknown>
  readonly mode: string

  constructor(failures: ParallelFailure[], results: ReadonlyArray<unknown>, mode: string) {
    super(
      `parallel failed (${failures.length} task${failures.length > 1 ? "s" : ""}, mode=${mode}): ` +
        failures
          .map((f) => `#${f.index}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
          .join("; "),
    )
    this.name = "WorkflowParallelError"
    this.failures = failures
    this.results = results
    this.mode = mode
  }
}

/** retry 重试耗尽 */
export class WorkflowRetryError extends WorkflowError {
  /** 已尝试次数（含首次） */
  readonly attempts: number
  /** 最后一次失败的原始异常（通常为 WorkflowError 家族成员） */
  readonly lastError: unknown
  readonly label: string

  constructor(attempts: number, lastError: unknown, label: string) {
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    super(`retry exhausted (${attempts} attempts${label ? `, ${label}` : ""}): ${message}`, {
      cause: lastError,
    })
    this.name = "WorkflowRetryError"
    this.attempts = attempts
    this.lastError = lastError
    this.label = label
  }
}

/** fallback 全部候选失败 */
export class WorkflowFallbackError extends WorkflowError {
  /** 按尝试顺序排列的各候选失败 */
  readonly errors: unknown[]
  readonly label: string

  constructor(errors: unknown[], label: string) {
    super(
      `fallback exhausted (${errors.length} candidate${errors.length > 1 ? "s" : ""}${label ? `, ${label}` : ""}): ` +
        errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; "),
    )
    this.name = "WorkflowFallbackError"
    this.errors = errors
    this.label = label
  }
}
