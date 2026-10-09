/**
 * OpenCode V2 TUI 插件入口（P2.3 checkpoint 审批 + P2-8 进度面板；
 * v0.7.0 批次 A/B：主题色 + prompt.footer 状态条 + sidebar 紧凑树）
 *
 * 加载约定：package.json exports["./tui"] -> 本文件（default export Plugin.define）。
 * 职责：
 *   - 订阅 server 侧 checkpoint 审批请求事件，弹出 TUI 确认框，
 *     把人工决定经 RPC 应答回 server（InteractiveCheckpointGate 挂起处）。
 *   - /workflow 命令打开进度面板（session.panel slot）：
 *     初始经 snapshot RPC 同步近期 run，之后订阅 progress 事件实时更新；
 *     最新 run 的节点详情经 detail RPC 按需拉取（runId@status 去重）。
 *   - prompt.footer 状态条：运行中 run 的常驻一行摘要（v1
 *     session_prompt_right 对位；打字时也可见，无需开面板）。
 *   - sidebar.content 紧凑树：侧边栏常驻 run 列表（v1 sidebar_content
 *     对位；空板不渲染）。
 *
 * 注意：
 *   - 本文件只在 TUI 宿主内加载；server 宿主只加载 "." 入口（src/plugin/index.ts）。
 *   - solid-js 用法全部集中在本文件（v1 实测教训：多文件会解析出不同实例）。
 *   - 视图逻辑在 progress-view.ts（纯函数，单测覆盖）；本文件只剩摆线与
 *     tone -> ctx.theme 的颜色映射（v0.7.0：feedback.success/warning/error +
 *     text.muted 四档语义色）。
 */

import { Plugin } from "@opencode/plugin/tui"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { createSignal } from "solid-js"

import { CHECKPOINT_REQUESTED_EVENT, CheckpointRpc } from "./checkpoint-rpc.js"
import {
  PROGRESS_EVENT,
  ProgressRpc,
  parseRunDetail,
  parseRunSnapshot,
  parseRunSnapshotList,
  parseSessionReplay,
} from "./progress-rpc.js"
import {
  renderDetailRows,
  renderDetailSection,
  renderPanelRows,
  renderPromptFooterRows,
  renderSessionRows,
  renderSessionSection,
  renderSidebarRows,
  type DetailSection,
  type PanelRow,
  type PanelTone,
  type SessionSection,
} from "./progress-view.js"
import type { RunProgressSnapshot } from "../observability/events.js"
import type { RunDetail } from "../state/recorder.js"

type TuiContext = Plugin.Context

/** 面板内容名（ui.panel.open 与 slot claim 的握手键） */
const PANEL_NAME = "agentic-workflow"

/** tone -> 主题色（v2 ResolvedTheme：feedback 三态 + text.muted；base 走默认前景） */
function toneFg(theme: ResolvedTheme, tone: PanelTone | undefined) {
  switch (tone) {
    case "success":
      return theme.text.feedback.success.base
    case "warning":
      return theme.text.feedback.warning.base
    case "error":
      return theme.text.feedback.error.base
    case "muted":
      return theme.text.muted
    default:
      return undefined
  }
}

/** 结构化行 -> 带色 <text>（bold 用 <b> 包裹；tone 缺省即宿主默认前景） */
function RowText(props: { key?: number; theme: ResolvedTheme; row: PanelRow }) {
  const fg = () => toneFg(props.theme, props.row.tone)
  return (
    <text fg={fg()}>
      {props.row.bold ? <b>{props.row.text}</b> : props.row.text}
    </text>
  )
}

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
 * session.panel claim + /workflow 命令 + prompt.footer 状态条 + sidebar 紧凑树。
 * 返回清理函数。
 */
function setupProgressPanel(ctx: TuiContext): () => void {
  const [runs, setRuns] = createSignal<readonly RunProgressSnapshot[]>([])
  const [live, setLive] = createSignal(false)
  const [detail, setDetail] = createSignal<DetailSection | undefined>()
  // 去重键：runId@status——同一状态下只拉一次，终态转换再拉一次收尾
  let detailKey = ""
  const [session, setSession] = createSignal<SessionSection | undefined>()
  let sessionKey = ""

  /**
   * Open Session 回放按需拉取：取详情里最后一个带会话的步骤（最新 agent
   * 活动）的最后一个会话。key = runId@status@step 去重；慢回包竞态守卫
   * 同 detail。任意步骤可经同一 RPC（index 选多会话步骤的第几个）。
   */
  const refreshSession = (runId: string, parsed: RunDetail | undefined): void => {
    if (!parsed) return
    const withSessions = parsed.steps.filter(
      (step) => step.sessionIDs !== undefined && step.sessionIDs.length > 0,
    )
    const target = withSessions[withSessions.length - 1]
    if (target === undefined || target.name === undefined) return
    const key = `${runId}@${parsed.status}@${target.name}`
    if (key === sessionKey) return
    sessionKey = key
    void ctx.client
      .rpc(ProgressRpc)
      .session({ runId, step: target.name })
      .then((output) => {
        if (key !== sessionKey) return
        const replay = parseSessionReplay(output)
        setSession(
          replay
            ? { runId, step: target.name!, rows: renderSessionRows(replay) }
            : undefined,
        )
      })
      .catch(() => {
        if (key !== sessionKey) return
        setSession(undefined)
      })
  }

  /** 节点详情按需拉取（journal 单读；无 journal/旧 server -> 空行区，不重试轰炸） */
  const refreshDetail = (snapshot: RunProgressSnapshot): void => {
    const key = `${snapshot.runId}@${snapshot.status}`
    if (key === detailKey) return
    detailKey = key
    void ctx.client
      .rpc(ProgressRpc)
      .detail({ runId: snapshot.runId })
      .then((output) => {
        // 竞态守卫：慢回包不属于最新请求时丢弃
        if (key !== detailKey) return
        const parsed = parseRunDetail(output)
        setDetail(
          parsed
            ? { runId: snapshot.runId, rows: renderDetailRows(parsed) }
            : { runId: snapshot.runId, rows: [] },
        )
        refreshSession(snapshot.runId, parsed)
      })
      .catch(() => {
        if (key !== detailKey) return
        setDetail({ runId: snapshot.runId, rows: [] })
      })
  }

  // 初始同步：server 侧 board 的近期 run（面板未开也拉——首次打开即时有内容）
  void ctx.client
    .rpc(ProgressRpc)
    .snapshot({})
    .then((output) => {
      const parsed = parseRunSnapshotList(output)
      setRuns(parsed)
      if (parsed[0]) refreshDetail(parsed[0])
    })
    .catch(() => {
      // server 侧无 progress board（旧版本/注册失败）——面板维持空态
    })

  // V1 对齐：新 run 进入 running 时自动打开面板（v1 opencode-dynamic-workflows
  // 的默认行为）。每个 runId 只自动开一次——用户手动关掉后本 run 不再打扰；
  // 宿主未暴露插件 options（2.0.22），未来支持 autoOpenPanel=false 时自动生效
  const autoOpened = new Set<string>()
  const maybeAutoOpenPanel = (snapshot: RunProgressSnapshot): void => {
    const opts = (ctx as { options?: Record<string, unknown> }).options
    if (opts?.autoOpenPanel === false) return
    if (snapshot.status !== "running") return
    if (autoOpened.has(snapshot.runId)) return
    autoOpened.add(snapshot.runId)
    // current() 只报「本插件」的活动面板：未开（或别家面板）才开我们的
    if (!ctx.ui.panel.current()) ctx.ui.panel.open(PANEL_NAME)
  }

  // 实时流：全量快照，无需对账
  const offEvent = ctx.data.on(PROGRESS_EVENT, (event) => {
    const snapshot = parseRunSnapshot(event.data)
    if (!snapshot) return
    setLive(true)
    setRuns((prev) => {
      const rest = prev.filter((r) => r.runId !== snapshot.runId)
      return [snapshot, ...rest].slice(0, 50)
    })
    maybeAutoOpenPanel(snapshot)
    refreshDetail(snapshot)
  })

  // 面板 claim：宿主选中我们的内容名时才渲染；其余名字让位（返回空 fragment）
  const offSlot = ctx.ui.slot({
    append: "session.panel",
    render: (input) => {
      return (
        input.name === PANEL_NAME ? (
          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            {/* 视图行全部来自纯函数层；signal 读取发生在 JSX 内（响应式追踪） */}
            {(
              (live() || runs().length > 0
                ? [
                    ...renderPanelRows(runs()),
                    ...renderDetailSection(runs(), detail()),
                    ...renderSessionSection(runs(), session()),
                  ]
                : ([
                    { text: "Agentic Workflow", bold: true },
                    { text: "(no runs yet — start one with workflow_start)", tone: "muted" },
                  ] as PanelRow[])
            ) as PanelRow[]
            ).map((row, i) => <RowText key={i} theme={ctx.theme} row={row} />)}
          </box>
        ) : (
          <></>
        )
      )
    },
  })

  // prompt.footer 状态条（批次 B）：运行中 run 常驻摘要；无运行时整条不渲染
  const offFooter = ctx.ui.slot({
    append: "prompt.footer",
    render: () => {
      const rows = renderPromptFooterRows(runs())
      if (rows.length === 0) return <></>
      return (
        <box flexDirection="column">
          {rows.map((row, i) => (
            <RowText key={i} theme={ctx.theme} row={row} />
          ))}
        </box>
      )
    },
  })

  // sidebar.content 紧凑树（批次 B）：侧边栏常驻；空板整块不渲染
  const offSidebar = ctx.ui.slot({
    append: "sidebar.content",
    render: () => {
      if (runs().length === 0) return <></>
      const rows = renderSidebarRows(runs())
      return (
        <box flexDirection="column">
          {rows.map((row, i) => (
            <RowText key={i} theme={ctx.theme} row={row} />
          ))}
        </box>
      )
    },
  })

  // /workflow 命令 + 命令面板入口
  // keymap.layer 必须在组件/slot 渲染上下文内调用（宿主 2.0.22 在 setup 顶层调用会抛
  // "Keymap.Provider is missing"）；官方 session.panel 示例用 append:"app" 空渲染挂载。
  ctx.ui.slot({
    append: "app",
    render: () => {
      ctx.keymap.layer(() => ({
        mode: "global",
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
      return null
    },
  })

  return () => {
    offEvent()
    offSlot()
    offFooter()
    offSidebar()
  }
}
