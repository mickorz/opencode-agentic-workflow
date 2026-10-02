/**
 * OpenCodeV2Executor —— AgentExecutor 在 OpenCode V2 上的实现
 *
 * 调用链（全部基于 @opencode/plugin 2.0.22 已核实的类型）：
 *   execute(task)
 *     -> session.create({ parentID, title })   创建子会话（挂在主会话下，TUI 可导航）
 *     -> session.prompt({ sessionID, text })   投递用户消息（V2 为 inbox 异步模型，
 *                                               返回 SessionInboxUser 而非 assistant 内容）
 *     -> session.wait({ sessionID })           等待会话空闲（处理完成）
 *     -> session.context({ sessionID })        拉取消息列表
 *     -> 取最后一条 assistant 消息的 text parts 拼接为 output
 *
 * 架构约束：本文件与 plugin/index.ts 是仅有的允许触碰 OpenCode API 的位置。
 */

import type { Plugin } from "@opencode/plugin"

import type { AgentExecutor, AgentResult, AgentTask } from "../runtime/executor.js"

/** plugin context 的 session 域类型（避免在多处直接依赖 @opencode/plugin） */
export type SessionDomain = Plugin.Context["session"]

export interface OpenCodeV2ExecutorOptions {
  /** OpenCode V2 plugin context 提供的 session 域 */
  session: SessionDomain
  /** 主会话 ID；子会话挂在其下（TUI 父子视图可导航） */
  parentSessionId?: string
  /** 子会话标题前缀，默认 "workflow" */
  titlePrefix?: string
}

export class OpenCodeV2Executor implements AgentExecutor {
  private readonly session: SessionDomain
  private readonly parentSessionId?: string
  private readonly titlePrefix: string
  private counter = 0

  constructor(options: OpenCodeV2ExecutorOptions) {
    this.session = options.session
    this.parentSessionId = options.parentSessionId
    this.titlePrefix = options.titlePrefix ?? "workflow"
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    this.counter += 1

    const created = await this.session.create({
      parentID: this.parentSessionId,
      title: `${this.titlePrefix}#${this.counter}`,
    })

    const sessionID = created.id

    await this.session.prompt({
      sessionID,
      text: task.prompt,
    })

    // V2 的 prompt 是 inbox 投递：等待会话处理完成后再读结果
    await this.session.wait({ sessionID })

    const messages = await this.session.context({ sessionID })

    // 从后往前找最后一条 assistant 消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message && message.type === "assistant") {
        const output = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (output.length > 0) {
          return { output }
        }
      }
    }

    throw new Error(
      `[agentic-workflow] session ${sessionID} finished without assistant text output`,
    )
  }
}
