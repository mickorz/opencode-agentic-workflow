/**
 * reliable workflow 定义（P2.5）
 *
 * 版本纪律（resume 安全约束）：步骤结构（stepNames 的数量/顺序/语义）变更
 * 必须升 version——resume 依赖 journal.workflow.version 精确解析定义。
 */

import type { WorkflowDefinition } from "../registry/definition.js"
import { runReliableWorkflow } from "../workflow/reliable.js"

export interface ReliableArgs {
  topic: string
  checkCommand?: string
  reviewers?: number
}

export function reliableWorkflow(hostOptions?: {
  checkCommand?: string
  reviewers?: number
}): WorkflowDefinition<ReliableArgs, { output: string }> {
  return {
    id: "reliable",
    version: "1.0.0",
    description: "agent -> 确定性检查 -> 多 reviewer 语义验证 -> 人工审批 的可靠链",
    argsSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "分析主题" },
        checkCommand: { type: "string", description: "check 步骤执行的命令（可选）" },
        reviewers: { type: "integer", description: "reviewer 数量（可选，默认 2）" },
      },
      required: ["topic"],
    },
    stepNames: ["execute", "check", "verify", "checkpoint"],
    async run(args, ctx) {
      return runReliableWorkflow(args.topic, {
        checkCommand: args.checkCommand ?? hostOptions?.checkCommand,
        reviewers: args.reviewers ?? hostOptions?.reviewers,
        runSteps: ctx.runSteps,
      })
    },
  }
}
