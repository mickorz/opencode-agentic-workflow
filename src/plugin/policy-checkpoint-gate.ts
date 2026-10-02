/**
 * PolicyCheckpointGate —— 按固定策略裁决的审批门（plugin 层，P1）
 *
 * 背景：server 侧插件域没有创建权限请求/表单的 API（permission.create
 * 只在 HTTP client 上），交互式审批需要 TUI 双形态插件 + RPC（P2）。
 * P1 先用策略门证明 checkpoint 的执行语义（headless e2e 可验收）。
 *
 * mode:
 *   "auto-approve" : 自动批准（默认；仅用于验收/演示，日志明确提示非人工）
 *   "auto-reject"  : 自动拒绝（安全演练/测试拒绝路径）
 */

import type {
  CheckpointDecision,
  CheckpointGate,
  CheckpointRequest,
} from "../quality/checkpoint.js"

export type CheckpointPolicy = "auto-approve" | "auto-reject"

export class PolicyCheckpointGate implements CheckpointGate {
  private readonly mode: CheckpointPolicy

  constructor(mode: CheckpointPolicy = "auto-approve") {
    this.mode = mode
  }

  async ask(request: CheckpointRequest): Promise<CheckpointDecision> {
    console.log(
      `[agentic-workflow] checkpoint request (${this.mode}): ${request.label} -- ${request.message}`,
    )
    if (this.mode === "auto-approve") {
      console.log(
        "[agentic-workflow] NOTE: auto-approved by policy gate; " +
          "interactive approval lands in P2 (TUI dialog gate)",
      )
      return { approved: true }
    }
    return { approved: false, reason: "rejected by policy gate (auto-reject)" }
  }
}
