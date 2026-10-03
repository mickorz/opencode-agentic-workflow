/**
 * MetricsCollector 单元测试 —— 纯事件消费聚合 + 快照落盘 + 格式化
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { createEventBus, emitEvent, setEventBus } from "../../src/observability/events.js"
import {
  MetricsCollector,
  formatMetrics,
} from "../../src/metrics/collector.js"

test.beforeEach(() => {
  setEventBus(createEventBus())
})

test("collector: 聚合 agent 调用的时长/token/成本/模型", () => {
  const collector = new MetricsCollector()

  emitEvent({ type: "agent.started", promptPreview: "p" })
  emitEvent({
    type: "agent.completed",
    durationMs: 100,
    outputLength: 10,
    usage: { input: 1000, output: 200, reasoning: 50, cache: { read: 300, write: 100 } },
    costUSD: 0.01,
    model: "glm/glm-5.3-flash",
  })
  emitEvent({
    type: "agent.completed",
    durationMs: 300,
    outputLength: 20,
    usage: { input: 500, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    costUSD: 0.02,
    model: "glm/glm-5.3-flash",
  })
  emitEvent({ type: "agent.failed", durationMs: 50, error: "boom" })

  const snap = collector.snapshot()
  assert.equal(snap.agents.calls, 2)
  assert.equal(snap.agents.failed, 1)
  assert.equal(snap.agents.duration.count, 2)
  assert.equal(snap.agents.duration.minMs, 100)
  assert.equal(snap.agents.duration.maxMs, 300)
  assert.equal(snap.agents.duration.lastMs, 300)
  assert.equal(snap.agents.tokens.input, 1500)
  assert.equal(snap.agents.tokens.output, 300)
  assert.equal(snap.agents.tokens.reasoning, 50)
  assert.equal(snap.agents.tokens.cacheRead, 300)
  assert.equal(snap.agents.tokens.cacheWrite, 100)
  assert.equal(snap.agents.costUSD, 0.03)

  const model = snap.agents.byModel["glm/glm-5.3-flash"]
  assert.ok(model)
  assert.equal(model.calls, 2)
  assert.equal(model.tokens.input, 1500)
  assert.equal(model.costUSD, 0.03)
})

test("collector: 无 usage 的 agent.completed 不计入 token（模型未知桶仅在有数据时建）", () => {
  const collector = new MetricsCollector()
  emitEvent({ type: "agent.completed", durationMs: 10, outputLength: 1 })
  const snap = collector.snapshot()
  assert.equal(snap.agents.calls, 1)
  assert.equal(snap.agents.tokens.input, 0)
  assert.equal(snap.agents.costUSD, 0)
  assert.deepEqual(snap.agents.byModel, {})
})

test("collector: workflow 计数与时长 + 质量门计数器", () => {
  const collector = new MetricsCollector()

  emitEvent({ type: "workflow.started", workflowId: "reliable" })
  emitEvent({ type: "workflow.completed", workflowId: "reliable", durationMs: 5000 })
  emitEvent({ type: "workflow.started", workflowId: "reliable" })
  emitEvent({ type: "workflow.failed", workflowId: "reliable", error: "x" })
  emitEvent({ type: "workflow.completed", workflowId: "smoke", durationMs: 1000 })

  emitEvent({ type: "step.completed", index: 0, durationMs: 100 })
  emitEvent({ type: "step.completed", index: 1, durationMs: 300 })
  emitEvent({ type: "step.failed", index: 2, error: "x" })

  emitEvent({ type: "check.completed", label: "c1", ok: true })
  emitEvent({ type: "check.completed", label: "c2", ok: false })

  emitEvent({ type: "verify.completed", label: "v", passed: true, passedCount: 2, totalCount: 2 })
  emitEvent({ type: "verify.completed", label: "v2", passed: false, passedCount: 1, totalCount: 2 })

  emitEvent({ type: "checkpoint.waiting", label: "cp", message: "m" })
  emitEvent({ type: "checkpoint.completed", label: "cp", approved: true })
  emitEvent({ type: "checkpoint.completed", label: "cp2", approved: false })

  const snap = collector.snapshot()
  const reliable = snap.workflows["reliable"]
  assert.ok(reliable)
  assert.equal(reliable.started, 2)
  assert.equal(reliable.completed, 1)
  assert.equal(reliable.failed, 1)
  assert.equal(reliable.duration.count, 1)
  assert.equal(reliable.duration.lastMs, 5000)
  assert.equal(snap.workflows["smoke"]?.completed, 1)

  assert.equal(snap.steps.completed, 2)
  assert.equal(snap.steps.failed, 1)
  assert.equal(snap.steps.totalMs, 400)
  assert.equal(snap.checks.total, 2)
  assert.equal(snap.checks.passed, 1)
  assert.equal(snap.verifies.total, 2)
  assert.equal(snap.verifies.passed, 1)
  assert.equal(snap.verifies.reviewerPassed, 3)
  assert.equal(snap.verifies.reviewerTotal, 4)
  assert.equal(snap.checkpoints.approved, 1)
  assert.equal(snap.checkpoints.rejected, 1)
  assert.ok(snap.updatedAt > 0)
})

test("collector: snapshot 是深拷贝，reset/dispose 生效", () => {
  const collector = new MetricsCollector()
  emitEvent({ type: "workflow.started", workflowId: "w" })
  const snap = collector.snapshot()
  snap.workflows["w"]!.started = 99
  assert.equal(collector.snapshot().workflows["w"]?.started, 1)

  collector.reset()
  assert.deepEqual(collector.snapshot().workflows, {})

  collector.dispose()
  emitEvent({ type: "workflow.started", workflowId: "w2" })
  assert.deepEqual(collector.snapshot().workflows, {})
})

test("collector: subscribeFileSink 在 workflow 结束时落盘快照", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-metrics-"))
  const file = path.join(dir, "metrics.json")
  const collector = new MetricsCollector()
  collector.subscribeFileSink(file)

  emitEvent({ type: "workflow.started", workflowId: "reliable" })
  emitEvent({
    type: "agent.completed",
    durationMs: 10,
    outputLength: 1,
    usage: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    costUSD: 0.001,
    model: "p/m",
  })
  emitEvent({ type: "workflow.completed", workflowId: "reliable", durationMs: 100 })

  // 落盘是异步的：等一小段再读
  await new Promise((resolve) => setTimeout(resolve, 50))
  const written = JSON.parse(await fs.readFile(file, "utf8")) as {
    writtenAt: number
    agents: { tokens: { input: number } }
  }
  assert.ok(written.writtenAt > 0)
  assert.equal(written.agents.tokens.input, 10)
})

test("formatMetrics: 人读输出包含关键段落", () => {
  const collector = new MetricsCollector()
  emitEvent({
    type: "agent.completed",
    durationMs: 1500,
    outputLength: 1,
    usage: { input: 1500000, output: 25000, reasoning: 0, cache: { read: 0, write: 0 } },
    costUSD: 0.1234,
    model: "glm/glm-5.3-flash",
  })
  emitEvent({ type: "workflow.started", workflowId: "reliable" })
  emitEvent({ type: "workflow.completed", workflowId: "reliable", durationMs: 62000 })
  const text = formatMetrics(collector.snapshot())
  assert.match(text, /# Workflow Metrics/)
  assert.match(text, /调用 1 次/)
  assert.match(text, /in 1\.50M \/ out 25\.0k/)
  assert.match(text, /\$0\.1234/)
  assert.match(text, /glm\/glm-5\.3-flash: 1 次/)
  assert.match(text, /reliable: started 1 \/ completed 1/)
  assert.match(text, /1\.0min/)
})

test("agent(): 事件透传 executor 返回的 usage/cost/model", async () => {
  const { setExecutor } = await import("../../src/runtime/engine.js")
  const { agent } = await import("../../src/workflow/agent.js")

  const seen: unknown[] = []
  const bus = createEventBus()
  bus.subscribe((event) => {
    if (event.type === "agent.completed") seen.push(event)
  })
  setEventBus(bus)

  setExecutor({
    async execute() {
      return {
        output: "ok",
        usage: { input: 7, output: 3, reasoning: 1, cache: { read: 2, write: 4 } },
        costUSD: 0.005,
        model: "p/m",
      }
    },
  })

  const result = await agent("hi")
  assert.equal(result.usage?.cache.write, 4)
  const event = seen[0] as { usage?: { input: number }; costUSD?: number; model?: string }
  assert.equal(event.usage?.input, 7)
  assert.equal(event.costUSD, 0.005)
  assert.equal(event.model, "p/m")
})
