/**
 * OpenCode V2 TUI 插件入口（P2.3 双形态的 TUI 侧）
 *
 * 加载约定：package.json exports["./tui"] -> 本文件（default export Plugin.define）。
 * 职责单一：订阅 server 侧 checkpoint 审批请求事件，弹出 TUI 确认框，
 * 把人工决定经 RPC 应答回 server（InteractiveCheckpointGate 挂起处）。
 *
 * 注意：本文件只在 TUI 宿主内加载；server 宿主只加载 "." 入口（src/plugin/index.ts）。
 */

import { Plugin } from "@opencode/plugin/tui"

import { CHECKPOINT_REQUESTED_EVENT, CheckpointRpc } from "./checkpoint-rpc.js"

type TuiContext = Plugin.Context

export default Plugin.define({
  id: "agentic-workflow-tui",
  setup(ctx: TuiContext) {
    return ctx.data.on(CHECKPOINT_REQUESTED_EVENT, (event) => {
      // 事件 data 为 unknown 形状（V2EventRpc.data），手动收窄
      void handleCheckpointRequest(ctx, event.data)
    })
  },
})

async function handleCheckpointRequest(ctx: TuiContext, data: unknown): Promise<void> {
  if (typeof data !== "object" || data === null) return
  const record = data as { requestId?: unknown; label?: unknown; message?: unknown }
  if (typeof record.requestId !== "string") return
  const label = typeof record.label === "string" ? record.label : "checkpoint"
  const message = typeof record.message === "string" ? record.message : ""

  // dialog.confirm: true=确认 / false=取消 / undefined=关闭（全部按「拒绝/批准」二值裁决）
  const approved = await ctx.ui.dialog.confirm({
    title: `Agentic Workflow: ${label}`,
    message,
    label: { confirm: "批准继续", cancel: "拒绝中止" },
  })

  const reason =
    approved === undefined
      ? "dialog dismissed (escaped)"
      : approved
        ? undefined
        : "rejected by reviewer in TUI"

  try {
    await ctx.client.rpc(CheckpointRpc).reply({
      requestId: record.requestId,
      approved: approved === true,
      reason,
    })
  } catch (error) {
    // server 侧已超时收口等情况；仅记录，不影响 TUI
    console.log(
      `[agentic-workflow-tui] checkpoint reply failed (requestId=${record.requestId}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
