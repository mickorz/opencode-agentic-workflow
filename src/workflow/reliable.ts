/**
 * Reliable Workflow —— P1 完整可靠执行链（用户验收 Demo 的落地）
 *
 * 链路：执行 -> 确定性检查 -> 语义验证（N reviewer）-> 人工审批
 *
 *   agent(分析主题)           —— 做事
 *     -> check(commandSuccess) —— 确定性验证（环境命令真实执行）
 *     -> verify(artifact)      —— 语义质量验证（reviewer 子会话并行）
 *     -> checkpoint(审批)      —— Human-in-the-loop（P1 策略门）
 *
 * 默认 fail-fast：任一环节失败即中断（WorkflowError 家族）。
 * artifact 经闭包传递给 verify（避免 sequence 传值覆盖原始产物）。
 */

import { assert } from "../quality/check.js"
import { checkpoint } from "../quality/checkpoint.js"
import { commandSuccess } from "../quality/predicates.js"
import { assertVerify, type ReviewVerdict } from "../quality/verify.js"
import { observeWorkflow } from "../observability/observe.js"
import { agent } from "./agent.js"
import { phase } from "./phase.js"
import { sequence } from "./sequence.js"

export interface ReliableWorkflowOptions {
  /** check 步骤执行的命令，默认 "node --version" */
  checkCommand?: string
  /** verify 的 reviewer 数，默认 2 */
  reviewers?: number
  /** checkpoint 节点标签 */
  checkpointLabel?: string
}

export interface ReliableWorkflowReport {
  topic: string
  artifact: string
  checkLabel: string
  checkOk: boolean
  verdicts: ReviewVerdict[]
  verified: boolean
  checkpointApproved: boolean
  output: string
}

export async function runReliableWorkflow(
  topic: string,
  options?: ReliableWorkflowOptions,
): Promise<ReliableWorkflowReport> {
  const checkCommand = options?.checkCommand ?? "node --version"
  const reviewers = options?.reviewers ?? 2

  return observeWorkflow(
    "reliable",
    async () => {
      phase("Execute")
      let artifact = ""
      let checkLabel = ""
      let checkOk = false
      let verdicts: ReviewVerdict[] = []
      let checkpointApproved = false

      // 产物经闭包传递（sequence 仅用于 fail-fast 编排），各步骤自然返回各自类型
      await sequence<unknown>([
        // 1. 执行：分析主题
        async () => {
          const result = await agent(
            `针对主题「${topic}」写一份简明分析（3-5 个要点）。` +
              "直接用你自己的知识回答，禁止调用 workflow 或其他任何工具。",
          )
          artifact = result.output
          return result
        },
        // 2. 确定性检查：环境命令真实执行（失败即中断：assert 严格版）
        async () => {
          checkLabel = `check: ${checkCommand} must succeed`
          const result = await assert(() => commandSuccess(checkCommand), checkLabel)
          checkOk = result.ok
          return result
        },
        // 3. 语义验证：N reviewer 并行评审 agent 产物（任一 fail 即中断：assertVerify 严格版）
        async () => {
          const result = await assertVerify(artifact, {
            reviewers,
            label: `verify: ${topic}`,
            criteria: "分析切题、要点清晰、无事实性错误",
          })
          verdicts = result.verdicts
          return result
        },
        // 4. 人工审批（P1 策略门 / P2.3 交互门，经 CheckpointGate 注入）
        async () => {
          await checkpoint("验证完成，是否继续？", {
            label: options?.checkpointLabel ?? "final-review",
          })
          checkpointApproved = true
          return { approved: true }
        },
      ])

      phase("Done")

      const passed = verdicts.filter((v) => v.verdict === "pass").length
      const output = [
        `# Reliable Workflow 报告：${topic}`,
        "",
        `1. 执行：agent 已产出分析（${artifact.length} 字符）`,
        `2. 确定性检查 ${checkOk ? "通过" : "失败"}：${checkLabel}`,
        `3. 语义验证 ${passed}/${verdicts.length} reviewer 通过`,
        `4. 审批：${checkpointApproved ? "已批准" : "未批准"}`,
        "",
        "## 分析产物",
        "",
        artifact,
      ].join("\n")

      return {
        topic,
        artifact,
        checkLabel,
        checkOk,
        verdicts,
        verified: passed === verdicts.length,
        checkpointApproved,
        output,
      }
    },
    { topic, reviewers, checkCommand },
  )
}
