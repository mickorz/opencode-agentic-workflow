/**
 * observability 单元测试 —— 事件总线 / 插桩覆盖 / trace 收集 / JSONL 落盘
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  createEventBus,
  emitEvent,
  getEventBus,
  preview,
  setEventBus,
} from "../../src/observability/events.js"
import { createTraceCollector, createFileTraceSink } from "../../src/observability/trace.js"
import { observeWorkflow } from "../../src/observability/observe.js"
import { setCheckpointGate } from "../../src/quality/checkpoint.js"
import { PolicyCheckpointGate } from "../../src/plugin/policy-checkpoint-gate.js"
import { setExecutor } from "../../src/runtime/engine.js"
import { NodeCommandRunner, setCommandRunner } from "../../src/runtime/command.js"
import { phase } from "../../src/workflow/phase.js"
import { agent } from "../../src/workflow/agent.js"
import { sequence } from "../../src/workflow/sequence.js"
import { runReliableWorkflow } from "../../src/workflow/reliable.js"

const PASS = JSON.stringify({ verdict: "pass", summary: "ok", issues: [] })

function mockExecutor(outputs: string[]) {
  let i = 0
  return {
    async execute(task: { prompt: string }) {
      const output = outputs[Math.min(i, outputs.length - 1)] ?? ""
      i += 1
      return { output }
    },
  }
}

/** 每个测试用独立 bus，隔离全局状态 */
function freshBus() {
  const bus = createEventBus()
  setEventBus(bus)
  return bus
}

test.afterEach(() => {
  setCommandRunner(new NodeCommandRunner())
  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))
})

test("bus: 订阅/取消订阅/派发", () => {
  const bus = freshBus()
  const received: string[] = []
  const off = bus.subscribe((e) => received.push(e.type))
  emitEvent({ type: "phase.started", name: "x" })
  off()
  emitEvent({ type: "phase.started", name: "y" })
  assert.deepEqual(received, ["phase.started"])
})

test("bus: handler 抛错被隔离（不影响其他 handler 与派发方）", () => {
  const bus = freshBus()
  let secondCalled = false
  bus.subscribe(() => {
    throw new Error("listener boom")
  })
  bus.subscribe(() => {
    secondCalled = true
  })
  assert.doesNotThrow(() => emitEvent({ type: "phase.started", name: "x" }))
  assert.equal(secondCalled, true)
})

test("emitEvent: 自动补 time；preview 截断长文本", () => {
  freshBus()
  const trace = createTraceCollector()
  emitEvent({ type: "phase.started", name: "x" })
  assert.equal(trace.events.length, 1)
  assert.ok(trace.events[0]!.time > 0)
  assert.equal(preview("a".repeat(100)).length <= 81, true)
  assert.equal(preview("  hello   world \n next "), "hello world next")
})

test("插桩: phase/agent/check/verify/checkpoint/step 事件", async () => {
  freshBus()
  const trace = createTraceCollector()
  setExecutor(mockExecutor(["产物", PASS]))
  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))

  await sequence<unknown>([
    async () => {
      phase("Execute")
      const r = await agent("做一个分析")
      return r
    },
    async () => "done",
  ])

  const types = trace.events.map((e) => e.type)
  assert.ok(types.includes("phase.started"))
  assert.ok(types.includes("step.started"))
  assert.ok(types.includes("step.completed"))
  const agentStarted = trace.events.find((e) => e.type === "agent.started")
  assert.equal(agentStarted?.type === "agent.started" && agentStarted.promptPreview.includes("做一个分析"), true)

  await runReliableWorkflow("任意主题", { reviewers: 1 })
  const reliableTypes = trace.events.map((e) => e.type)
  assert.ok(reliableTypes.includes("check.completed"))
  assert.ok(reliableTypes.includes("verify.completed"))
  assert.ok(reliableTypes.includes("checkpoint.waiting"))
  assert.ok(reliableTypes.includes("checkpoint.completed"))
  const check = trace.events.find((e) => e.type === "check.completed")
  assert.equal(check?.type === "check.completed" && check.ok, true)
  const verify = trace.events.find((e) => e.type === "verify.completed")
  assert.equal(
    verify?.type === "verify.completed" && verify.passed && verify.totalCount === 1,
    true,
  )
})

test("observeWorkflow: started/completed；失败时 failed 且异常透传", async () => {
  freshBus()
  const trace = createTraceCollector()

  const value = await observeWorkflow("w1", async () => 42, { k: "v" })
  assert.equal(value, 42)

  await assert.rejects(
    () =>
      observeWorkflow("w2", async () => {
        throw new Error("boom")
      }),
    /boom/,
  )

  const workflowEvents = trace.events.filter((e) => e.type.startsWith("workflow."))
  assert.deepEqual(workflowEvents.map((e) => e.type), [
    "workflow.started",
    "workflow.completed",
    "workflow.started",
    "workflow.failed",
  ])
  const started = workflowEvents[0]
  assert.equal(started?.type === "workflow.started" && started.args?.k, "v")
})

test("agent 失败 -> agent.failed 事件 + 异常透传", async () => {
  freshBus()
  const trace = createTraceCollector()
  setExecutor({
    async execute() {
      throw new Error("executor down")
    },
  })
  await assert.rejects(() => agent("x"), /executor down/)
  const failed = trace.events.find((e) => e.type === "agent.failed")
  assert.equal(failed?.type === "agent.failed" && failed.error, "executor down")
})

test("reliable 全链路事件序: workflow.started -> ... -> workflow.completed", async () => {
  freshBus()
  const trace = createTraceCollector()
  setExecutor(mockExecutor(["产物", PASS]))
  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))

  await runReliableWorkflow("T", { reviewers: 1 })

  const workflowBoundaries = trace.events
    .filter(
      (e) =>
        e.type === "workflow.started" ||
        e.type === "workflow.completed" ||
        e.type === "workflow.failed",
    )
    .map((e) => e.type)
  assert.deepEqual(workflowBoundaries, ["workflow.started", "workflow.completed"])

  // 首尾事件正确
  assert.equal(trace.events[0]?.type, "workflow.started")
  assert.equal(trace.events[trace.events.length - 1]?.type, "workflow.completed")
})

test("FileTraceSink: JSONL 落盘且行行可解析", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-trace-"))
  const file = path.join(dir, "events.jsonl")
  freshBus()
  const sink = createFileTraceSink(file)

  emitEvent({ type: "phase.started", name: "a" })
  emitEvent({ type: "phase.started", name: "b" })
  // 等串行写入队列排空
  await new Promise((r) => setTimeout(r, 50))
  sink.stop()

  const raw = await fs.readFile(file, "utf8")
  const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as { type: string; time: number })
  assert.equal(lines.length, 2)
  assert.equal(lines[0]?.type, "phase.started")
  assert.equal(lines[1]?.type, "phase.started")
  assert.ok(lines.every((l) => typeof l.time === "number"))

  await fs.rm(dir, { recursive: true, force: true })
})
