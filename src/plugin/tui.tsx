/**
 * OpenCode V2 TUI 插件入口（P2.3 checkpoint 审批 + P2-8 进度面板）
 *
 * 加载约定：package.json exports["./tui"] -> 本文件（default export Plugin.define）。
 * 职责：
 *   - 订阅 server 侧 checkpoint 审批请求事件，弹出 TUI 确认框，
 *     把人工决定经 RPC 应答回 server（InteractiveCheckpointGate 挂起处）。
 *   - /workflow 命令打开进度面板（session.panel slot）：
 *     初始经 snapshot RPC 同步近期 run，之后订阅 progress 事件实时更新。
 *
 * 注意：
 *   - 本文件只在 TUI 宿主内加载；server 宿主只加载 "." 入口（src/plugin/index.ts）。
 *   - solid-js 用法全部集中在本文件（v1 实测教训：多文件会解析出不同实例）。
 *   - 视图逻辑在 progress-view.ts（纯函数，单测覆盖）；本文件只剩摆线。
 */

import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"

import { CHECKPOINT_REQUESTED_EVENT, CheckpointRpc } from "./checkpoint-rpc.js"
import {
  PROGRESS_EVENT,
  ProgressRpc,
  parseRunSnapshot,
  parseRunSnapshotList,
} from "./progress-rpc.js"
import { renderPanelLines } from "./progress-view.js"
import type { RunProgressSnapshot } from "../observability/events.js"

type TuiContext = Plugin.Context

/** 面板内容名（ui.panel.open 与 slot claim 的握手键） */
const PANEL_NAME = "agentic-workflow"

export default Plugin.define({
  id: "agentic-workflow-tui",
  setup(ctx: TuiContext) {
    const offCheckpoint = ctx.data.on(CHECKPOINT_REQUESTED_EVENT, (event) => {
      // 事件 data 为 unknown 形状（V2EventRpc.data），手动收窄
      void handleCheckpointRequest(ctx, event.data)
    })
    const offProgress = setupProgressPanel(ctx)
    return () => {
      offCheckpoint()
      offProgress()
    }
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

/**
 * 进度面板装配：状态 signal + snapshot 初始同步 + progress 事件流 +
 * session.panel claim + /workflow 命令。返回清理函数。
 */
function setupProgressPanel(ctx: TuiContext): () => void {
  const [runs, setRuns] = createSignal<readonly RunProgressSnapshot[]>([])
  const [live, setLive] = createSignal(false)

  // 初始同步：server 侧 board 的近期 run（面板未开也拉——首次打开即时有内容）
  void ctx.client
    .rpc(ProgressRpc)
    .snapshot({})
    .then((output) => {
      setRuns(parseRunSnapshotList(output))
    })
    .catch(() => {
      // server 侧无 progress board（旧版本/注册失败）——面板维持空态
    })

  // 实时流：全量快照，无需对账
  const offEvent = ctx.data.on(PROGRESS_EVENT, (event) => {
    const snapshot = parseRunSnapshot(event.data)
    if (!snapshot) return
    setLive(true)
    setRuns((prev) => {
      const rest = prev.filter((r) => r.runId !== snapshot.runId)
      return [snapshot, ...rest].slice(0, 50)
    })
  })

  // 面板 claim：宿主选中我们的内容名时才渲染；其余名字让位（返回空 fragment）
  const offSlot = ctx.ui.slot({
    append: "session.panel",
    render: (input) =>
      input.name === PANEL_NAME ? (
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
          {/* 视图行全部来自纯函数层；signal 读取发生在 JSX 内（响应式追踪） */}
          {(live() || runs().length > 0
            ? renderPanelLines(runs())
            : ["Agentic Workflow", "(no runs yet — start one with workflow_start)"]
          ).map((line) => (
            <text>{line}</text>
          ))}
        </box>
      ) : (
        <></>
      ),
  })

  // /workflow 命令 + 命令面板入口
  ctx.keymap.layer(() => ({
    commands: [
      {
        id: "agentic-workflow.panel",
        title: "Workflow progress",
        group: "Agentic Workflow",
        palette: true,
        slash: { name: "workflow" },
        run: () => {
          ctx.ui.panel.open(PANEL_NAME)
        },
      },
    ],
  }))

  return () => {
    offEvent()
    offSlot()
  }
}
