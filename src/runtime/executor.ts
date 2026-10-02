/**
 * AgentExecutor —— Workflow Core 与宿主（OpenCode V2）之间唯一的边界抽象
 *
 * Workflow Core 只认识本文件中的接口：
 *   workflow -> AgentExecutor -> OpenCodeV2Executor -> ctx.session
 *
 * 架构约束：本文件禁止 import 任何 OpenCode API。
 * 未来可新增 ClaudeCodeExecutor / CodexExecutor 等实现，Core 不感知。
 */

export interface AgentTask {
  /** 发给子 agent 的提示词 */
  prompt: string
}

export interface AgentResult {
  /** 子 agent 的最终文本输出 */
  output: string
}

export interface AgentExecutor {
  execute(task: AgentTask): Promise<AgentResult>
}

/** MockExecutor：完全脱离 OpenCode，用于测试 Workflow Core 本身 */
export class MockExecutor implements AgentExecutor {
  async execute(task: AgentTask): Promise<AgentResult> {
    return { output: `[mock] ${task.prompt}` }
  }
}
