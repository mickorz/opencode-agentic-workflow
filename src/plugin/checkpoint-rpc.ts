/**
 * Checkpoint RPC 契约（P2.3，server 与 TUI 双形态共享）
 *
 * 流向：
 *   server workflow -> checkpoint() -> InteractiveCheckpointGate
 *     --emit--> rpc.agentic-workflow.requested { requestId, label, message }
 *     <--call-- TUI: ui.dialog.confirm -> rpc "reply" { requestId, approved, reason? }
 *
 * 事件经 OpenCode 事件流广播（V2EventRpc），TUI 侧 ctx.data.on 订阅；
 * 应答经 client.rpc(...)（或 rpc.call）回到 server 侧注册的 handler。
 */

import { Rpc } from "@opencode/plugin/rpc"

export const CheckpointRpc = Rpc.define({
  id: "agentic-workflow",
  methods: {
    /** TUI -> server：应答审批请求 */
    reply: {
      input: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          approved: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["requestId", "approved"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {
    /** server -> TUI：审批请求 */
    requested: {
      schema: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          label: { type: "string" },
          message: { type: "string" },
        },
        required: ["requestId", "label", "message"],
        additionalProperties: false,
      },
    },
  },
})

/** TUI 订阅用的事件名（字面量类型，保证 data.on 类型匹配；与 CheckpointRpc.id 的一致性由单测保证） */
export const CHECKPOINT_REQUESTED_EVENT = "rpc.agentic-workflow.requested" as const

/** 解析 TUI 应答（handler 入参为 unknown，需手动收窄） */
export function parseCheckpointReply(
  input: unknown,
): { requestId: string; approved: boolean; reason?: string } | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const record = input as { requestId?: unknown; approved?: unknown; reason?: unknown }
  if (typeof record.requestId !== "string" || typeof record.approved !== "boolean") {
    return undefined
  }
  if (record.reason !== undefined && typeof record.reason !== "string") {
    return undefined
  }
  return {
    requestId: record.requestId,
    approved: record.approved,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
  }
}
