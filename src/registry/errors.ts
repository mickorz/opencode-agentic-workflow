/**
 * Registry 错误家族（P2.5）
 *
 * 全部继承 WorkflowError：注册/解析/校验失败与执行失败共用同一
 * 错误家族，调用方（workflow tool）统一转文本。
 */

import { WorkflowError } from "../runtime/errors.js"

/** 重复注册（同 id + 同 version） */
export class WorkflowRegistrationError extends WorkflowError {
  constructor(id: string, version: string) {
    super(`workflow already registered: ${id}@${version}`)
    this.name = "WorkflowRegistrationError"
  }
}

/** workflow（或精确版本）未注册；消息列出可用版本，供 resume 诊断 */
export class WorkflowNotFoundError extends WorkflowError {
  constructor(id: string, version: string | undefined, available: string[]) {
    super(
      version === undefined
        ? `workflow not found: ${id}. available: ${available.join(", ") || "(none)"}`
        : `workflow version not found: ${id}@${version}. ` +
          `available versions of ${id}: ${available.join(", ") || "(none)"}`,
    )
    this.name = "WorkflowNotFoundError"
  }
}

/** args 校验失败（JSON Schema 子集） */
export class WorkflowArgsError extends WorkflowError {
  readonly problems: string[]

  constructor(id: string, problems: string[]) {
    super(`invalid args for workflow ${id}: ${problems.join("; ")}`)
    this.name = "WorkflowArgsError"
    this.problems = problems
  }
}

/** run 执行失败（携带 runId，供 resume） */
export class WorkflowExecutionError extends WorkflowError {
  readonly runId: string
  readonly workflowId: string
  readonly workflowVersion: string

  constructor(
    identity: { runId: string; id: string; version: string },
    cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(
      `workflow ${identity.id}@${identity.version} run ${identity.runId} failed: ${message}`,
      { cause },
    )
    this.name = "WorkflowExecutionError"
    this.runId = identity.runId
    this.workflowId = identity.id
    this.workflowVersion = identity.version
  }
}
