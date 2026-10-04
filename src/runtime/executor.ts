/**
 * AgentExecutor —— Workflow Core 与宿主（OpenCode V2）之间唯一的边界抽象
 *
 * Workflow Core 只认识本文件中的接口：
 *   workflow -> AgentExecutor -> OpenCodeV2Executor -> ctx.session
 *
 * 架构约束：本文件禁止 import 任何 OpenCode API。
 * 未来可新增 ClaudeCodeExecutor / CodexExecutor 等实现，Core 不感知。
 */

/** 子会话模型引用（对应宿主 models 列表的 providerID/id） */
export interface AgentModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface AgentTask {
  /** 发给子 agent 的提示词 */
  prompt: string
  /**
   * 子 agent 的工作目录（P2.7 隔离）：启用 workspace 时为 worktree 根，
   * executor 应将其绑定为子会话 cwd；未启用时不传。
   */
  cwd?: string
  /**
   * P1-4 调用级模型覆盖：存在时优先于 executor 构造期默认模型。
   * 由 agent(prompt, { model }) 解析注入；executor 只消费。
   */
  model?: AgentModelRef
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
  /**
   * 结构化输出（P1-6 shim）：agent(prompt, { schema }) 时，output 经
   * 解析 + validateArgs 校验后的 JSON 值。executor 不负责填充（宿主无
   * 原生结构化输出），由 agent() 原语统一挂载。
   */
  structured?: unknown
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
