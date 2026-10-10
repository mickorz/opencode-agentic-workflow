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
import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal } from "solid-js"

import { CHECKPOINT_REQUESTED_EVENT, CheckpointRpc } from "./checkpoint-rpc.js"
import {
  PROGRESS_EVENT,
  ProgressRpc,
  parseRunDetail,
  parseRunSnapshot,
  parseRunSnapshotList,
  parseSessionReplay,
  type SessionReplay,
} from "./progress-rpc.js"
import {
  renderDetailRows,
  renderDetailSection,
  renderHomeFooterRows,
  renderNodeRows,
  renderOverviewHeaderRows,
  renderPanelRows,
  renderPromptFooterRows,
  renderSessionRows,
  renderSessionSection,
  renderSidebarRows,
  moveSelection,
  rowSelectionKey,
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
    // 裸 <text> 在宿主 TUI 布局里不占行高，兄弟 text 会叠到同一行（空格
    // 透出下层字符）——必须各自包一层 box 才各归其位（v0.10.7）
    <box>
      <text fg={fg()}>{props.row.bold ? <b>{props.row.text}</b> : props.row.text}</text>
    </box>
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

  // 用户折叠态（v1 点击折叠对位）：runId -> collapsed；面板与侧栏共享。
  // 行上的 collapsed 字段由纯函数层算好（含 override 覆盖自动规则），
  // 点击即写反值——TUI 层不含展开规则。
  const [collapseOverride, setCollapseOverride] = createSignal<ReadonlyMap<string, boolean>>(new Map())
  const toggleCollapse = (row: PanelRow) => {
    if (row.runId === undefined || row.collapsed === undefined) return
    setCollapseOverride((prev) => {
      const next = new Map(prev)
      next.set(row.runId!, !row.collapsed)
      return next
    })
  }
  /** 可交互行：折叠头行点击切换；带 runId 的行（步骤/子 run）点击进节点详情 */
  const RowLine = (props: { key?: number; row: PanelRow; sessionID?: string }) => {
    const row = props.row
    const interactive = row.collapsible === true || row.runId !== undefined
    if (!interactive) return <RowText theme={ctx.theme} row={row} />
    return (
      <box
        onMouseDown={() => {
          if (row.collapsible === true) {
            toggleCollapse(row)
            return
          }
          if (row.runId === undefined) return
          ctx.ui.router.navigate({
            type: "plugin",
            name: "node",
            data: {
              runId: row.runId,
              ...(row.stepName !== undefined ? { step: row.stepName } : {}),
              ...(props.sessionID !== undefined ? { returnSessionID: props.sessionID } : {}),
            },
          })
        }}
      >
        <RowText theme={ctx.theme} row={row} />
      </box>
    )
  }

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
                    ...renderPanelRows(runs(), Date.now(), { collapseOverride: collapseOverride() }),
                    ...renderDetailSection(runs(), detail()),
                    ...renderSessionSection(runs(), session()),
                  ]
                : ([
                    { text: "Agentic Workflow", bold: true },
                    { text: "(no runs yet — start one with workflow_start)", tone: "muted" },
                  ] as PanelRow[])
            ) as PanelRow[]
            ).map((row, i) => <RowLine key={i} row={row} sessionID={input.sessionID} />)}
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
    render: (input) => {
      if (runs().length === 0) return <></>
      const rows = renderSidebarRows(runs(), Date.now(), { collapseOverride: collapseOverride() })
      return (
        <box flexDirection="column">
          {rows.map((row, i) => (
            <RowLine key={i} row={row} sessionID={input.sessionID} />
          ))}
        </box>
      )
    },
  })

  // home.footer.status 常驻行（v0.7.1）：宿主 2.0.26 的会话类 slot（sidebar/
  // prompt.footer/session.panel）都不在主页渲染——主页唯一挂载点，让重启后
  // 第一屏就有 workflow 痕迹；空板不渲染
  const offHomeFooter = ctx.ui.slot({
    append: "home.footer.status",
    render: () => {
      const rows = renderHomeFooterRows(runs())
      if (rows.length === 0) return <></>
      return (
        <box flexDirection="row">
          {rows.map((row, i) => (
            <RowText key={i} theme={ctx.theme} row={row} />
          ))}
        </box>
      )
    },
  })

  // /workflow 命令 + 命令面板入口（v0.8.10 批次 C：/workflow 进全屏总览，
  // v1 肌肉记忆对位；侧栏面板另留 palette 命令 + run 启动自动开）
  // keymap.layer 必须在组件/slot 渲染上下文内调用（宿主 2.0.22 在 setup 顶层调用会抛
  // "Keymap.Provider is missing"）；官方 session.panel 示例用 append:"app" 空渲染挂载。
  ctx.ui.slot({
    append: "app",
    render: () => {
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "agentic-workflow.overview.command",
            title: "Workflow overview",
            group: "Agentic Workflow",
            palette: true,
            slash: { name: "workflow" },
            run: () => {
              // 回程键：当前在会话里就记下，Esc 能回来；主页/别处进入则回 home
              const cur = ctx.ui.router.current()
              const sid = cur.type === "session" ? cur.sessionID : undefined
              ctx.ui.router.navigate({
                type: "plugin",
                name: "overview",
                data: sid !== undefined ? { returnSessionID: sid } : undefined,
              })
            },
          },
          {
            id: "agentic-workflow.panel",
            title: "Workflow progress panel",
            group: "Agentic Workflow",
            palette: true,
            run: () => {
              ctx.ui.panel.open(PANEL_NAME)
            },
          },
        ],
      }))
      return null
    },
  })

  /* ---------------------------------------------------------------- *
   * 节点详情视图（v0.8.9，v1 NodeDetailView 对位）
   *
   * 点击面板/侧栏的步骤行（stepName）或子 run 行（runId）进入 plugin 路由；
   * 整页三段式（状态头 / 元数据 / prompt+result+会话回放正文），行模型出自
   * renderNodeRows 纯函数。键位：Enter 开 agent 子会话 · ←/→ 切兄弟节点 ·
   * Esc 返回来源会话。数据：live 快照（头行状态/时长）+ detail RPC（载荷）
   * + session RPC（子会话消息回放）——与面板同通道，无新增 RPC。
   * ---------------------------------------------------------------- */
  const NodeView = (props: { data?: Record<string, unknown> }) => {
    const runId = () => (props.data?.runId as string | undefined) ?? undefined
    const step = () => (props.data?.step as string | undefined) ?? undefined
    const returnSessionID = () => (props.data?.returnSessionID as string | undefined) ?? undefined
    /** 进入来源（"overview" = 从全屏总览进，Esc 回总览而非会话） */
    const from = () => (props.data?.from as string | undefined) ?? undefined
    const liveRun = () => runs().find((r) => r.runId === runId())
    const [detail, setDetail] = createSignal<RunDetail | undefined>()
    const [replay, setReplay] = createSignal<SessionReplay | undefined>()

    // journal 详情：runId@status 去重（终态转换再拉一次收尾，与面板同策略）
    createEffect(() => {
      const id = runId()
      if (id === undefined) return
      const statusKey = liveRun()?.status ?? "-"
      void ctx.client
        .rpc(ProgressRpc)
        .detail({ runId: id })
        .then((output) => {
          if (runId() !== id) return
          setDetail(parseRunDetail(output))
        })
        .catch(() => {
          if (runId() !== id) return
          setDetail(undefined)
        })
      void statusKey
    })

    // agent 会话回放：随节点切换与状态转换重拉
    createEffect(() => {
      const id = runId()
      const name = step()
      if (id === undefined || name === undefined) {
        setReplay(undefined)
        return
      }
      void ctx.client
        .rpc(ProgressRpc)
        .session({ runId: id, step: name })
        .then((output) => {
          if (runId() !== id || step() !== name) return
          setReplay(parseSessionReplay(output) ?? undefined)
        })
        .catch(() => {
          if (runId() !== id || step() !== name) return
          setReplay(undefined)
        })
    })

    const rows = createMemo(() =>
      renderNodeRows(
        {
          run: liveRun(),
          detail: detail(),
          step: step(),
          replay: replay(),
          maxWidth: 100,
        },
        Date.now(),
      ),
    )

    /** 兄弟节点切换序列：live 快照步骤名（回落 journal detail），循环游标 */
    const switchStep = (delta: number) => {
      const id = runId()
      if (id === undefined) return
      const names = (
        liveRun()?.steps.map((s) => s.name) ??
        detail()?.steps.map((s) => s.name) ??
        []
      ).filter((n): n is string => n !== undefined)
      if (names.length === 0) return
      const current = step()
      const idx = current !== undefined ? names.indexOf(current) : -1
      const next = names[(idx + delta + names.length) % names.length]
      if (next === undefined || next === current) return
      ctx.ui.router.navigate({
        type: "plugin",
        name: "node",
        data: {
          runId: id,
          step: next,
          ...(from() !== undefined ? { from: from() } : {}),
          ...(returnSessionID() !== undefined ? { returnSessionID: returnSessionID() } : {}),
        },
      })
    }

    const openSession = () => {
      const target = detail()?.steps.find((s) => s.name === step())?.sessionIDs?.[0]
      if (target !== undefined) ctx.ui.router.navigate({ type: "session", sessionID: target })
    }

    const back = () => {
      // 从总览进来的回总览（保留会话回程键），否则回来源会话/主页
      if (from() === "overview") {
        ctx.ui.router.navigate({
          type: "plugin",
          name: "overview",
          data:
            returnSessionID() !== undefined ? { returnSessionID: returnSessionID() } : undefined,
        })
        return
      }
      const sid = returnSessionID()
      ctx.ui.router.navigate(sid !== undefined ? { type: "session", sessionID: sid } : { type: "home" })
    }

    // 键位层随组件生命周期存在（页面卸载即失效）；整页接管期间全局生效
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        { id: "agentic-workflow.node.back", title: "Back", bind: "escape", run: () => back() },
        {
          id: "agentic-workflow.node.prev",
          title: "Previous node",
          bind: "left",
          run: () => switchStep(-1),
        },
        {
          id: "agentic-workflow.node.next",
          title: "Next node",
          bind: "right",
          run: () => switchStep(1),
        },
        {
          id: "agentic-workflow.node.open",
          title: "Open agent session",
          bind: "enter",
          run: () => openSession(),
        },
      ],
      bindings: [
        "agentic-workflow.node.back",
        "agentic-workflow.node.prev",
        "agentic-workflow.node.next",
        "agentic-workflow.node.open",
      ],
    }))

    return (
      <box
        position="absolute"
        left={0}
        top={0}
        width="100%"
        height="100%"
        flexDirection="column"
        backgroundColor={ctx.theme.background.base}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={2}
      >
        <scrollbox flexGrow={1} flexDirection="column">
          {rows().map((row, i) => (
            <RowText key={i} theme={ctx.theme} row={row} />
          ))}
        </scrollbox>
      </box>
    )
  }

  /* ---------------------------------------------------------------- *
   * 全屏总览（v0.8.10，v1 RouteView 对位）
   *
   * /workflow 进入：头部摘要条（run 数 + 状态 chips）+ 全 run 平铺树
   * （默认全展开；共享面板/侧栏的折叠态），j/k 回绕选节点行、Enter 进
   * 节点详情（from:overview 回程链）、Esc 返回会话。选中越屏时
   * scrollChildIntoView 跟随（行渲染体 id 登记表，v1 同法）。
   * ---------------------------------------------------------------- */
  const OverviewView = (props: { data?: Record<string, unknown> }) => {
    const returnSessionID = () => (props.data?.returnSessionID as string | undefined) ?? undefined
    const [selected, setSelected] = createSignal<string | undefined>(undefined)
    // 行选中键 -> 行渲染体 id（滚动跟随）；行重渲时同键覆盖，不清理也不涨
    const rowRenderableIds = new Map<string, string>()
    let scrollBox: ScrollBoxRenderable | undefined

    /** 总览正文 = 全展开的 run 树（默认每棵都展开；override 折叠仍生效）。
     *  空板时正文为空——空态文案已由头部承担，不再重复渲染标题 */
    const bodyRows = createMemo(() =>
      runs().length === 0
        ? []
        : renderPanelRows(runs(), Date.now(), {
            collapseOverride: collapseOverride(),
            expandedRuns: Number.MAX_SAFE_INTEGER,
            maxWidth: 120,
          }),
    )
    const selectKeys = createMemo(() =>
      bodyRows()
        .map(rowSelectionKey)
        .filter((k): k is string => k !== undefined),
    )

    const move = (delta: number) => {
      const next = moveSelection(selectKeys(), selected(), delta)
      if (next === undefined || next === selected()) return
      setSelected(next)
      const childId = rowRenderableIds.get(next)
      if (childId !== undefined) scrollBox?.scrollChildIntoView(childId)
    }

    const selectedRow = () => bodyRows().find((r) => rowSelectionKey(r) === selected())

    const openSelected = () => {
      const row = selectedRow()
      if (row?.runId === undefined) return
      ctx.ui.router.navigate({
        type: "plugin",
        name: "node",
        data: {
          runId: row.runId,
          ...(row.stepName !== undefined ? { step: row.stepName } : {}),
          from: "overview",
          ...(returnSessionID() !== undefined ? { returnSessionID: returnSessionID() } : {}),
        },
      })
    }

    const back = () => {
      const sid = returnSessionID()
      ctx.ui.router.navigate(sid !== undefined ? { type: "session", sessionID: sid } : { type: "home" })
    }

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        { id: "agentic-workflow.overview.up", title: "Previous node", bind: "up", run: () => move(-1) },
        { id: "agentic-workflow.overview.up.k", bind: "k", run: () => move(-1) },
        { id: "agentic-workflow.overview.down", title: "Next node", bind: "down", run: () => move(1) },
        { id: "agentic-workflow.overview.down.j", bind: "j", run: () => move(1) },
        { id: "agentic-workflow.overview.open", title: "Open node detail", bind: "enter", run: () => openSelected() },
        { id: "agentic-workflow.overview.back", title: "Back", bind: "escape", run: () => back() },
        { id: "agentic-workflow.overview.back.q", bind: "q", run: () => back() },
      ],
      bindings: [
        "agentic-workflow.overview.up",
        "agentic-workflow.overview.up.k",
        "agentic-workflow.overview.down",
        "agentic-workflow.overview.down.j",
        "agentic-workflow.overview.open",
        "agentic-workflow.overview.back",
        "agentic-workflow.overview.back.q",
      ],
    }))

    const headerRows = () => renderOverviewHeaderRows(runs(), Date.now(), { maxWidth: 120 })

    return (
      <box
        position="absolute"
        left={0}
        top={0}
        width="100%"
        height="100%"
        flexDirection="column"
        backgroundColor={ctx.theme.background.base}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={2}
      >
        <box flexDirection="column">
          {headerRows().map((row, i) => (
            <RowText key={i} theme={ctx.theme} row={row} />
          ))}
        </box>
        <scrollbox
          flexGrow={1}
          flexDirection="column"
          ref={(el: ScrollBoxRenderable) => {
            scrollBox = el
          }}
        >
          {bodyRows().map((row) => {
            const key = rowSelectionKey(row)
            const isSelected = key !== undefined && key === selected()
            return (
              <box
                flexDirection="row"
                backgroundColor={isSelected ? ctx.theme.background.raised.base : undefined}
                onMouseDown={() => {
                  // 头行点击 = 折叠切换（与面板一致）；节点行点击 = 选中并进详情
                  if (row.collapsible === true) {
                    toggleCollapse(row)
                    return
                  }
                  if (key === undefined) return
                  setSelected(key)
                  openSelected()
                }}
                ref={(el: Renderable) => {
                  if (key !== undefined) rowRenderableIds.set(key, el.id)
                }}
              >
                <box width={2}>
                  <text fg={isSelected ? undefined : ctx.theme.text.muted}>{isSelected ? "▸ " : "  "}</text>
                </box>
                <RowText theme={ctx.theme} row={row} />
              </box>
            )
          })}
        </scrollbox>
        <box paddingTop={1}>
          <text fg={ctx.theme.text.muted}>j/k 上下选择 · Enter 节点详情 · Esc 返回</text>
        </box>
      </box>
    )
  }

  // plugin 路由注册：node 页（RowLine 点击导航至此）；overview 页（/workflow 进入）
  const offNodePage = ctx.ui.router?.register({
    name: "node",
    render: (input) => <NodeView data={input.data} />,
  })
  const offOverviewPage = ctx.ui.router?.register({
    name: "overview",
    render: (input) => <OverviewView data={input.data} />,
  })

  return () => {
    offEvent()
    offSlot()
    offFooter()
    offSidebar()
    offHomeFooter()
    offNodePage?.()
    offOverviewPage?.()
  }
}
