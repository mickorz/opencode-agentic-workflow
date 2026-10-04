/**
 * Progress RPC 契约测试 —— 事件名一致性 + 载荷收窄
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { ProgressRpc, PROGRESS_EVENT, parseRunSnapshot, parseRunSnapshotList } from "../../src/plugin/progress-rpc.js"
import type { RunProgressSnapshot } from "../../src/observability/events.js"

function snapshot(overrides?: Partial<RunProgressSnapshot>): RunProgressSnapshot {
  return {
    runId: "run_1",
    workflow: { id: "demo", version: "1.0.0" },
    status: "running",
    startedAt: 1000,
    steps: [
      { index: 0, name: "gather", status: "completed", startedAt: 1000, completedAt: 2000 },
      { index: 1, status: "running", startedAt: 2000 },
    ],
    ...overrides,
  }
}

test("事件名与 Rpc 定义一致（TUI 订阅键拼写保证）", () => {
  assert.equal(PROGRESS_EVENT, `rpc.${ProgressRpc.id}.progress`)
})

test("parseRunSnapshot: 合法快照原样通过", () => {
  const input = snapshot()
  assert.deepEqual(parseRunSnapshot(input), input)
})

test("parseRunSnapshot: 缺字段/类型错一律拒绝", () => {
  assert.equal(parseRunSnapshot(undefined), undefined)
  assert.equal(parseRunSnapshot(null), undefined)
  assert.equal(parseRunSnapshot("run_1"), undefined)
  assert.equal(parseRunSnapshot({}), undefined)
  assert.equal(parseRunSnapshot({ ...snapshot(), runId: 42 }), undefined)
  assert.equal(parseRunSnapshot({ ...snapshot(), status: 1 }), undefined)
  assert.equal(parseRunSnapshot({ ...snapshot(), startedAt: "1000" }), undefined)
  assert.equal(parseRunSnapshot({ ...snapshot(), workflow: { id: "x" } }), undefined)
  assert.equal(parseRunSnapshot({ ...snapshot(), steps: "nope" }), undefined)
  assert.equal(
    parseRunSnapshot({ ...snapshot(), steps: [{ index: "0", status: "running" }] }),
    undefined,
  )
})

test("parseRunSnapshotList: 逐条过滤，非法整体丢弃", () => {
  const good = snapshot()
  const list = parseRunSnapshotList({ runs: [good, { broken: true }, snapshot({ runId: "run_2" })] })
  assert.deepEqual(list.map((r) => r.runId), ["run_1", "run_2"])
  assert.deepEqual(parseRunSnapshotList({}), [])
  assert.deepEqual(parseRunSnapshotList({ runs: "x" }), [])
  assert.deepEqual(parseRunSnapshotList(null), [])
})
