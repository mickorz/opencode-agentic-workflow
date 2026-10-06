/**
 * 进度面板视图模型（P2-8）
 *
 * 纯函数层：RunProgressSnapshot -> 展示行。无 solid 依赖——
 * TUI 组件消费，单测直接断言（渲染逻辑的最小不可测面只剩 JSX 摆放）。
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

export function runGlyph(status: string): string {
  return RUN_GLYPHS[status] ?? "?"
}

export function stepGlyph(status: string): string {
  return STEP_GLYPHS[status] ?? "?"
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
  duration?: string
}

export interface RunViewModel {
  title: string
  glyph: string
  status: string
  /** 完成用 completedAt-startedAt；进行中用 now-startedAt（随事件刷新） */
  duration: string
  failure?: string
  steps: StepViewModel[]
}

/** 单 run -> 视图模型（now 注入，测试可冻结时间） */
export function toRunViewModel(run: RunProgressSnapshot, now: number = Date.now()): RunViewModel {
  const end = run.completedAt ?? now
  const steps = run.steps.map((step) => {
    const startedAt = step.startedAt
    const finishedAt = step.completedAt
    return {
      label: step.name ?? `step ${step.index}`,
      glyph: stepGlyph(step.status),
      status: step.status,
      ...(startedAt !== undefined
        ? { duration: formatDuration((finishedAt ?? end) - startedAt) }
        : {}),
    }
  })
  return {
    title: `${run.workflow.id}@${run.workflow.version}`,
    glyph: runGlyph(run.status),
    status: run.status,
    duration: formatDuration(Math.max(0, end - run.startedAt)),
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

function truncate(line: string, maxWidth: number | undefined): string {
  if (maxWidth === undefined || line.length <= maxWidth) return line
  return `${line.slice(0, Math.max(1, maxWidth - 1))}…`
}

/**
 * 整板 -> 展示行（最新顶层 run 展开步骤树，其余收为一行摘要；
 * subflow 子 run 按 parentRunId 缩进挂在父 run 下，深度再加两格）。
 * 面板组件逐行渲染；单测直接断言行内容。
 */
export function renderPanelLines(
  runs: readonly RunProgressSnapshot[],
  now: number = Date.now(),
  options?: PanelLinesOptions,
): string[] {
  if (runs.length === 0) {
    return ["Agentic Workflow", "(no runs yet — start one with workflow_start)"]
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
  const lines: string[] = ["Agentic Workflow"]

  /** 递归渲染一棵 run 树：本体 + 其 subflow 子孙（缩进随深度） */
  const emitRun = (run: RunProgressSnapshot, topLevelIndex: number): void => {
    const vm = toRunViewModel(run, now)
    const isTop = run.parentRunId === undefined
    if (isTop) {
      lines.push(truncate(`${vm.glyph} ${vm.title}  ${vm.duration}`, options?.maxWidth))
      if (topLevelIndex < expanded) {
        for (const step of vm.steps) {
          const duration = step.duration ? `  ${step.duration}` : ""
          lines.push(truncate(`  ${step.glyph} ${step.label}${duration}`, options?.maxWidth))
        }
        if (vm.failure) {
          lines.push(truncate(`  ↳ ${vm.failure}`, options?.maxWidth))
        }
      }
    } else {
      const indent = "    ".repeat(Math.min(run.depth ?? 1, 3))
      const lineage = run.status === "running" ? " ⇢ subflow" : " · subflow"
      lines.push(
        truncate(
          `${indent}↳ ${vm.glyph} ${vm.title}  ${vm.duration}${lineage}`,
          options?.maxWidth,
        ),
      )
      if (vm.failure) {
        lines.push(truncate(`${indent}  ↳ ${vm.failure}`, options?.maxWidth))
      }
    }
    for (const child of childrenOf.get(run.runId) ?? []) {
      emitRun(child, topLevelIndex)
    }
  }

  topLevels.forEach((run, i) => emitRun(run, i))
  return lines
}

/** TUI 侧详情缓存条目（runId + 预渲染行；key 仅供去重，不参与渲染） */
export interface DetailSection {
  runId: string
  lines: string[]
}

/** 详情区行：缓存的详情属于板上最新 run 时输出（头行分隔），否则空 */
export function renderDetailSection(
  runs: readonly RunProgressSnapshot[],
  detail: DetailSection | undefined,
): string[] {
  const newest = runs[0]
  if (!newest || !detail || detail.runId !== newest.runId || detail.lines.length === 0) {
    return []
  }
  return ["── detail", ...detail.lines]
}

/** TUI 侧会话回放缓存条目（runId@step 去重键 + 预渲染行） */
export interface SessionSection {
  runId: string
  step: string
  lines: string[]
}

/** 会话回放区行：缓存属于板上最新 run 时输出（头行分隔），否则空 */
export function renderSessionSection(
  runs: readonly RunProgressSnapshot[],
  session: SessionSection | undefined,
): string[] {
  const newest = runs[0]
  if (!newest || !session || session.runId !== newest.runId || session.lines.length === 0) {
    return []
  }
  return ["── session", ...session.lines]
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
export function renderSessionLines(
  replay: {
    sessionID: string
    step?: string
    messages: ReadonlyArray<{ type: string; text: string }>
  },
  maxWidth?: number,
  maxLines = 24,
): string[] {
  const header = `${replay.step !== undefined ? `${replay.step} · ` : ""}${replay.sessionID}`
  const lines: string[] = [header]
  for (const message of replay.messages) {
    if (lines.length >= maxLines) break
    const prefix = sessionMessagePrefix(message.type)
    const wrapped = wrapPreview(message.text, maxWidth, 3)
    for (let i = 0; i < wrapped.length && lines.length < maxLines; i++) {
      lines.push(i === 0 ? `${prefix}${wrapped[i]}` : `  ${wrapped[i]}`)
    }
  }
  if (lines.length >= maxLines) lines.push("…")
  return lines
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
 * run 详情 -> 展示行（P2-8b 节点详情）：头行（workflow@version · 状态 · 时长）、
 * runId/lineage、args 预览、逐步骤（状态 + 时长 + 输出/错误预览折行）。
 * 纯函数，TUI 组件逐行渲染；单测直接断言行内容。
 */
export function renderDetailLines(
  detail: RunDetail,
  now: number = Date.now(),
  options?: DetailLinesOptions,
): string[] {
  const maxWidth = options?.maxWidth
  const maxPreview = options?.maxPreviewLines ?? 3
  const duration =
    detail.completedAt !== undefined
      ? formatDuration(Math.max(0, detail.completedAt - detail.startedAt))
      : formatDuration(Math.max(0, now - detail.startedAt))
  const lines: string[] = [
    truncate(
      `${runGlyph(detail.status)} ${detail.workflow.id}@${detail.workflow.version} · ${detail.status} · ${duration}`,
      maxWidth,
    ),
  ]
  const meta = [detail.runId]
  if (detail.parentRunId !== undefined) {
    meta.push(`parent ${detail.parentRunId}`, `depth ${detail.depth ?? "?"}`)
  }
  lines.push(truncate(`  ${meta.join(" · ")}`, maxWidth))
  if (detail.args !== undefined && detail.args !== "") {
    lines.push(truncate(`  args ${detail.args}`, maxWidth))
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
      const total = step.usage.input + step.usage.output + step.usage.reasoning
      meta.push(`${formatTokens(total)} tok`)
    }
    if (step.model !== undefined) meta.push(step.model)
    const metaSuffix = meta.length > 0 ? `  · ${meta.join(" · ")}` : ""
    lines.push(
      truncate(
        `  ${stepGlyph(step.status)} ${step.name ?? `step ${step.index}`}${stepDuration}${metaSuffix}`,
        maxWidth,
      ),
    )
    // 预览折行宽度扣除缩进，保证整行不超 maxWidth（宽度不定时不折）
    const previewWidth =
      maxWidth === undefined ? undefined : Math.max(8, maxWidth - 4)
    if (step.error !== undefined && step.error !== "") {
      for (const line of wrapPreview(`✗ ${step.error}`, previewWidth, maxPreview)) {
        lines.push(`    ${line}`)
      }
    } else if (step.output !== undefined && step.output !== "") {
      for (const line of wrapPreview(`→ ${step.output}`, previewWidth, maxPreview)) {
        lines.push(`    ${line}`)
      }
    }
  }
  if (detail.failure !== undefined && detail.failure !== "") {
    lines.push(truncate(`  ↳ ${detail.failure}`, maxWidth))
  }
  return lines
}
