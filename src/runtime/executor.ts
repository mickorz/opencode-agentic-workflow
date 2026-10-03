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
  /**
   * 子 agent 的工作目录（P2.7 隔离）：启用 workspace 时为 worktree 根，
   * executor 应将其绑定为子会话 cwd；未启用时不传。
   */
  cwd?: string
}

/** token 用量（结构对齐宿主 API 的 usage 形状，但为 Core 自有类型） */
export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  /** 思维链 token 已含在 output 中时为 0 */
  cache: { read: number; write: number }
}

export interface AgentResult {
  /** 子 agent 的最终文本输出 */
  output: string
  /** token 用量（宿主能提供时；如 OpenCode V2 的 assistant 消息 tokens 字段） */
  usage?: TokenUsage
  /** 本次调用的美元成本（宿主直接给出时；如 V2 的 cost 字段） */
  costUSD?: number
  /** 实际使用的模型 "providerID/id"（宿主能提供时） */
  model?: string
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
