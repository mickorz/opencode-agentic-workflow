/**
 * workflow_control 编排（v1-parity P1-3：后台运行 + run 控制）
 *
 * journal 是唯一事实源：
 *   - status：listRuns（全量倒序）/ getRun（单 run 详情：步骤进度、output、failure）
 *   - stop：活着的 run 请求协作式取消（下一步骤边界生效）；孤儿 run
 *     （journal 里 running 但本进程无活体——进程重启后的悬置）直接收口 aborted
 *
 * 纪律：Core 侧逻辑，禁止 import OpenCode API（架构不变量）。
 */

import type { WorkflowRun } from "../state/journal.js"
import { RunJournal } from "../state/recorder.js"
import type { ExecutionStore } from "../state/store.js"
import { isLive, requestCancel } from "../registry/run-control.js"

function stepProgress(run: WorkflowRun): string {
  const done = run.steps.filter((s) => s.status === "completed").length
  return `${done}/${run.steps.length}`
}

function fmtDuration(run: WorkflowRun): string {
  if (!run.completedAt) return "…"
  return `${((run.completedAt - run.startedAt) / 1000).toFixed(1)}s`
}

export function formatRunList(runs: WorkflowRun[]): string {
  if (runs.length === 0) {
    return "no runs recorded in this journalDir yet"
  }
  const lines = runs.map(
    (run) =>
      `[${run.runId}] ${run.workflow.id}@${run.workflow.version} ${run.status} ` +
      `steps=${stepProgress(run)} started=${new Date(run.startedAt).toISOString()}`,
  )
  return (
    `${runs.length} run(s), newest first:\n` +
    lines.join("\n") +
    `\ndetail: workflow_control action=status, runId=<one of the above>`
  )
}

export function formatRunDetail(run: WorkflowRun): string {
  const steps = run.steps
    .map((s) => `  - [${s.status}] ${s.name ?? `step#${s.index}`}`)
    .join("\n")
  const parts = [
    `[${run.runId}] ${run.workflow.id}@${run.workflow.version}`,
    `status: ${run.status}  steps=${stepProgress(run)}  duration=${fmtDuration(run)}`,
    `args: ${JSON.stringify(run.args)}`,
    steps,
  ]
  if (run.status === "completed" && typeof run.steps[run.steps.length - 1]?.output === "string") {
    parts.push(`output:\n${run.steps[run.steps.length - 1]?.output}`)
  } else if (run.failure) {
    parts.push(`failure: ${run.failure.message}`)
  }
  if (run.status === "aborted") {
    parts.push(`(aborted run can be resumed: workflow tool resumeRunId="${run.runId}")`)
  }
  return parts.join("\n")
}

export async function controlStatus(store: ExecutionStore, runId?: string): Promise<string> {
  if (runId && runId.length > 0) {
    const run = await store.getRun(runId)
    if (!run) {
      return `[agentic-workflow] run not found: ${runId} (check journalDir; inline runs have no journal)`
    }
    return formatRunDetail(run)
  }
  return formatRunList(await store.listRuns())
}

export async function controlStop(store: ExecutionStore, runId: string): Promise<string> {
  const run = await store.getRun(runId)
  if (!run) {
    return `[agentic-workflow] run not found: ${runId} (check journalDir; inline runs have no journal)`
  }
  if (run.status !== "running") {
    return `[agentic-workflow] ${runId} is already ${run.status} - nothing to stop`
  }
  if (isLive(runId)) {
    // 活体：协作式取消——正在执行的 LLM 调用不打断，下一步骤边界收口 aborted
    requestCancel(runId)
    return (
      `[agentic-workflow] stop requested for ${runId} ` +
      `(${run.workflow.id}@${run.workflow.version}, steps=${stepProgress(run)}): ` +
      `takes effect at the next step boundary (cooperative). ` +
      `Poll workflow_control action=status runId=${runId} until it shows aborted`
    )
  }
  // 孤儿：journal 里 running 但本进程无活体（进程重启后的悬置）→ 直接收口
  const journal = await RunJournal.attach(store, runId)
  await journal?.abort(
    new Error("aborted via workflow_control (orphaned run: running on disk, not alive in this process)"),
  )
  return (
    `[agentic-workflow] ${runId} was orphaned (running on disk, not alive in this process) ` +
    `- journal marked aborted. Resume later with resumeRunId="${runId}" if needed`
  )
}
