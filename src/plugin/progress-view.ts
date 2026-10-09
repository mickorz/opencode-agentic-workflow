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
}

function truncate(text: string, maxWidth: number | undefined): string {
  if (maxWidth === undefined || text.length <= maxWidth) return text
  return `${text.slice(0, Math.max(1, maxWidth - 1))}…`
}

/** run 头行后缀：running 计数 + token 合计（v1 headerLine 信息密度对位） */
function runHeaderSuffix(vm: RunViewModel): string {
  const parts: string[] = []
  if (vm.runningCount > 0) parts.push(`${vm.runningCount} running`)
  if (vm.tokensTotal !== undefined) parts.push(`${vm.tokensTotal} tok`)
  return parts.length > 0 ? `  · ${parts.join(" · ")}` : ""
}

/** 步骤行后缀：token + 模型（与 detail 区同款分隔风格） */
function stepMetaSuffix(step: StepViewModel): string {
  const parts: string[] = []
  if (step.tokens !== undefined) parts.push(`${step.tokens} tok`)
  if (step.model !== undefined) parts.push(step.model)
  return parts.length > 0 ? `  · ${parts.join(" · ")}` : ""
}

/**
 * 整板 -> 结构化展示行（最新顶层 run 展开步骤树，其余收为一行摘要；
 * subflow 子 run 按 parentRunId 缩进挂在父 run 下，深度再加两格）。
 * 面板组件逐行渲染并按 tone 上色；单测直接断言行对象。
 */
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

  /** 递归渲染一棵 run 树：本体 + 其 subflow 子孙（缩进随深度） */
  const emitRun = (run: RunProgressSnapshot, topLevelIndex: number): void => {
    const vm = toRunViewModel(run, now)
    const isTop = run.parentRunId === undefined
    if (isTop) {
      rows.push({
        text: truncate(`${vm.glyph} ${vm.title}  ${vm.duration}${runHeaderSuffix(vm)}`, options?.maxWidth),
        tone: vm.tone,
        bold: true,
      })
      if (topLevelIndex < expanded) {
        for (const step of vm.steps) {
          const duration = step.duration ? `  ${step.duration}` : ""
          rows.push({
            text: truncate(`  ${step.glyph} ${step.label}${duration}${stepMetaSuffix(step)}`, options?.maxWidth),
            tone: step.tone,
          })
        }
        if (vm.failure) {
          rows.push({ text: truncate(`  ↳ ${vm.failure}`, options?.maxWidth), tone: "error" })
        }
      }
    } else {
      const indent = "    ".repeat(Math.min(run.depth ?? 1, 3))
      const lineage = run.status === "running" ? " ⇢ subflow" : " · subflow"
      rows.push({
        text: truncate(
          `${indent}↳ ${vm.glyph} ${vm.title}  ${vm.duration}${lineage}`,
          options?.maxWidth,
        ),
        tone: vm.tone,
      })
      if (vm.failure) {
        rows.push({ text: truncate(`${indent}  ↳ ${vm.failure}`, options?.maxWidth), tone: "error" })
      }
    }
    for (const child of childrenOf.get(run.runId) ?? []) {
      emitRun(child, topLevelIndex)
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
    // P2-8b 元数据后缀：模型 + token 合计（input+output+reasoning；reasoning
    // 已含于 output 时宿主报 0，不会重复计）
    const meta: string[] = []
    if (step.usage !== undefined) {
      meta.push(`${formatTokens(usageToTokens(step.usage))} tok`)
    }
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
