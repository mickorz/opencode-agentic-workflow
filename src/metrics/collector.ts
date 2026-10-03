/**
 * MetricsCollector（P2.6）—— 纯事件总线消费者
 *
 *   EventBus ─→ MetricsCollector ─→ snapshot（内存聚合，随时可查）
 *
 * 设计约束（与 P2.4 一脉相承）：
 *   - 零侵入：不改动 agent()/sequence()/verify() 等原语的任何逻辑，
 *     只订阅事件流；token/cost 经 agent.completed 事件透传（数据源是
 *     宿主 executor 提取的 AgentResult.usage/costUSD）。
 *   - 只聚合、不采样：计数与求和，不保存明细（明细在 journal/trace）。
 *   - 按 workflowId / 模型维度聚合；单 run 的明细数据以 journal 为准
 *     （journal 有每步时间戳与状态，run 级 rollup 未来可由 store 派生）。
 */

import path from "node:path"
import { promises as fs } from "node:fs"

import { getEventBus, type EventBus, type WorkflowEvent } from "../observability/events.js"
import type { TokenUsage } from "../runtime/executor.js"

export interface DurationStats {
  count: number
  totalMs: number
  minMs: number
  maxMs: number
  lastMs: number
}

export interface TokenTotals {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelStats {
  calls: number
  tokens: TokenTotals
  costUSD: number
}

export interface WorkflowStats {
  started: number
  completed: number
  failed: number
  duration: DurationStats
}

export interface MetricsSnapshot {
  /** 开始收集的时间（epoch ms） */
  since: number
  /** 最近一次事件时间（epoch ms） */
  updatedAt: number
  agents: {
    calls: number
    failed: number
    duration: DurationStats
    tokens: TokenTotals
    costUSD: number
    /** key = "providerID/modelId" */
    byModel: Record<string, ModelStats>
  }
  /** key = workflowId */
  workflows: Record<string, WorkflowStats>
  steps: { completed: number; failed: number; totalMs: number }
  checks: { total: number; passed: number }
  verifies: { total: number; passed: number; reviewerPassed: number; reviewerTotal: number }
  checkpoints: { waiting: number; approved: number; rejected: number }
}

function emptyDuration(): DurationStats {
  return { count: 0, totalMs: 0, minMs: Number.POSITIVE_INFINITY, maxMs: 0, lastMs: 0 }
}

function recordDuration(stats: DurationStats, ms: number): void {
  stats.count += 1
  stats.totalMs += ms
  stats.minMs = Math.min(stats.minMs, ms)
  stats.maxMs = Math.max(stats.maxMs, ms)
  stats.lastMs = ms
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

function addTokens(target: TokenTotals, usage: TokenUsage): void {
  target.input += usage.input
  target.output += usage.output
  target.reasoning += usage.reasoning
  target.cacheRead += usage.cache.read
  target.cacheWrite += usage.cache.write
}

function emptySnapshot(): MetricsSnapshot {
  return {
    since: Date.now(),
    updatedAt: 0,
    agents: {
      calls: 0,
      failed: 0,
      duration: emptyDuration(),
      tokens: emptyTokens(),
      costUSD: 0,
      byModel: {},
    },
    workflows: {},
    steps: { completed: 0, failed: 0, totalMs: 0 },
    checks: { total: 0, passed: 0 },
    verifies: { total: 0, passed: 0, reviewerPassed: 0, reviewerTotal: 0 },
    checkpoints: { waiting: 0, approved: 0, rejected: 0 },
  }
}

export class MetricsCollector {
  private readonly bus: EventBus
  private readonly unsubscribe: () => void
  private state = emptySnapshot()

  /** 订阅指定 bus（缺省全局 bus） */
  constructor(bus: EventBus = getEventBus()) {
    this.bus = bus
    this.unsubscribe = bus.subscribe((event) => this.handle(event))
  }

  private workflowStats(id: string): WorkflowStats {
    let stats = this.state.workflows[id]
    if (!stats) {
      stats = { started: 0, completed: 0, failed: 0, duration: emptyDuration() }
      this.state.workflows[id] = stats
    }
    return stats
  }

  private handle(event: WorkflowEvent): void {
    const s = this.state
    s.updatedAt = event.time

    switch (event.type) {
      case "agent.started":
        break
      case "agent.completed": {
        s.agents.calls += 1
        recordDuration(s.agents.duration, event.durationMs)
        if (event.usage) addTokens(s.agents.tokens, event.usage)
        if (typeof event.costUSD === "number") s.agents.costUSD += event.costUSD
        if (event.model || event.usage) {
          const key = event.model ?? "(unknown)"
          let model = s.agents.byModel[key]
          if (!model) {
            model = { calls: 0, tokens: emptyTokens(), costUSD: 0 }
            s.agents.byModel[key] = model
          }
          model.calls += 1
          if (event.usage) addTokens(model.tokens, event.usage)
          if (typeof event.costUSD === "number") model.costUSD += event.costUSD
        }
        break
      }
      case "agent.failed":
        s.agents.failed += 1
        break
      case "workflow.started": {
        const wf = this.workflowStats(event.workflowId)
        wf.started += 1
        break
      }
      case "workflow.completed": {
        const wf = this.workflowStats(event.workflowId)
        wf.completed += 1
        recordDuration(wf.duration, event.durationMs)
        break
      }
      case "workflow.failed": {
        const wf = this.workflowStats(event.workflowId)
        wf.failed += 1
        break
      }
      case "step.completed":
        s.steps.completed += 1
        s.steps.totalMs += event.durationMs
        break
      case "step.failed":
        s.steps.failed += 1
        break
      case "check.completed":
        s.checks.total += 1
        if (event.ok) s.checks.passed += 1
        break
      case "verify.completed":
        s.verifies.total += 1
        if (event.passed) s.verifies.passed += 1
        s.verifies.reviewerPassed += event.passedCount
        s.verifies.reviewerTotal += event.totalCount
        break
      case "checkpoint.waiting":
        s.checkpoints.waiting += 1
        break
      case "checkpoint.completed":
        if (event.approved) s.checkpoints.approved += 1
        else s.checkpoints.rejected += 1
        break
      default:
        break
    }
  }

  /** 当前聚合快照（深拷贝，调用方修改不影响内部状态） */
  snapshot(): MetricsSnapshot {
    return JSON.parse(JSON.stringify(this.state)) as MetricsSnapshot
  }

  /** 清零重新收集 */
  reset(): void {
    this.state = emptySnapshot()
  }

  /** 停止订阅 */
  dispose(): void {
    this.unsubscribe()
  }

  /**
   * 快照落盘：workflow 结束（completed/failed）时把当前聚合写到 <file>。
   * 写失败只记录日志，绝不影响 workflow（观测设施不能成为故障源）。
   */
  subscribeFileSink(file: string): void {
    this.bus.subscribe((event) => {
      if (event.type !== "workflow.completed" && event.type !== "workflow.failed") return
      const snapshot = this.snapshot()
      void (async () => {
        try {
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(
            file,
            JSON.stringify({ ...snapshot, writtenAt: Date.now() }, null, 2),
            "utf8",
          )
        } catch (error) {
          console.log(
            `[agentic-workflow] metrics sink write failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })()
    })
  }
}

function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}min`
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${ms}ms`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtDurationLine(d: DurationStats): string {
  if (d.count === 0) return "n/a"
  const min = Number.isFinite(d.minMs) ? fmtMs(d.minMs) : "-"
  return `avg ${fmtMs(Math.round(d.totalMs / d.count))} / min ${min} / max ${fmtMs(d.maxMs)} (n=${d.count})`
}

/** 人读快照（工具返回文本用） */
export function formatMetrics(m: MetricsSnapshot): string {
  const a = m.agents
  const lines: string[] = []
  lines.push(`# Workflow Metrics（自 ${new Date(m.since).toISOString()} 起）`)
  lines.push("")
  lines.push("## Agents")
  lines.push(`- 调用 ${a.calls} 次（失败 ${a.failed}）`)
  lines.push(`- 耗时：${fmtDurationLine(a.duration)}`)
  lines.push(
    `- tokens：in ${fmtTokens(a.tokens.input)} / out ${fmtTokens(a.tokens.output)} / ` +
      `reasoning ${fmtTokens(a.tokens.reasoning)} / cache r ${fmtTokens(a.tokens.cacheRead)} w ${fmtTokens(a.tokens.cacheWrite)}`,
  )
  lines.push(`- 成本：$${a.costUSD.toFixed(4)}`)
  if (Object.keys(a.byModel).length > 0) {
    lines.push("- 按模型：")
    for (const [model, stats] of Object.entries(a.byModel)) {
      lines.push(
        `  - ${model}: ${stats.calls} 次, in ${fmtTokens(stats.tokens.input)} / ` +
          `out ${fmtTokens(stats.tokens.output)}, $${stats.costUSD.toFixed(4)}`,
      )
    }
  }
  lines.push("")
  lines.push("## Workflows")
  const wfEntries = Object.entries(m.workflows)
  if (wfEntries.length === 0) {
    lines.push("- （无）")
  } else {
    for (const [id, wf] of wfEntries) {
      lines.push(
        `- ${id}: started ${wf.started} / completed ${wf.completed} / failed ${wf.failed}; ` +
          `耗时 ${fmtDurationLine(wf.duration)}`,
      )
    }
  }
  lines.push("")
  lines.push("## 质量门")
  lines.push(
    `- check: ${m.checks.passed}/${m.checks.total} 通过` +
      (m.checks.total > 0 ? "" : "（无）"),
  )
  lines.push(
    `- verify: ${m.verifies.passed}/${m.verifies.total} 次（reviewer ${m.verifies.reviewerPassed}/${m.verifies.reviewerTotal}）`,
  )
  lines.push(
    `- checkpoint: ${m.checkpoints.approved} 批准 / ${m.checkpoints.rejected} 拒绝`,
  )
  lines.push(`- steps: ${m.steps.completed} 完成 / ${m.steps.failed} 失败（累计 ${fmtMs(m.steps.totalMs)}）`)
  return lines.join("\n")
}
