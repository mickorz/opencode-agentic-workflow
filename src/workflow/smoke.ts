/**
 * P0 Smoke Workflow —— 3 个并行分析 agent + 1 个汇总 agent
 *
 * 只使用 Workflow Core 组合子，不含任何 OpenCode 依赖，
 * 因此可以在 MockExecutor（单测）与 OpenCodeV2Executor（真实运行）下复用。
 *
 * 验收链路：
 *   Main Session -> workflow tool -> Workflow Engine
 *     -> Session A / B / C（并行）
 *     -> Summary Agent
 *     -> Result -> Main Session
 */

import { agent } from "./agent.js"
import { parallel } from "./parallel.js"
import { phase } from "./phase.js"
import type { AgentResult } from "../runtime/executor.js"

export async function runSmokeWorkflow(topic: string): Promise<AgentResult> {
  phase("Research")

  const results = await parallel([
    () => agent(`针对主题「${topic}」，从架构设计角度进行分析，给出要点。直接用你自己的知识回答，禁止调用 workflow 或其他任何工具。`),
    () => agent(`针对主题「${topic}」，从风险与约束角度进行分析，给出要点。直接用你自己的知识回答，禁止调用 workflow 或其他任何工具。`),
    () => agent(`针对主题「${topic}」，从实施步骤角度进行分析，给出要点。直接用你自己的知识回答，禁止调用 workflow 或其他任何工具。`),
  ])

  phase("Summary")

  return agent(
    `根据下面三份分析结果生成一份总结（保留关键要点，去除重复）。直接用你自己的知识回答，禁止调用 workflow 或其他任何工具：

${JSON.stringify(results, null, 2)}`,
  )
}
