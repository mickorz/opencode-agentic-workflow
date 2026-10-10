/**
 * 进度面板视图模型（P2-8；v0.7.0 信息密度 + 主题色对齐 v1）
 *
 * 纯函数层：RunProgressSnapshot -> 结构化展示行（PanelRow：文本 + tone + 粗体）。
 * 无 solid 依赖——TUI 组件消费并按 ctx.theme 上色，单测直接断言行对象
 * （渲染逻辑的最小不可测面只剩 JSX 摆放与颜色映射）。
 *
 * v0.7.0（v1 TUI 对齐批次 A/B，见 dev-docs/research/v1-v2-TUI显示功能对比与补齐清单.md）：
 *   - 行模型 string[] -> PanelRow[]（tone 四档 + bold）
 *   - run 头行补 token 合计与 running 计数（v1 headerLine 对位）
 *   - 步骤行补 token 与模型后缀（数据面：快照 steps 透传 usage/model）
 *   - 新增 prompt.footer 状态条与 sidebar 紧凑树渲染器（v1 双 slot 对位）
 */

import type { RunProgressSnapshot } from "../observability/events.js"
import type { RunDetail } from "../state/recorder.js"

const RUN_GLYPHS: Record<string, string> = {
  running: "▶",
  completed: "✓",
  failed: "✗",
  aborted: "⏹",
}

const STEP_GLYPHS: Record<string, string> = {
  pending: "·",
  running: "▶",
  completed: "✓",
  failed: "✗",
  skipped: "–",
}

/** 语义色调四档 + 基础；tui.tsx 映射 ctx.theme（缺省 = 宿主默认前景色） */
export type PanelTone = "base" | "muted" | "success" | "warning" | "error"

/** 结构化展示行：text 必有；tone/bold 缺省即基础样式 */
export interface PanelRow {
  text: string
  tone?: PanelTone
  bold?: boolean
  /** 该行所属 run（折叠交互的归属键；头行 = 可折叠目标） */
  runId?: string
  /** 步骤行名（点击进入节点详情视图；subflow 步骤亦按步骤名查） */
  stepName?: string
  /** 可折叠 run 头行标记（TUI 层挂点击切换；行文本已带 ▶/▼ 指示） */
  collapsible?: boolean
  /** 本行当前是否处于折叠态（点击切换的目标态 = !collapsed） */
  collapsed?: boolean
}

export function runGlyph(status: string): string {
  return RUN_GLYPHS[status] ?? "?"
}

export function stepGlyph(status: string): string {
  return STEP_GLYPHS[status] ?? "?"
}

/** run/步骤状态 -> 语义色调（v1 四色对位：跑=warning 成=success 败=error 待=muted） */
export function statusTone(status: string): PanelTone {
  if (status === "completed") return "success"
  if (status === "running") return "warning"
  if (status === "failed" || status === "aborted") return "error"
  return "muted"
}

/** 毫秒 -> 人读时长（0s / 12.3s / 1m02s / 1h03m） */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
}

export interface StepViewModel {
  label: string
  glyph: string
  status: string
  tone: PanelTone
  duration?: string
  /** token 合计人读（usage 存在时） */
  tokens?: string
  /** 模型名（步骤内最后一次 agent 调用） */
  model?: string
  /** 成功/耗尽尝试号（v0.10.0；attemptsMax > 1 时展示 `(2/3)`） */
  attempt?: number
  attemptsMax?: number
  /** 单次尝试超时上限 ms（v0.10.0；时长展示 `10s/1m` 的分母） */
  timeoutMs?: number
}

export interface RunViewModel {
  title: string
  glyph: string
  status: string
  tone: PanelTone
  /** 完成用 completedAt-startedAt；进行中用 now-startedAt（随事件刷新） */
  duration: string
  /** 运行中步骤计数（v1 headerLine 的 N running 对位） */
  runningCount: number
  /** 全步骤 token 合计人读（有任何 usage 时） */
  tokensTotal?: string
  failure?: string
  steps: StepViewModel[]
}

/** token 三元组 -> 合计人读 */
function usageToTokens(usage: { input: number; output: number; reasoning: number }): number {
  return usage.input + usage.output + usage.reasoning
}

/** 单 run -> 视图模型（now 注入，测试可冻结时间） */
export function toRunViewModel(run: RunProgressSnapshot, now: number = Date.now()): RunViewModel {
  const end = run.completedAt ?? now
  let tokensSum = 0
  let anyUsage = false
  const steps = run.steps.map((step) => {
    const startedAt = step.startedAt
    const finishedAt = step.completedAt
    if (step.usage !== undefined) {
      anyUsage = true
      tokensSum += usageToTokens(step.usage)
    }
    return {
      label: step.name ?? `step ${step.index}`,
      glyph: stepGlyph(step.status),
      status: step.status,
      tone: statusTone(step.status),
      ...(startedAt !== undefined
        ? { duration: formatDuration((finishedAt ?? end) - startedAt) }
        : {}),
      ...(step.usage !== undefined ? { tokens: formatTokens(usageToTokens(step.usage)) } : {}),
      ...(step.model !== undefined ? { model: step.model } : {}),
      ...(step.attempt !== undefined ? { attempt: step.attempt } : {}),
      ...(step.attemptsMax !== undefined ? { attemptsMax: step.attemptsMax } : {}),
      ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
    }
  })
  return {
    title: `${run.workflow.id}@${run.workflow.version}`,
    glyph: runGlyph(run.status),
    status: run.status,
    tone: statusTone(run.status),
    duration: formatDuration(Math.max(0, end - run.startedAt)),
    // 终态 run 不再宣称 running（recorder 不回写步骤状态；停表语义对齐时长冻结）
    runningCount:
      run.status === "running" ? steps.filter((s) => s.status === "running").length : 0,
    ...(anyUsage ? { tokensTotal: formatTokens(tokensSum) } : {}),
    ...(run.failure !== undefined ? { failure: run.failure } : {}),
    steps,
  }
}

export interface PanelLinesOptions {
  /** 行宽上限（截断加 …）；默认不截断 */
  maxWidth?: number
  /** 展开全步骤树的 run 数（最新的在前）；默认 1（最新 run 展开） */
  expandedRuns?: number
  /**
   * 用户手动折叠态（runId -> collapsed；v1 点击折叠对位）。命中即覆盖
   * expandedRuns 的自动展开规则——点开更早的 run、折起最新 run 都靠它。
   */
  collapseOverride?: ReadonlyMap<string, boolean>
}

function truncate(text: string, maxWidth: number | undefined): string {
  if (maxWidth === undefined || text.length <= maxWidth) return text
  return `${text.slice(0, Math.max(1, maxWidth - 1))}…`
}

/** run 头行后缀：running 计数（v0.10.3 起 token 展示撤出面板行——用户决策） */
function runHeaderSuffix(vm: RunViewModel): string {
  const parts: string[] = []
  if (vm.runningCount > 0) parts.push(`${vm.runningCount} running`)
  return parts.length > 0 ? `  · ${parts.join(" · ")}` : ""
}

/** 步骤行后缀：模型（token 展示撤出面板行；数据仍在节点视图详情里） */
function stepMetaSuffix(step: StepViewModel): string {
  const parts: string[] = []
  if (step.model !== undefined) parts.push(step.model)
  return parts.length > 0 ? `  · ${parts.join(" · ")}` : ""
}

/** v0.10.0 重试进度 `(2/3)`：attemptsMax ≤ 1（未配置重试）时省略 */
function attemptSuffix(step: { attempt?: number; attemptsMax?: number }): string {
  if (step.attemptsMax === undefined || step.attemptsMax <= 1) return ""
  return ` (${step.attempt ?? 1}/${step.attemptsMax})`
}

/** v0.10.0 超时上限紧凑人读（整值配置 30s / 1m / 5m / 1h；非整值回落 formatDuration） */
function formatTimeoutCap(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return formatDuration(ms)
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds % 60 === 0 && seconds < 3600) return `${seconds / 60}m`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  return formatDuration(ms)
}

/** v0.10.0 时长带超时上限 `10s/1m`（elapsed/cap）；无上限时纯时长 */
function durationWithCap(duration: string | undefined, timeoutMs: number | undefined): string {
  if (duration === undefined) return ""
  return timeoutMs !== undefined
    ? `${duration}/${formatTimeoutCap(timeoutMs)}`
    : duration
}

/**
 * 整板 -> 结构化展示行（最新顶层 run 展开步骤树，其余收为一行摘要；
 * subflow 子 run 按 parentRunId 缩进挂在父 run 下，深度再加两格）。
 * 面板组件逐行渲染并按 tone 上色；单测直接断言行对象。
 *
 * v0.8.5 subflow 去重：legacy 流程的 `subflow:<id>` 父步骤行与子 run 行
 * 原本各渲染一次（同一事件两行、两组顺序）。现按步骤位置合并——步骤行
 * 被对应子 run 行取代（缩进与步骤同级），每个 subflow 只显示一次且随
 * journal 步骤序；子 run 不在板上时回退显示步骤行（防御种子/裁剪不一致）。
 */

/** legacy 适配层的 subflow 步骤名：`subflow:<id>` / `subflow:<id>(<label>)` */
const SUBFLOW_STEP_RE = /^subflow:([A-Za-z0-9_-]+)/

export function renderPanelRows(
  runs: readonly RunProgressSnapshot[],
  now: number = Date.now(),
  options?: PanelLinesOptions,
): PanelRow[] {
  if (runs.length === 0) {
    return [
      { text: "Agentic Workflow", bold: true },
      { text: "(no runs yet — start one with workflow_start)", tone: "muted" },
    ]
  }
  // P2-9 lineage：父子分组（父不在板上的孤儿按顶层渲染）
  const byId = new Set(runs.map((r) => r.runId))
  const childrenOf = new Map<string, RunProgressSnapshot[]>()
  const topLevels: RunProgressSnapshot[] = []
  for (const run of runs) {
    if (run.parentRunId !== undefined && byId.has(run.parentRunId)) {
      const list = childrenOf.get(run.parentRunId) ?? []
      list.push(run)
      childrenOf.set(run.parentRunId, list)
    } else {
      topLevels.push(run)
    }
  }

  const expanded = options?.expandedRuns ?? 1
  const rows: PanelRow[] = [{ text: "Agentic Workflow", bold: true }]

  /** 递归渲染一棵 run 树：本体 + 其 subflow 子孙（缩进随深度）
   *  indentOverride：被父步骤行合并内联的子 run 用步骤缩进（"  "） */
  const emitRun = (run: RunProgressSnapshot, topLevelIndex: number, indentOverride?: string): void => {
    const vm = toRunViewModel(run, now)
    const isTop = run.parentRunId === undefined
    const children = childrenOf.get(run.runId) ?? []
    if (isTop) {
      // 折叠态：用户 override 优先（点击切换），否则按 expandedRuns 自动
      const collapsed = options?.collapseOverride?.get(run.runId) ?? topLevelIndex >= expanded
      rows.push({
        text: truncate(
          `${collapsed ? "▶" : "▼"} ${vm.glyph} ${vm.title}  ${vm.duration}${runHeaderSuffix(vm)}`,
          options?.maxWidth,
        ),
        tone: vm.tone,
        bold: true,
        runId: run.runId,
        collapsible: true,
        collapsed,
      })
      if (!collapsed) {
        // subflow:<id> 步骤行与板上子 run 一一配对（同 id 按序消耗），
        // 配上的子 run 内联到步骤位置，步骤行不再重复渲染
        const pending = [...children]
        for (const step of vm.steps) {
          const match = SUBFLOW_STEP_RE.exec(step.label)
          if (match !== null) {
            const childIdx = pending.findIndex((c) => c.workflow.id === match[1])
            if (childIdx !== -1) {
              emitRun(pending.splice(childIdx, 1)[0]!, topLevelIndex, "  ")
              continue
            }
          }
          const duration = step.duration
            ? `  ${durationWithCap(step.duration, step.timeoutMs)}`
            : ""
          rows.push({
            text: truncate(
              `  ${step.glyph} ${step.label}${attemptSuffix(step)}${duration}${stepMetaSuffix(step)}`,
              options?.maxWidth,
            ),
            tone: step.tone,
            runId: run.runId,
            stepName: step.label,
          })
        }
        if (vm.failure) {
          rows.push({ text: truncate(`  ↳ ${vm.failure}`, options?.maxWidth), tone: "error", runId: run.runId })
        }
        // 未被步骤认领的子 run（防御：种子缺步骤/板上裁剪）照旧挂尾，不丢信息
        for (const child of pending) {
          emitRun(child, topLevelIndex)
        }
      }
    } else {
      const indent = indentOverride ?? "    ".repeat(Math.min(run.depth ?? 1, 3))
      const lineage = run.status === "running" ? " ⇢ subflow" : " · subflow"
      rows.push({
        text: truncate(
          `${indent}↳ ${vm.glyph} ${vm.title}  ${vm.duration}${lineage}`,
          options?.maxWidth,
        ),
        tone: vm.tone,
        // 子 run 行可点：进入该子 run 的 run 级节点视图（stepName 缺省）
        runId: run.runId,
      })
      if (vm.failure) {
        rows.push({ text: truncate(`${indent}  ↳ ${vm.failure}`, options?.maxWidth), tone: "error" })
      }
      for (const child of children) {
        emitRun(child, topLevelIndex)
      }
    }
  }

  topLevels.forEach((run, i) => emitRun(run, i))
  return rows
}

/**
 * prompt.footer 状态条（v0.7.0 批次 B，v1 session_prompt_right 对位）：
 * 每个运行中 run 一行紧凑摘要；无运行中 run 时整条不渲染。
 */
export function renderPromptFooterRows(runs: readonly RunProgressSnapshot[]): PanelRow[] {
  const rows: PanelRow[] = []
  for (const run of runs) {
    if (run.status !== "running") continue
    const total = run.steps.length
    const done = run.steps.filter((s) => s.status === "completed").length
    const running = run.steps.filter((s) => s.status === "running").length
    rows.push({
      text: `◐ ${run.workflow.id}@${run.workflow.version} ${done}/${total}${running > 0 ? ` · ${running} running` : ""}`,
      tone: "warning",
    })
  }
  return rows
}

/**
 * home.footer.status 常驻行（v0.7.1：宿主 2.0.26 的 sidebar/prompt.footer/
 * session.panel 均为会话作用域，主页唯一挂载点）：单行摘要，空板不渲染。
 * 运行中：`◐ N running · flow@ver`（warning）；否则最近一条 run 摘要（muted）。
 */
export function renderHomeFooterRows(runs: readonly RunProgressSnapshot[]): PanelRow[] {
  const newest = runs[0]
  if (newest === undefined) return []
  const running = runs.filter((r) => r.status === "running")
  if (running.length > 0) {
    return [
      {
        text: `◐ ${running.length} running · ${running[0]!.workflow.id}@${running[0]!.workflow.version}`,
        tone: "warning",
      },
    ]
  }
  return [
    {
      text: `${runGlyph(newest.status)} ${newest.workflow.id}@${newest.workflow.version} · ${newest.status}`,
      tone: "muted",
    },
  ]
}

/**
 * sidebar 紧凑树（v0.7.0 批次 B，v1 sidebar_content 对位）：
 * 与面板同源的行模型，窄宽度默认截断；行数预算防长侧栏。
 */
export function renderSidebarRows(
  runs: readonly RunProgressSnapshot[],
  now: number = Date.now(),
  options?: PanelLinesOptions & { maxRows?: number },
): PanelRow[] {
  const rows = renderPanelRows(runs, now, { maxWidth: options?.maxWidth ?? 40 })
  const maxRows = options?.maxRows ?? 12
  if (rows.length <= maxRows) return rows
  return [...rows.slice(0, maxRows), { text: `… +${rows.length - maxRows} 行（/workflow 开面板）`, tone: "muted" }]
}

/** TUI 侧详情缓存条目（runId + 预渲染行；key 仅供去重，不参与渲染） */
export interface DetailSection {
  runId: string
  rows: PanelRow[]
}

/** 详情区行：缓存的详情属于板上最新 run 时输出（头行分隔），否则空 */
export function renderDetailSection(
  runs: readonly RunProgressSnapshot[],
  detail: DetailSection | undefined,
): PanelRow[] {
  const newest = runs[0]
  if (!newest || !detail || detail.runId !== newest.runId || detail.rows.length === 0) {
    return []
  }
  return [{ text: "── detail", tone: "muted", bold: true }, ...detail.rows]
}

/** TUI 侧会话回放缓存条目（runId@step 去重键 + 预渲染行） */
export interface SessionSection {
  runId: string
  step: string
  rows: PanelRow[]
}

/** 会话回放区行：缓存属于板上最新 run 时输出（头行分隔），否则空 */
export function renderSessionSection(
  runs: readonly RunProgressSnapshot[],
  session: SessionSection | undefined,
): PanelRow[] {
  const newest = runs[0]
  if (!newest || !session || session.runId !== newest.runId || session.rows.length === 0) {
    return []
  }
  return [{ text: "── session", tone: "muted", bold: true }, ...session.rows]
}

/** 消息类型的行前缀（与面板既有图标语言一致：❯ 提问 / · 回答 / ↳ 其他） */
function sessionMessagePrefix(type: string): string {
  if (type === "user") return "❯ "
  if (type === "assistant") return "· "
  return "↳ "
}

/**
 * 回放载荷 -> 预渲染行：步骤头（步骤名 + 会话 ID）+ 逐消息折行块，
 * 总行数预算 maxLines（超出尾缀 …）。纯函数，单测覆盖。
 */
export function renderSessionRows(
  replay: {
    sessionID: string
    step?: string
    messages: ReadonlyArray<{ type: string; text: string }>
  },
  maxWidth?: number,
  maxLines = 24,
): PanelRow[] {
  const header = `${replay.step !== undefined ? `${replay.step} · ` : ""}${replay.sessionID}`
  const rows: PanelRow[] = [{ text: header, tone: "muted" }]
  for (const message of replay.messages) {
    if (rows.length >= maxLines) break
    const prefix = sessionMessagePrefix(message.type)
    const wrapped = wrapPreview(message.text, maxWidth, 3)
    for (let i = 0; i < wrapped.length && rows.length < maxLines; i++) {
      rows.push({
        text: i === 0 ? `${prefix}${wrapped[i]}` : `  ${wrapped[i]}`,
        // assistant 回答弱化；user/其他走默认前景（tone 缺省即 base）
        ...(message.type === "assistant" ? { tone: "muted" as const } : {}),
      })
    }
  }
  if (rows.length >= maxLines) rows.push({ text: "…", tone: "muted" })
  return rows
}

/** 单段预览 -> 折行块（宽度不定时按单行原样；超出行数截断加 …） */
function wrapPreview(
  text: string,
  maxWidth: number | undefined,
  maxLines: number,
): string[] {
  if (maxWidth === undefined || maxWidth < 8) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length && chunks.length < maxLines; i += maxWidth) {
    chunks.push(text.slice(i, i + maxWidth))
  }
  if (text.length > maxLines * maxWidth) {
    const last = chunks[chunks.length - 1] ?? ""
    chunks[chunks.length - 1] = `${last.slice(0, Math.max(1, maxWidth - 1))}…`
  }
  return chunks
}

/** token 数 -> 紧凑人读（123 / 1.2k / 15.3k） */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n)))
  return `${(n / 1000).toFixed(1)}k`
}

export interface DetailLinesOptions {
  /** 行宽上限（截断加 …）；默认不截断 */
  maxWidth?: number
  /** 每段预览最多折行数（默认 3） */
  maxPreviewLines?: number
}

/**
 * run 详情 -> 结构化展示行（P2-8b 节点详情）：头行（workflow@version · 状态 ·
 * 时长 + token/running 后缀）、runId/lineage、args 预览、逐步骤（状态 + 时长 +
 * token/模型 + 输出/错误预览折行）。纯函数，TUI 组件逐行渲染；单测直接断言。
 */
export function renderDetailRows(
  detail: RunDetail,
  now: number = Date.now(),
  options?: DetailLinesOptions,
): PanelRow[] {
  const maxWidth = options?.maxWidth
  const maxPreview = options?.maxPreviewLines ?? 3
  const duration =
    detail.completedAt !== undefined
      ? formatDuration(Math.max(0, detail.completedAt - detail.startedAt))
      : formatDuration(Math.max(0, now - detail.startedAt))
  const vm = toRunViewModel(
    {
      runId: detail.runId,
      workflow: detail.workflow,
      status: detail.status,
      startedAt: detail.startedAt,
      ...(detail.completedAt !== undefined ? { completedAt: detail.completedAt } : {}),
      steps: detail.steps,
    },
    now,
  )
  const rows: PanelRow[] = [
    {
      text: truncate(
        `${runGlyph(detail.status)} ${detail.workflow.id}@${detail.workflow.version} · ${detail.status} · ${duration}${runHeaderSuffix(vm)}`,
        maxWidth,
      ),
      tone: vm.tone,
      bold: true,
    },
  ]
  const meta = [detail.runId]
  if (detail.parentRunId !== undefined) {
    meta.push(`parent ${detail.parentRunId}`, `depth ${detail.depth ?? "?"}`)
  }
  rows.push({ text: truncate(`  ${meta.join(" · ")}`, maxWidth), tone: "muted" })
  if (detail.args !== undefined && detail.args !== "") {
    rows.push({ text: truncate(`  args ${detail.args}`, maxWidth), tone: "muted" })
  }
  for (const step of detail.steps) {
    const stepDuration =
      step.startedAt !== undefined
        ? `  ${formatDuration(Math.max(0, (step.completedAt ?? now) - step.startedAt))}`
        : ""
    // P2-8b 元数据后缀：模型（v0.10.3 token 撤出列表行；数据在节点视图详情）
    const meta: string[] = []
    if (step.model !== undefined) meta.push(step.model)
    const metaSuffix = meta.length > 0 ? `  · ${meta.join(" · ")}` : ""
    rows.push({
      text: truncate(
        `  ${stepGlyph(step.status)} ${step.name ?? `step ${step.index}`}${stepDuration}${metaSuffix}`,
        maxWidth,
      ),
      tone: statusTone(step.status),
    })
    // 预览折行宽度扣除缩进，保证整行不超 maxWidth（宽度不定时不折）
    const previewWidth =
      maxWidth === undefined ? undefined : Math.max(8, maxWidth - 4)
    if (step.error !== undefined && step.error !== "") {
      for (const line of wrapPreview(`✗ ${step.error}`, previewWidth, maxPreview)) {
        rows.push({ text: `    ${line}`, tone: "error" })
      }
    } else if (step.output !== undefined && step.output !== "") {
      for (const line of wrapPreview(`→ ${step.output}`, previewWidth, maxPreview)) {
        rows.push({ text: `    ${line}`, tone: "muted" })
      }
    }
  }
  if (detail.failure !== undefined && detail.failure !== "") {
    rows.push({ text: truncate(`  ↳ ${detail.failure}`, maxWidth), tone: "error" })
  }
  return rows
}

/* ------------------------------------------------------------------ *
 * 节点详情视图（v0.8.9，v1 NodeDetailView 对位）
 *
 * 点击面板步骤行 / 子 run 行进入（plugin 路由整页接管）：三段式 =
 * 状态头（label/状态/attempt 位预留）→ 元数据（model · 时长 · token）→
 * 正文（prompt 预览 + result + agent 会话消息回放）。纯函数出行，
 * JSX 层只做铺线 + 键位（Enter 开会话 / ←→ 切节点 / Esc 返回）。
 * ------------------------------------------------------------------ */

export interface NodeViewInput {
  /** 板上 live 快照（状态头/时长优先用它；不在板上时回落 detail） */
  run: RunProgressSnapshot | undefined
  /** journal 详情（step 载荷：input/output/error/usage/model/sessionIDs） */
  detail: RunDetail | undefined
  /** 步骤名；缺省 = run 级视图（workflow 概况 + 步骤清单） */
  step?: string
  /** agent 会话回放（该步骤的子会话消息） */
  replay?: { sessionID: string; messages: ReadonlyArray<{ type: string; text: string }> }
  /** 行宽（折行用）；缺省不折 */
  maxWidth?: number
}

/** 节点视图行模型（JSX 层铺线；tone/bold 语义与面板一致） */
export function renderNodeRows(input: NodeViewInput, now: number = Date.now()): PanelRow[] {
  const { run, detail, step, replay, maxWidth } = input
  const rows: PanelRow[] = []

  const pushMeta = (parts: ReadonlyArray<string | undefined>) => {
    const joined = parts.filter((p) => p !== undefined && p !== "").join(" · ")
    if (joined !== "") rows.push({ text: joined, tone: "muted" })
  }

  if (step !== undefined) {
    // ---- 步骤级节点 ----
    const liveStep = run?.steps.find((s) => s.name === step)
    const stepDetail = detail?.steps.find((s) => s.name === step)
    const status = liveStep?.status ?? stepDetail?.status ?? "running"
    const tone = statusTone(status)
    // v0.10.0 重试/超时元数据（live 快照与 journal 详情谁在用谁；两路同源不冲突）
    const attemptMeta = {
      attempt: stepDetail?.attempt ?? liveStep?.attempt,
      attemptsMax: stepDetail?.attemptsMax ?? liveStep?.attemptsMax,
      timeoutMs: stepDetail?.timeoutMs ?? liveStep?.timeoutMs,
    }
    rows.push({
      text: `${stepGlyph(status)} ${step}  ${status}${attemptSuffix(attemptMeta)}`,
      tone,
      bold: true,
    })

    // 元数据：model · 时长（带上限 10s/1m）——token 展示已全面撤出 TUI（v0.10.4）
    const started = liveStep?.startedAt ?? stepDetail?.startedAt
    const finished = liveStep?.completedAt ?? stepDetail?.completedAt
    pushMeta([
      stepDetail?.model,
      started !== undefined
        ? durationWithCap(
            formatDuration(Math.max(0, (finished ?? now) - started)),
            attemptMeta.timeoutMs,
          )
        : undefined,
    ])

    // 标识符：run · workflow · 会话数
    const sessions = stepDetail?.sessionIDs
    pushMeta([
      `run ${detail?.runId ?? run?.runId ?? "-"}`,
      detail !== undefined ? `${detail.workflow.id}@${detail.workflow.version}` : undefined,
      sessions !== undefined ? `${sessions.length} session(s)` : undefined,
    ])

    // prompt 预览
    if (stepDetail?.input !== undefined && stepDetail.input !== "") {
      rows.push({ text: "", tone: "muted" })
      for (const line of wrapPreview(`prompt: ${stepDetail.input}`, maxWidth, 6)) {
        rows.push({ text: line, tone: "muted" })
      }
    }

    // result 正文：error / output / running / empty 四态
    rows.push({ text: "", tone: "muted" })
    if (stepDetail?.error !== undefined && stepDetail.error !== "") {
      for (const line of wrapPreview(`Error: ${stepDetail.error}`, maxWidth, 12)) {
        rows.push({ text: line, tone: "error" })
      }
    } else if (stepDetail?.output !== undefined && stepDetail.output !== "") {
      for (const line of wrapPreview(stepDetail.output, maxWidth, 24)) {
        rows.push({ text: line })
      }
    } else if (status === "running" || started === undefined) {
      rows.push({ text: "No result yet", tone: "warning" })
    } else {
      rows.push({ text: "No result returned", tone: "muted" })
    }

    // agent 会话回放
    if (replay !== undefined && replay.messages.length > 0) {
      rows.push({ text: "", tone: "muted" })
      rows.push(...renderSessionRows({ ...replay, step }, maxWidth, 40))
    }

    rows.push({
      text: sessions !== undefined && sessions.length > 0
        ? "Enter Open Session · ←/→ 切换节点 · Esc 返回"
        : "←/→ 切换节点 · Esc 返回",
      tone: "muted",
    })
    return rows
  }

  // ---- run 级节点（点击子 run 行 / run 头行区域进入）----
  const workflow = detail?.workflow ?? run?.workflow
  const status = detail?.status ?? run?.status ?? "running"
  const tone = statusTone(status)
  const started = detail?.startedAt ?? run?.startedAt
  const finished = detail?.completedAt ?? run?.completedAt
  const stepRows = detail?.steps ?? []
  const done = stepRows.filter((s) => s.status === "completed").length
  rows.push({
    text: `${RUN_GLYPHS[status] ?? "▶"} ${workflow ? `${workflow.id}@${workflow.version}` : "-"}  ${status}`,
    tone,
    bold: true,
  })
  pushMeta([
    started !== undefined ? formatDuration(Math.max(0, (finished ?? now) - started)) : undefined,
    stepRows.length > 0 ? `${done}/${stepRows.length} steps` : undefined,
  ])
  pushMeta([`run ${detail?.runId ?? run?.runId ?? "-"}`])

  if (detail?.args !== undefined && detail.args !== "") {
    rows.push({ text: "", tone: "muted" })
    for (const line of wrapPreview(`args: ${detail.args}`, maxWidth, 6)) {
      rows.push({ text: line, tone: "muted" })
    }
  }

  rows.push({ text: "", tone: "muted" })
  for (const s of stepRows) {
    const sStarted = s.startedAt
    const sFinished = s.completedAt
    rows.push({
      text: `  ${stepGlyph(s.status)} ${s.name ?? `step ${s.index}`}${attemptSuffix(s)}${
        sStarted !== undefined
          ? `  ${durationWithCap(
              formatDuration(Math.max(0, (sFinished ?? finished ?? now) - sStarted)),
              s.timeoutMs,
            )}`
          : ""
      }`,
      tone: statusTone(s.status),
    })
  }
  if (detail?.failure !== undefined && detail.failure !== "") {
    rows.push({ text: `  ↳ ${detail.failure}`, tone: "error" })
  }
  if (stepRows.length === 0 && (detail === undefined || run === undefined)) {
    rows.push({ text: "找不到该节点的数据（快照与 journal 均无记录）", tone: "muted" })
  }

  // run 级视图：←/→ 从这里可直接进步骤节点（switchStep 无当前步骤时取首/尾）；
  // Enter 仅在步骤级视图有意义（打开该步骤的 agent 会话）
  rows.push({ text: "←/→ 进步骤节点 · Esc 返回", tone: "muted" })
  return rows
}

/* ------------------------------------------------------------------ *
 * 全屏总览（v0.8.10，批次 C 收尾；v1 RouteView 对位）
 *
 * /workflow 进整页：头部摘要条（run 数 + 状态 chips）+ 全 run 平铺树
 * （默认全展开，共享面板的折叠态），j/k 回绕选节点行、Enter 进节点详情、
 * Esc 返回。选中行模型出自纯函数层，JSX 只做高亮与滚动跟随。
 * ------------------------------------------------------------------ */

/** 总览头部行：标题行 + run chips 行（超预算截断；空板给出占位提示） */
export function renderOverviewHeaderRows(
  runs: readonly RunProgressSnapshot[],
  now: number = Date.now(),
  options?: PanelLinesOptions & { maxChips?: number },
): PanelRow[] {
  if (runs.length === 0) {
    return [
      { text: "Agentic Workflow", bold: true },
      { text: "(no runs yet — start one with workflow_start)", tone: "muted" },
    ]
  }
  const running = runs.filter((r) => r.status === "running").length
  const title = `Workflow · ${runs.length} 个 run${running > 0 ? ` · ${running} running` : ""}`

  const maxChips = options?.maxChips ?? 6
  const chips: string[] = []
  for (const [i, run] of runs.entries()) {
    if (chips.length >= maxChips) {
      chips.push(`… +${runs.length - maxChips}`)
      break
    }
    const vm = toRunViewModel(run, now)
    const done = vm.steps.filter((s) => s.status === "completed").length
    const failed = vm.steps.filter((s) => s.status === "failed").length
    const parts = [`${vm.glyph} ${vm.title} ${done}/${vm.steps.length}`]
    if (vm.runningCount > 0) parts.push(`${vm.runningCount} running`)
    if (failed > 0) parts.push(`${failed} failed`)
    chips.push(`${i === 0 ? "" : " "}${parts.join(" · ")}`)
  }
  return [
    { text: title, bold: true },
    { text: truncate(chips.join(""), options?.maxWidth), tone: "muted" },
  ]
}

/**
 * 行 -> 选中键（跨树唯一，展示序即导航序）：步骤行 / 子 run 行可选中；
 * 折叠头行与结构行不可（v1 语义：只有 node 行参与 j/k 导航）。
 */
export function rowSelectionKey(row: PanelRow): string | undefined {
  if (row.collapsible === true) return undefined
  if (row.runId === undefined) return undefined
  if (row.stepName !== undefined) return `${row.runId}|step:${row.stepName}`
  return `${row.runId}|run`
}

/** 选中键序列内回绕移动（v1 moveSelection 对位）：越界回绕；当前键不在
 *  序列（数据更新/初进）时按方向取首/尾；空序列保持 undefined */
export function moveSelection(
  keys: readonly string[],
  current: string | undefined,
  delta: number,
): string | undefined {
  if (keys.length === 0) return undefined
  const index = current !== undefined ? keys.indexOf(current) : -1
  if (index === -1) return delta >= 0 ? keys[0] : keys[keys.length - 1]
  return keys[(index + delta + keys.length) % keys.length]
}
