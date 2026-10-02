/**
 * InteractiveCheckpointGate —— server 侧交互审批门（P2.3）
 *
 * 实现 CheckpointGate（Core 抽象不变，checkpoint() 零改动）：
 *   ask(request)
 *     -> emit rpc.agentic-workflow.requested 事件（TUI 订阅并弹确认框）
 *     -> 挂起等待 reply RPC 回调或超时
 *     -> 超时按 onTimeout 策略裁决（默认 reject——headless 无 TUI 应答时安全失败）
 *
 * 依赖注入：构造时传入 Plugin.Context["rpc"]（RpcDomain），
 * 仅使用 register 一项能力，便于单测用 fake 注入。
 */

import { randomUUID } from "node:crypto"

import type { Plugin } from "@opencode/plugin"

import type {
  CheckpointDecision,
  CheckpointGate,
  CheckpointRequest,
} from "../quality/checkpoint.js"
import { CheckpointRpc, parseCheckpointReply } from "./checkpoint-rpc.js"

type RpcDomain = Plugin.Context["rpc"]

/** bind() 返回的注册句柄（按 CheckpointRpc 定义收窄的最小结构） */
interface CheckpointRegistration {
  events: {
    emit: (name: "requested", data: Record<string, unknown>) => Promise<void>
  }
}

export interface InteractiveCheckpointOptions {
  /** 等待人工应答的超时毫秒数，默认 300000（5 分钟） */
  timeoutMs?: number
  /** 超时裁决策略，默认 "reject"（无 TUI 应答时安全失败） */
  onTimeout?: "reject" | "approve"
}

type PendingResolver = (decision: CheckpointDecision) => void

export class InteractiveCheckpointGate implements CheckpointGate {
  private readonly rpc: RpcDomain
  private readonly timeoutMs: number
  private readonly onTimeout: "reject" | "approve"
  private registration: CheckpointRegistration | undefined
  private readonly pending = new Map<string, PendingResolver>()

  constructor(rpc: RpcDomain, options?: InteractiveCheckpointOptions) {
    this.rpc = rpc
    this.timeoutMs = options?.timeoutMs ?? 300_000
    this.onTimeout = options?.onTimeout ?? "reject"
  }

  /** 注册 reply handler（插件 setup 时调用；成功后才可作为 gate 生效） */
  async bind(): Promise<void> {
    this.registration = await this.rpc.register(CheckpointRpc, {
      reply: async (input: unknown) => {
        const reply = parseCheckpointReply(input)
        if (!reply) {
          return { ok: false }
        }
        const resolve = this.pending.get(reply.requestId)
        if (!resolve) {
          // 已超时/已被处置的请求
          return { ok: false }
        }
        this.pending.delete(reply.requestId)
        resolve({
          approved: reply.approved,
          reason:
            reply.reason ??
            (reply.approved ? undefined : "rejected by reviewer in TUI"),
        })
        return { ok: true }
      },
    })
  }

  async ask(request: CheckpointRequest): Promise<CheckpointDecision> {
    if (!this.registration) {
      throw new Error(
        "[agentic-workflow] InteractiveCheckpointGate not bound: call bind() first",
      )
    }

    const requestId = randomUUID()
    await this.registration.events.emit("requested", {
      requestId,
      label: request.label,
      message: request.message,
    })

    console.log(
      `[agentic-workflow] checkpoint waiting for interactive approval: ` +
        `${request.label} (requestId=${requestId.slice(0, 8)}…)`,
    )

    return new Promise<CheckpointDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(
          this.onTimeout === "approve"
            ? { approved: true, reason: "auto-approved after interactive timeout" }
            : {
                approved: false,
                reason:
                  `no interactive reply within ${this.timeoutMs}ms ` +
                  "(no TUI attached?)",
              },
        )
      }, this.timeoutMs)

      this.pending.set(requestId, (decision) => {
        clearTimeout(timer)
        resolve(decision)
      })
    })
  }

  /** 清理：未决请求全部按拒绝收口（插件卸载/热重载时调用） */
  dispose(): void {
    for (const resolve of this.pending.values()) {
      resolve({ approved: false, reason: "checkpoint gate disposed" })
    }
    this.pending.clear()
  }
}
