/**
 * v0.10.0 agent 重试可观测单测
 * 覆盖：AgentResult.attempt/attemptsMax（一次成功 / 重试后成功）/
 *       agent.completed 事件携带 attempt（面板 `(2/3)` 数据源）
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import type { AgentResult, AgentTask } from "../../src/runtime/executor.js"
import { setExecutor } from "../../src/runtime/engine.js"
import { agent } from "../../src/workflow/agent.js"
import {
  createEventBus,
  setEventBus,
  type WorkflowEvent,
} from "../../src/observability/events.js"

/** 捕获型 executor：可配置「前 N 次失败」 */
class FlakyExecutor {
  count = 0
  failFirst = 0
  async execute(_task: AgentTask): Promise<AgentResult> {
    this.count += 1
    if (this.count <= this.failFirst) throw new Error(`boom #${this.count}`)
    return { output: `ok:${this.count}` }
  }
}

test.afterEach(() => {
  setEventBus(createEventBus())
})

function captureEvents(): WorkflowEvent[] {
  const events: WorkflowEvent[] = []
  const bus = createEventBus()
  bus.subscribe((event) => events.push(event))
  setEventBus(bus)
  return events
}

test("attempt 暴露：一次成功 → attempt=1 / attemptsMax=retries+1", async () => {
  captureEvents()
  const ex = new FlakyExecutor()
  setExecutor(ex)
  const result = await agent("p", { retries: 2 })
  assert.equal(result.attempt, 1)
  assert.equal(result.attemptsMax, 3)
})

test("attempt 暴露：第三次成功 → attempt=3（`(3/3)`）", async () => {
  captureEvents()
  const ex = new FlakyExecutor()
  ex.failFirst = 2
  setExecutor(ex)
  const result = await agent("p", { retries: 2 })
  assert.equal(result.output, "ok:3")
  assert.equal(result.attempt, 3)
  assert.equal(result.attemptsMax, 3)
})

test("事件带出：agent.completed 携带 attempt/attemptsMax", async () => {
  const events = captureEvents()
  const ex = new FlakyExecutor()
  ex.failFirst = 1
  setExecutor(ex)
  await agent("p", { retries: 1 })
  const completed = events.find(
    (e): e is Extract<WorkflowEvent, { type: "agent.completed" }> => e.type === "agent.completed",
  )
  assert.notEqual(completed, undefined)
  assert.equal(completed.attempt, 2)
  assert.equal(completed.attemptsMax, 2)
})

test("无重试：attemptsMax=1（展示层据此省略 `(1/1)`）", async () => {
  captureEvents()
  const ex = new FlakyExecutor()
  setExecutor(ex)
  const result = await agent("p")
  assert.equal(result.attempt, 1)
  assert.equal(result.attemptsMax, 1)
})
