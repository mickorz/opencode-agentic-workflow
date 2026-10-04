/**
 * OpenCodeV2Executor —— AgentExecutor 在 OpenCode V2 上的实现
 *
 * 调用链（全部基于 @opencode/plugin 2.0.22 已核实的类型）：
 *   execute(task)
 *     -> session.create({ parentID, title, agent?, model? })  创建子会话（挂在主会话下，TUI 可导航）
 *     -> session.prompt({ sessionID, text })   投递用户消息（V2 为 inbox 异步模型，
 *                                               返回 SessionInboxUser 而非 assistant 内容）
 *     -> session.wait({ sessionID })           等待会话空闲（处理完成）
 *     -> session.context({ sessionID })        拉取消息列表
 *     -> 取最后一条 assistant 消息的 text parts 拼接为 output
 *
 * 架构约束：本文件与 plugin/index.ts 是仅有的允许触碰 OpenCode API 的位置。
 */

import type { Plugin } from "@opencode/plugin"

import type { AgentExecutor, AgentResult, AgentTask, TokenUsage } from "../runtime/executor.js"

/** plugin context 的 session 域类型（避免在多处直接依赖 @opencode/plugin） */
export type SessionDomain = Plugin.Context["session"]

/** 子会话使用的模型引用（对应 models 列表中的 providerID/id） */
export interface ExecutorModelRef {
  id: string
  providerID: string
  variant?: string
}

export interface OpenCodeV2ExecutorOptions {
  /** OpenCode V2 plugin context 提供的 session 域 */
  session: SessionDomain
  /** 主会话 ID；子会话挂在其下（TUI 父子视图可导航） */
  parentSessionId?: string
  /** 子会话标题前缀，默认 "workflow" */
  titlePrefix?: string
  /**
   * 子会话使用的模型。不指定时子会话会用默认 agent 的默认模型，
   * 可能与主会话模型不一致（实测 CLI --model 不会传导到 session.create）。
   */
  model?: ExecutorModelRef
  /** 子会话使用的 OpenCode agent 名（如 build / explore / plan） */
  agent?: string
  /**
   * 成本估算兜底（P2.6 metrics）：宿主消息未带 cost 时，
   * 由宿主价目表（ctx.model.list）按 token 用量估算 USD。
   */
  estimateCost?: (model: string, usage: TokenUsage) => number | undefined
}

export class OpenCodeV2Executor implements AgentExecutor {
  private readonly session: SessionDomain
  private readonly parentSessionId?: string
  private readonly titlePrefix: string
  private readonly model?: ExecutorModelRef
  private readonly agent?: string
  private readonly estimateCost?: (model: string, usage: TokenUsage) => number | undefined
  private counter = 0

  constructor(options: OpenCodeV2ExecutorOptions) {
    this.session = options.session
    this.parentSessionId = options.parentSessionId
    this.titlePrefix = options.titlePrefix ?? "workflow"
    this.model = options.model
    this.agent = options.agent
    this.estimateCost = options.estimateCost
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    this.counter += 1

    const created = await this.session.create({
      parentID: this.parentSessionId,
      title: `${this.titlePrefix}#${this.counter}`,
      // P1-4 调用级覆盖：task.model 优先于构造期默认（agent() 注入）
      model: task.model ?? this.model,
      agent: this.agent,
      // P2.7 隔离：子会话 cwd 绑定到 workflow workspace（worktree 根）
      ...(task.cwd ? { location: { directory: task.cwd } } : {}),
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
          // token 用量 / 成本 / 模型（V2 assistant 消息自带；P2.6 metrics 消费）
          const usage = message.tokens && {
            input: message.tokens.input,
            output: message.tokens.output,
            reasoning: message.tokens.reasoning,
            cache: {
              read: message.tokens.cache.read,
              write: message.tokens.cache.write,
            },
          }
          const model = message.model && `${message.model.providerID}/${message.model.id}`
          return {
            output,
            usage,
            // 成本优先级：宿主正值（精确）> 价目表估算（宿主 0/缺失时兜底——
            // 实测部分 provider 宿主记账为 0 但 models.dev 有实价）> 宿主原值
            costUSD:
              message.cost && message.cost > 0
                ? message.cost
                : (usage && model ? this.estimateCost?.(model, usage) : undefined) ??
                  message.cost,
            model,
          }
        }
        // assistant 存在但无文本：带出底层错误信息（如 provider 限流），便于排查
        const detail = message.error
          ? `${message.error.type ?? "error"}: ${message.error.message ?? "unknown"}`
          : "assistant message has no text parts"
        throw new Error(
          `[agentic-workflow] session ${sessionID} failed: ${detail}`,
        )
      }
    }

    throw new Error(
      `[agentic-workflow] session ${sessionID} finished without assistant message`,
    )
  }
}
