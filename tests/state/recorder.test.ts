/**
 * RunJournal 单元测试 —— 生命周期 + 持久化可见性（真实 FileExecutionStore）
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { FileExecutionStore } from "../../src/state/file-store.js"
import type { ExecutionStore } from "../../src/state/store.js"
import { RunJournal } from "../../src/state/recorder.js"
import { createEventBus, setEventBus } from "../../src/observability/events.js"

let baseDir: string
let store: ExecutionStore

test.before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-recorder-"))
})

test.beforeEach(() => {
  store = new FileExecutionStore(baseDir)
})

test("生命周期: 每个状态变更落盘后立即可读", async () => {
  const journal = await RunJournal.start(store, {
    workflow: { id: "reliable", version: "1.0.0" },
    args: { topic: "T" },
    stepNames: ["agent", "check", "verify"],
    stepCount: 3,
  })
  const runId = journal.run.runId

  // 初始：全部 pending
  let loaded = await store.getRun(runId)
  assert.equal(loaded?.status, "running")
  assert.deepEqual(
    loaded?.steps.map((s) => s.status),
    ["pending", "pending", "pending"],
  )

  // step 0 完成
  await journal.stepStarted(0, { topic: "T" })
  await journal.stepCompleted(0, { output: "产物A" })
  loaded = await store.getRun(runId)
  assert.equal(loaded?.currentStep, 0)
  assert.deepEqual(loaded?.steps[0]?.input, { topic: "T" })
  assert.deepEqual(loaded?.steps[0]?.output, { output: "产物A" })
  assert.ok(loaded?.steps[0]?.completedAt)

  // step 1 进行中
  await journal.stepStarted(1)
  loaded = await store.getRun(runId)
  assert.equal(loaded?.currentStep, 1)
  assert.equal(loaded?.steps[1]?.status, "running")

  // 收口
  await journal.stepCompleted(1)
  await journal.stepStarted(2)
  await journal.stepCompleted(2)
  await journal.complete()
  loaded = await store.getRun(runId)
  assert.equal(loaded?.status, "completed")
  assert.ok(loaded?.completedAt)
})

test("fail: 记录失败原因，剩余 pending 步骤标记 skipped", async () => {
  const journal = await RunJournal.start(store, {
    workflow: { id: "reliable", version: "1.0.0" },
    stepNames: ["agent", "check", "verify"],
    stepCount: 3,
  })

  await journal.stepStarted(0)
  await journal.stepCompleted(0, "ok")
  await journal.stepStarted(1)
  const boom = new Error("check failed: tests must pass")
  boom.name = "WorkflowCheckError"
  await journal.stepFailed(1, boom)
  await journal.fail(boom)

  const loaded = await store.getRun(journal.run.runId)
  assert.equal(loaded?.status, "failed")
  assert.deepEqual(loaded?.failure, {
    name: "WorkflowCheckError",
    message: "check failed: tests must pass",
  })
  assert.deepEqual(
    loaded?.steps.map((s) => s.status),
    ["completed", "failed", "skipped"],
  )
  assert.deepEqual(loaded?.steps[1]?.error, {
    name: "WorkflowCheckError",
    message: "check failed: tests must pass",
  })
})

test("journal 关闭后（complete/fail）拒绝再变更", async () => {
  const completed = await RunJournal.start(store, { workflow: { id: "w", version: "1.0.0" }, stepCount: 1 })
  await completed.stepStarted(0)
  await completed.stepCompleted(0)
  await completed.complete()
  await assert.rejects(() => completed.stepStarted(0), /journal closed/)
  await assert.rejects(() => completed.fail(new Error("x")), /journal closed/)

  const failed = await RunJournal.start(store, { workflow: { id: "w", version: "1.0.0" }, stepCount: 1 })
  await failed.fail(new Error("x"))
  await assert.rejects(() => failed.stepStarted(0), /journal closed/)
  await assert.rejects(() => failed.complete(), /journal closed/)
})

test("步骤序号越界抛错", async () => {
  const journal = await RunJournal.start(store, { workflow: { id: "w", version: "1.0.0" }, stepCount: 2 })
  await assert.rejects(() => journal.stepStarted(2), /out of range/)
  await assert.rejects(() => journal.stepStarted(-1), /out of range/)
})

test("attach: 附加到已有 run / 不存在返回 undefined", async () => {
  const journal = await RunJournal.start(store, {
    workflow: { id: "reliable", version: "1.0.0" },
    stepNames: ["a", "b"],
    stepCount: 2,
  })
  await journal.stepStarted(0)
  await journal.stepCompleted(0, "中间产物")

  // 模拟进程重启：从磁盘附加
  const resumed = await RunJournal.attach(store, journal.run.runId)
  assert.ok(resumed)
  assert.equal(resumed.run.status, "running")
  assert.deepEqual(resumed.run.steps[0]?.output, "中间产物")
  // 附加后可继续记录
  await resumed.stepStarted(1)
  await resumed.stepCompleted(1, "最终产物")
  await resumed.complete()

  const loaded = await store.getRun(journal.run.runId)
  assert.equal(loaded?.status, "completed")
  assert.equal(loaded?.steps[1]?.output, "最终产物")

  assert.equal(await RunJournal.attach(store, "run_nope"), undefined)
})

test("显式 runId 透传（便于测试与外部引用）", async () => {
  const journal = await RunJournal.start(store, {
    workflow: { id: "w", version: "1.0.0" },
    stepCount: 1,
    runId: "run_fixed_id",
  })
  assert.equal(journal.run.runId, "run_fixed_id")
  assert.ok(await store.getRun("run_fixed_id"))
})

test("P2-8: 每次状态转换发射 run.progress 快照（全量、可序列化、不含 output）", async () => {
  const events: Array<{ type: string; run?: unknown }> = []
  const bus = createEventBus()
  bus.subscribe((event) => events.push(event as { type: string; run?: unknown }))
  setEventBus(bus)
  try {
    const journal = await RunJournal.start(store, {
      workflow: { id: "progress-demo", version: "1.2.0" },
      stepNames: ["gather", "build"],
      stepCount: 2,
    })
    await journal.stepStarted(0, { topic: "T" })
    await journal.stepCompleted(0, { big: "x".repeat(500) })
    await journal.stepStarted(1)
    await journal.fail(new Error("boom"))

    const progress = events
      .filter((e) => e.type === "run.progress")
      .map((e) => e.run as {
        runId: string
        workflow: { id: string; version: string }
        status: string
        steps: Array<{ name?: string; status: string }>
        failure?: string
      })
    // start + 4 次转换 = 5 个快照
    assert.equal(progress.length, 5)
    assert.deepEqual(
      progress.map((p) => p.status),
      ["running", "running", "running", "running", "failed"],
    )
    // 形状：workflow 标识 + 步骤名 + 失败摘要（截断 200）
    for (const p of progress) {
      assert.deepEqual(p.workflow, { id: "progress-demo", version: "1.2.0" })
      assert.equal(p.steps.length, 2)
      assert.deepEqual(p.steps.map((s) => s.name), ["gather", "build"])
      // 快照可序列化（RPC 传输前提）
      JSON.stringify(p)
    }
    const final = progress[4]
    assert.ok(final)
    assert.equal(final.failure, "boom")
    // 既有 fail 语义：仅 pending -> skipped；中断时仍处 running 的步骤保持原状
    assert.deepEqual(
      final.steps.map((s) => s.status),
      ["completed", "running"],
    )
  } finally {
    setEventBus(createEventBus())
  }
})
