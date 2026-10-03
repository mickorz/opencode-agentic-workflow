/**
 * FileExecutionStore 单元测试 —— 真实文件系统（tmp 目录）
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { FileExecutionStore } from "../../src/state/file-store.js"
import { createRun } from "../../src/state/journal.js"

let baseDir: string
let store: FileExecutionStore

test.before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-state-"))
})

test.beforeEach(() => {
  store = new FileExecutionStore(baseDir)
})

test("createRun + getRun: 读写往返保持形状", async () => {
  const run = createRun({
    workflow: { id: "reliable", version: "1.0.0" },
    args: { topic: "天空为什么是蓝色" },
    stepNames: ["agent", "check"],
    stepCount: 2,
  })
  await store.createRun(run)

  const loaded = await store.getRun(run.runId)
  assert.ok(loaded)
  assert.equal(loaded.runId, run.runId)
  assert.equal(loaded.workflow.id, "reliable")
  assert.equal(loaded.workflow.version, "1.0.0")
  assert.equal(loaded.steps.length, 2)
  assert.equal(loaded.steps[1]?.name, "check")
  assert.deepEqual(loaded.args, { topic: "天空为什么是蓝色" })
})

test("createRun: 重复 runId 抛错（防覆盖历史）", async () => {
  const run = createRun({ workflow: { id: "w", version: "1.0.0" }, stepCount: 1 })
  await store.createRun(run)
  await assert.rejects(() => store.createRun(run), /already exists/)
})

test("saveRun: 全量覆写生效", async () => {
  const run = createRun({ workflow: { id: "w", version: "1.0.0" }, stepCount: 2 })
  await store.createRun(run)

  run.status = "completed"
  run.steps[0]!.status = "completed"
  run.steps[0]!.output = "产物"
  await store.saveRun(run)

  const loaded = await store.getRun(run.runId)
  assert.equal(loaded?.status, "completed")
  assert.equal(loaded?.steps[0]?.output, "产物")
})

test("getRun: 不存在返回 undefined", async () => {
  assert.equal(await store.getRun("run_missing"), undefined)
})

test("getRun: 损坏文件抛明确错误（而非静默）", async () => {
  const file = path.join(baseDir, "run_corrupt.json")
  await fs.writeFile(file, "{ not json", "utf8")
  await assert.rejects(() => store.getRun("run_corrupt"), /corrupt run file/)
})

test("listRuns: 按 startedAt 倒序，支持 workflowId 过滤", async () => {
  // 独立子目录，隔离前面测试留下的 run 文件
  store = new FileExecutionStore(path.join(baseDir, "list"))
  const older = createRun({ workflow: { id: "smoke", version: "1.0.0" }, stepCount: 1 })
  older.startedAt = Date.now() - 5000
  const newer = createRun({ workflow: { id: "reliable", version: "1.0.0" }, stepCount: 1 })
  const newest = createRun({ workflow: { id: "reliable", version: "1.0.0" }, stepCount: 1 })
  newest.startedAt = Date.now() + 5000

  await store.createRun(older)
  await store.createRun(newer)
  await store.createRun(newest)

  const all = await store.listRuns()
  assert.deepEqual(
    all.map((r) => r.runId),
    [newest.runId, newer.runId, older.runId],
  )

  const reliable = await store.listRuns("reliable")
  assert.equal(reliable.length, 2)
  assert.ok(reliable.every((r) => r.workflow.id === "reliable"))
})

test("listRuns: 目录不存在返回空数组；损坏文件被跳过", async () => {
  const empty = new FileExecutionStore(path.join(baseDir, "no-such-dir"))
  assert.deepEqual(await empty.listRuns(), [])

  await fs.writeFile(path.join(baseDir, "run_garbage.json"), "???", "utf8")
  const runs = await store.listRuns()
  assert.ok(runs.every((r) => r.runId !== "run_garbage"))
})

test("runId 路径穿越被拒绝（不落盘到目录外）", async () => {
  const evil = createRun({ workflow: { id: "w", version: "1.0.0" }, stepCount: 1 })
  evil.runId = "../../evil"
  await assert.rejects(() => store.createRun(evil), /invalid runId/)
  await assert.rejects(() => store.getRun("../../evil"), /invalid runId/)
})

test("safeSerialize: 函数/BigInt/Error 转占位描述", async () => {
  const run = createRun({ workflow: { id: "w", version: "1.0.0" }, stepCount: 1 })
  run.steps[0]!.input = { fn: () => 1, big: 10n, err: new Error("boom") }
  await store.saveRun(run)

  const loaded = await store.getRun(run.runId)
  const input = loaded?.steps[0]?.input as Record<string, unknown>
  assert.equal(input.fn, "[Function]")
  assert.equal(input.big, "10")
  assert.deepEqual(input.err, { name: "Error", message: "boom" })
})

test("safeSerialize: 重复引用完整复制（不误标 Circular）", async () => {
  const shared = { topic: "x" }
  const run = createRun({ workflow: { id: "w", version: "1.0.0" }, stepCount: 2 })
  run.steps[0]!.output = shared
  run.steps[1]!.input = shared
  await store.saveRun(run)

  const loaded = await store.getRun(run.runId)
  assert.deepEqual(loaded?.steps[0]?.output, { topic: "x" })
  assert.deepEqual(loaded?.steps[1]?.input, { topic: "x" })
})

test("safeSerialize: 循环引用走退路，落盘不抛错", async () => {
  const evil: Record<string, unknown> = {}
  evil.self = evil
  const run = createRun({ workflow: { id: "w", version: "1.0.0" }, stepCount: 1 })
  run.steps[0]!.input = evil
  await store.saveRun(run) // 不抛即通过

  const loaded = await store.getRun(run.runId)
  assert.deepEqual(loaded?.steps[0]?.input, { self: "[Circular]" })
})
