/**
 * Reliable Workflow —— P1 完整可靠执行链（用户验收 Demo 的落地）
 *
 * 链路：执行 -> 确定性检查 -> 语义验证（N reviewer）-> 人工审批
 *
 *   agent(分析主题)           —— 做事
 *     -> check(commandSuccess) —— 确定性验证（环境命令真实执行）
 *     -> verify(artifact)      —— 语义质量验证（reviewer 子会话并行）
 *     -> checkpoint(审批)      —— Human-in-the-loop（P1 策略门 / P2.3 交互门）
 *
 * 默认 fail-fast：任一环节失败即中断（WorkflowError 家族）。
 *
 * P2.5 resume 关键设计：步骤状态经 prev 链**累积**（不再闭包捕获）——
 * resume 跳过 completed 步骤时，后续步骤与最终报告仍能从
 * journal 记录的累积状态完整重建。
 */

import { assert } from "../quality/check.js"
import { checkpoint } from "../quality/checkpoint.js"
import { commandSuccess } from "../quality/predicates.js"
import { assertVerify, type ReviewVerdict } from "../quality/verify.js"
import { observeWorkflow } from "../observability/observe.js"
import { agent } from "./agent.js"
import { phase } from "./phase.js"
import { sequence, type RunStepsFn } from "./sequence.js"

export interface ReliableWorkflowOptions {
  /** check 步骤执行的命令，默认 "node --version" */
  checkCommand?: string
  /** verify 的 reviewer 数，默认 2 */
  reviewers?: number
  /** checkpoint 节点标签 */
  checkpointLabel?: string
  /**
   * 注入的步骤编排入口（registry ctx.runSteps）；缺省 sequence 直跑。
   * 传入后 start/resume 由其内部封装（journal 记录 / completed 前缀跳过）。
   */
  runSteps?: RunStepsFn
}

/** 链路累积状态：每一步返回 {...prev, 新字段}，journal 逐步落盘 */
export interface ReliableState {
  artifact?: string
  checkLabel?: string
  checkOk?: boolean
  verdicts?: ReviewVerdict[]
  checkpointApproved?: boolean
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
  const runSteps: RunStepsFn =
    options?.runSteps ?? ((steps, stepOptions) => sequence(steps, stepOptions))

  return observeWorkflow(
    "reliable",
    async () => {
      phase("Execute")

      const state = await runSteps<ReliableState>(
        [
          // 1. 执行：分析主题
          async () => {
            const result = await agent(
              `针对主题「${topic}」写一份简明分析（3-5 个要点）。` +
                "直接用你自己的知识回答，禁止调用 workflow 或其他任何工具。",
            )
            return { artifact: result.output }
          },
          // 2. 确定性检查：环境命令真实执行（失败即中断：assert 严格版）
          async (prev) => {
            const label = `check: ${checkCommand} must succeed`
            const result = await assert(() => commandSuccess(checkCommand), label)
            return { ...prev, checkLabel: label, checkOk: result.ok }
          },
          // 3. 语义验证：N reviewer 并行评审 agent 产物（任一 fail 即中断：assertVerify 严格版）
          async (prev) => {
            const result = await assertVerify(prev?.artifact ?? "", {
              reviewers,
              label: `verify: ${topic}`,
              criteria: "分析切题、要点清晰、无事实性错误",
            })
            return { ...prev, verdicts: result.verdicts }
          },
          // 4. 人工审批（P1 策略门 / P2.3 交互门，经 CheckpointGate 注入）
          async (prev) => {
            await checkpoint("验证完成，是否继续？", {
              label: options?.checkpointLabel ?? "final-review",
            })
            return { ...prev, checkpointApproved: true }
          },
        ],
        { stepNames: ["execute", "check", "verify", "checkpoint"] },
      )

      phase("Done")

      const artifact = state?.artifact ?? ""
      const checkLabel = state?.checkLabel ?? ""
      const checkOk = state?.checkOk ?? false
      const verdicts = state?.verdicts ?? []
      const checkpointApproved = state?.checkpointApproved ?? false
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
