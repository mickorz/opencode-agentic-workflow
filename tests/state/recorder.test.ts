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
import { RunJournal, toProgressSnapshot, toRunDetail } from "../../src/state/recorder.js"
import { createEventBus, emitEvent, setEventBus } from "../../src/observability/events.js"

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

test("toRunDetail: 预览化载荷（截断/错误摘要/lineage/args）", async () => {
  const bus = createEventBus()
  setEventBus(bus)
  try {
    const journal = await RunJournal.start(store, {
      workflow: { id: "demo", version: "1.2.0" },
      args: { topic: "多字节 预览" },
      stepNames: ["gather", "verify"],
      stepCount: 2,
      runId: "run_detail",
      parentRunId: "run_parent",
      depth: 1,
    })
    await journal.stepStarted(0)
    await journal.stepCompleted(0, "x".repeat(600))
    await journal.stepStarted(1)
    const boom = new Error("verify 否决: " + "y".repeat(400))
    boom.name = "WorkflowCheckError"
    await journal.stepFailed(1, boom)
    await journal.fail(boom)

    const detail = toRunDetail(journal.run)
    assert.equal(detail.runId, "run_detail")
    assert.deepEqual(detail.workflow, { id: "demo", version: "1.2.0" })
    assert.equal(detail.status, "failed")
    assert.equal(detail.parentRunId, "run_parent")
    assert.equal(detail.depth, 1)
    assert.ok(detail.args?.includes("多字节"))
    // 输出预览截断到 500 字符 + …（长文本压成单行）
    assert.equal(detail.steps[0]?.output?.length, 501)
    assert.ok(detail.steps[0]?.output?.endsWith("…"))
    assert.ok(!detail.steps[0]?.output?.includes("\n"))
    // 错误摘要 "Name: message" 截断 300 + …
    assert.ok(detail.steps[1]?.error?.startsWith("WorkflowCheckError: "))
    assert.ok((detail.steps[1]?.error?.length ?? 0) <= 301)
    assert.ok(detail.steps[1]?.error?.endsWith("…"))
    // run 级失败摘要存在且截断
    assert.ok(detail.failure?.startsWith("WorkflowCheckError: "))
    assert.ok((detail.failure?.length ?? 0) <= 301)
    // 失败步骤无 output 键（错误与输出互斥呈现）
    assert.equal("output" in (detail.steps[1] ?? {}), false)
  } finally {
    setEventBus(createEventBus())
  }
})

test("P2-8b 步骤元数据：agent.completed 按 runId 聚合到 currentStep（隔离/累计/退订）", async () => {
  const bus = createEventBus()
  setEventBus(bus)
  try {
    const journal = await RunJournal.start(store, {
      workflow: { id: "demo", version: "1.0.0" },
      stepCount: 2,
      stepNames: ["gather", "verify"],
      runId: "run_meta",
    })
    await journal.stepStarted(0)
    // 他 run 的事件不落
    emitEvent({
      type: "agent.completed", durationMs: 5, outputLength: 5, runId: "run_other",
      model: "other/model",
      usage: { input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    // 无 runId（run 作用域外，如 inline）不落
    emitEvent({ type: "agent.completed", durationMs: 5, outputLength: 5, model: "x/y" })
    // 本 run 第一笔
    emitEvent({
      type: "agent.completed", durationMs: 10, outputLength: 10, runId: "run_meta",
      model: "glm/glm-5.3-flash",
      usage: { input: 100, output: 40, reasoning: 10, cache: { read: 0, write: 0 } },
    })
    // 本 run 第二笔（同步骤累计；模型取最后）
    emitEvent({
      type: "agent.completed", durationMs: 8, outputLength: 8, runId: "run_meta",
      model: "glm/glm-5.3-air",
      usage: { input: 50, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    await journal.stepCompleted(0, "done")

    let loaded = await store.getRun("run_meta")
    assert.deepEqual(loaded?.steps[0]?.usage, { input: 150, output: 60, reasoning: 10 })
    assert.equal(loaded?.steps[0]?.model, "glm/glm-5.3-air")

    // 第二步无元数据（无 agent 事件对应）
    await journal.stepStarted(1)
    await journal.stepCompleted(1, "ok")
    loaded = await store.getRun("run_meta")
    assert.equal(loaded?.steps[1]?.usage, undefined)
    assert.equal(loaded?.steps[1]?.model, undefined)

    // 终态退订：complete 后再派事件——不炸、不变
    await journal.complete()
    emitEvent({
      type: "agent.completed", durationMs: 1, outputLength: 1, runId: "run_meta",
      usage: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    loaded = await store.getRun("run_meta")
    assert.equal(loaded?.steps[0]?.usage?.input, 150)

    // detail 投影含元数据
    const detail = toRunDetail(journal.run)
    assert.deepEqual(detail.steps[0]?.usage, { input: 150, output: 60, reasoning: 10 })
    assert.equal(detail.steps[0]?.model, "glm/glm-5.3-air")

    // v0.7.0：进度快照同样透传步骤元数据（面板列表行 token/模型后缀的数据面）
    const snapshot = toProgressSnapshot(journal.run)
    assert.deepEqual(snapshot.steps[0]?.usage, { input: 150, output: 60, reasoning: 10 })
    assert.equal(snapshot.steps[0]?.model, "glm/glm-5.3-air")
    assert.equal(snapshot.steps[1]?.usage, undefined)
    assert.equal(snapshot.steps[1]?.model, undefined)
  } finally {
    setEventBus(createEventBus())
  }
})

test("Open Session 回放：agent.completed 的 sessionID 按序聚合到 currentStep", async () => {
  const bus = createEventBus()
  setEventBus(bus)
  try {
    const journal = await RunJournal.start(store, {
      workflow: { id: "demo", version: "1.0.0" },
      stepCount: 2,
      stepNames: ["gather", "verify"],
      runId: "run_sess",
    })
    await journal.stepStarted(0)
    // 他 run 的会话不落
    emitEvent({ type: "agent.completed", durationMs: 5, outputLength: 5, runId: "run_other", sessionID: "ses_other" })
    // 本 run 两笔（pipeline 步多会话，按发生顺序累积）
    emitEvent({ type: "agent.completed", durationMs: 5, outputLength: 5, runId: "run_sess", sessionID: "ses_1" })
    emitEvent({ type: "agent.completed", durationMs: 5, outputLength: 5, runId: "run_sess", sessionID: "ses_2" })
    // 无 sessionID（宿主型 executor 之外）不追加
    emitEvent({ type: "agent.completed", durationMs: 5, outputLength: 5, runId: "run_sess" })
    await journal.stepCompleted(0, "done")
    await journal.stepStarted(1)
    await journal.stepCompleted(1, "ok")
    await journal.complete()

    const loaded = await store.getRun("run_sess")
    assert.deepEqual(loaded?.steps[0]?.sessionIDs, ["ses_1", "ses_2"])
    assert.equal(loaded?.steps[1]?.sessionIDs, undefined)

    // detail 投影携带（面板据此发起回放 RPC）
    const detail = toRunDetail(journal.run)
    assert.deepEqual(detail.steps[0]?.sessionIDs, ["ses_1", "ses_2"])
  } finally {
    setEventBus(createEventBus())
  }
})

test("Open Session 回放：reopen 重置清空 sessionIDs，重跑重新聚合", async () => {
  const bus = createEventBus()
  setEventBus(bus)
  try {
    const journal = await RunJournal.start(store, {
      workflow: { id: "demo", version: "1.0.0" },
      stepCount: 1,
      stepNames: ["only"],
      runId: "run_sess2",
    })
    await journal.stepStarted(0)
    emitEvent({ type: "agent.completed", durationMs: 5, outputLength: 5, runId: "run_sess2", sessionID: "ses_stale" })
    const boom = new Error("failed")
    await journal.stepFailed(0, boom)
    await journal.fail(boom)

    await journal.reopen()
    // 非完成步骤重置：会话清单一并清空（旧会话不再属于本步骤）
    assert.equal(journal.run.steps[0]?.sessionIDs, undefined)

    await journal.stepStarted(0)
    emitEvent({ type: "agent.completed", durationMs: 5, outputLength: 5, runId: "run_sess2", sessionID: "ses_fresh" })
    await journal.stepCompleted(0, "ok")
    await journal.complete()
    assert.deepEqual(journal.run.steps[0]?.sessionIDs, ["ses_fresh"])
  } finally {
    setEventBus(createEventBus())
  }
})

test("P2-8b reopen 重订：failed run reopen 后元数据重新聚合", async () => {
  const bus = createEventBus()
  setEventBus(bus)
  try {
    const journal = await RunJournal.start(store, {
      workflow: { id: "demo", version: "1.0.0" },
      stepCount: 1,
      stepNames: ["only"],
      runId: "run_meta2",
    })
    await journal.stepStarted(0)
    const boom = new Error("first attempt failed")
    await journal.stepFailed(0, boom)
    await journal.fail(boom)
    assert.equal(journal.run.status, "failed")

    await journal.reopen()
    // 非完成步骤重置：元数据一并清空
    assert.equal(journal.run.steps[0]?.usage, undefined)
    assert.equal(journal.run.steps[0]?.model, undefined)

    await journal.stepStarted(0)
    emitEvent({
      type: "agent.completed", durationMs: 4, outputLength: 4, runId: "run_meta2",
      model: "glm/glm-5.3-flash",
      usage: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    await journal.stepCompleted(0, "ok2")
    await journal.complete()
    assert.deepEqual(journal.run.steps[0]?.usage, { input: 7, output: 3, reasoning: 0 })
  } finally {
    setEventBus(createEventBus())
  }
})
