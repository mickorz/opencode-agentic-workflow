/**
 * artifact workflow 定义（P2.7 隔离演示与验收载体）
 *
 * 链路：agent 在 workspace 写文件 -> fileExists 检查（workspace 内）-> 审批。
 * 用于真实验证「一个 run 一个稳定、隔离、可恢复的工作目录」：
 *   - 子 agent 的 cwd 已被 runner 绑定到 worktree 根；
 *   - 文件产物落在 worktree 内，不污染项目目录；
 *   - 失败后 resume 重新附着原 worktree，文件仍在。
 */

import path from "node:path"

import type { WorkflowDefinition } from "../registry/definition.js"
import { observeWorkflow } from "../observability/observe.js"
import { agent } from "../workflow/agent.js"
import { assert } from "../quality/check.js"
import { fileExists } from "../quality/predicates.js"
import { checkpoint } from "../quality/checkpoint.js"

export interface ArtifactArgs {
  topic: string
  /** 产物文件名（相对 workspace 根；默认 artifact.md） */
  file?: string
}

export interface ArtifactState {
  file?: string
  absolutePath?: string
  verified?: boolean
  approved?: boolean
}

export function artifactWorkflow(): WorkflowDefinition<ArtifactArgs, { output: string }> {
  return {
    id: "artifact",
    version: "1.0.0",
    description:
      "在隔离 workspace 中生成文件产物并验证（agent 写文件 -> fileExists 检查 -> 审批）",
    argsSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "产物主题" },
        file: { type: "string", description: "产物文件名（默认 artifact.md）" },
      },
      required: ["topic"],
    },
    stepNames: ["write", "check", "checkpoint"],
    async run(args, ctx) {
      const file = args.file ?? "artifact.md"
      return observeWorkflow(
        "artifact",
        async () => {
          const state = await ctx.runSteps<ArtifactState>(
            [
              // 1. 写文件：子 agent 的 cwd 已绑定 workspace 根
              async () => {
                await agent(
                  `请在当前工作目录创建文件 ${file}，内容为针对主题「${args.topic}」的 3-5 条要点分析（Markdown 格式，含一级标题）。` +
                    "使用你的文件写入工具直接创建，禁止调用 workflow 或 workflow_metrics 工具。完成后只回复 done。",
                )
                return {
                  file,
                  absolutePath: path.join(ctx.workspaceRoot ?? process.cwd(), file),
                }
              },
              // 2. 确定性检查：文件真实存在于 workspace
              async (prev) => {
                const dir = ctx.workspaceRoot ?? process.cwd()
                await assert(
                  () => fileExists(path.join(dir, file)),
                  `check: ${file} exists in workspace (${dir})`,
                )
                return { ...prev, verified: true }
              },
              // 3. 审批
              async (prev) => {
                await checkpoint("文件已写入并通过检查，是否继续？", {
                  label: "artifact-review",
                })
                return { ...prev, approved: true }
              },
            ],
            { stepNames: ["write", "check", "checkpoint"] },
          )

          const output = [
            `# Artifact Workflow 报告：${args.topic}`,
            "",
            `- 文件：${state?.file ?? file}`,
            `- 路径：${state?.absolutePath ?? "(未知)"}`,
            `- 检查：${state?.verified ? "通过" : "未通过"}`,
            `- 审批：${state?.approved ? "已批准" : "未批准"}`,
            `- 隔离目录：${ctx.workspaceRoot ?? "(未启用隔离)"}`,
          ].join("\n")
          return { output }
        },
        { topic: args.topic, file },
      )
    },
  }
}
