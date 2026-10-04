/**
 * 进度面板视图模型（P2-8）
 *
 * 纯函数层：RunProgressSnapshot -> 展示行。无 solid 依赖——
 * TUI 组件消费，单测直接断言（渲染逻辑的最小不可测面只剩 JSX 摆放）。
 */

import type { RunProgressSnapshot } from "../observability/events.js"

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
