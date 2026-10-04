/**
 * ProgressBoard 单元测试 —— 快照流维护 + store 种子 + bind 装配
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { ProgressBoard, bindProgressBoard, seedFromStore } from "../../src/plugin/progress-board.js"
import { createEventBus, setEventBus, type RunProgressSnapshot } from "../../src/observability/events.js"
import { FileExecutionStore } from "../../src/state/file-store.js"
import { RunJournal } from "../../src/state/recorder.js"

function snapshot(runId: string, startedAt: number, status = "running"): RunProgressSnapshot {
  return {
    runId,
    workflow: { id: "demo", version: "1.0.0" },
    status,
    startedAt,
    steps: [{ index: 0, name: "only", status: "running" }],
  }
}

test("事件驱动：run.progress 应用并转发，非进度事件忽略", () => {
  const forwarded: string[] = []
  const bus = createEventBus()
  const board = new ProgressBoard((run) => forwarded.push(run.runId), { bus })

  bus.dispatch({ type: "workflow.started", workflowId: "demo", time: 1 })
  assert.equal(board.list().length, 0)
  assert.equal(forwarded.length, 0)

  bus.dispatch({ type: "run.progress", run: snapshot("run_a", 100), time: 1 })
  assert.deepEqual(board.list().map((r) => r.runId), ["run_a"])
  assert.deepEqual(forwarded, ["run_a"])

  board.dispose()
})

test("runId 去重：同 run 更新单条目，newest-first 排序", () => {
  const board = new ProgressBoard(() => {}, { bus: createEventBus() })
  board.apply(snapshot("run_a", 100), { forward: false })
  board.apply(snapshot("run_b", 200), { forward: false })
  board.apply(snapshot("run_c", 50), { forward: false })
  // 按 startedAt 降序
  assert.deepEqual(
    board.list().map((r) => r.runId),
    ["run_b", "run_a", "run_c"],
  )
  // 更新 a（仍在跑 -> completed）不新增条目
  board.apply(snapshot("run_a", 100, "completed"), { forward: false })
  assert.equal(board.list().length, 3)
  assert.equal(board.list().find((r) => r.runId === "run_a")?.status, "completed")
  board.dispose()
})

test("容量淘汰：超出上限淘汰最旧", () => {
  const board = new ProgressBoard(() => {}, { bus: createEventBus(), capacity: 2 })
  board.apply(snapshot("run_a", 100), { forward: false })
  board.apply(snapshot("run_b", 200), { forward: false })
  board.apply(snapshot("run_c", 300), { forward: false })
  assert.deepEqual(
    board.list().map((r) => r.runId),
    ["run_c", "run_b"],
  )
  board.dispose()
})

test("种子不转发（面板尚未订阅，snapshot 方法自会读到）", () => {
  const forwarded: string[] = []
  const board = new ProgressBoard((run) => forwarded.push(run.runId), {
    bus: createEventBus(),
    seed: [snapshot("run_seed", 1)],
  })
  assert.deepEqual(forwarded, [])
  assert.equal(board.list().length, 1)
  board.dispose()
})

test("bindProgressBoard: 注册 snapshot 方法 + 事件流入 + 种子装载", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-board-"))
  const store = new FileExecutionStore(baseDir)

  // 历史两条（落盘顺序故意旧->新）
  await RunJournal.start(store, {
    workflow: { id: "demo", version: "1.0.0" },
    stepCount: 1,
    stepNames: ["only"],
    runId: "run_old",
  }).then((j) => j.complete())
  const newer = await RunJournal.start(store, {
    workflow: { id: "demo", version: "1.0.0" },
    stepCount: 1,
    stepNames: ["only"],
    runId: "run_new",
  })
  await newer.complete()

  const registrations: Array<Record<string, (input: unknown) => Promise<unknown>>> = []
  // 先换全局 bus 再 bind：board 订阅 bind 时的全局 bus（与 trace.ts 同款时序）
  const bus = createEventBus()
  setEventBus(bus)
  let board: Awaited<ReturnType<typeof bindProgressBoard>> | undefined
  try {
    board = await bindProgressBoard({
      rpc: {
        register: async (def: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>) => {
          registrations.push({ id: (def as { id: string }).id, ...handlers })
          return {
            events: {
              emit: async () => {},
            },
          }
        },
      } as never,
      store,
    })
  } finally {
    setEventBus(createEventBus())
  }

  // 注册了 snapshot 方法
  const reg = registrations[0]
  assert.ok(reg)
  assert.equal((reg as unknown as { id: string }).id, "agentic-workflow-progress")
  assert.ok(typeof reg.snapshot === "function")

  // 种子来自 store，newest first
  const seeded = (await reg.snapshot?.({})) as { runs: RunProgressSnapshot[] }
  assert.deepEqual(
    seeded.runs.map((r) => r.runId),
    ["run_new", "run_old"],
  )

  // 事件流入（board 订阅的 bus）-> 板更新 -> snapshot 反映
  // （startedAt 用真实时钟之后的值，确保排在历史 run 之前）
  bus.dispatch({ type: "run.progress", run: snapshot("run_live", Date.now() + 1000), time: 1 })
  const after = (await reg.snapshot?.({})) as { runs: RunProgressSnapshot[] }
  assert.equal(after.runs[0]?.runId, "run_live")
  assert.deepEqual(
    after.runs.map((r) => r.runId),
    ["run_live", "run_new", "run_old"],
  )

  board?.dispose()
})

test("seedFromStore: newest-first 映射 + 容量截断", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-seed-"))
  const store = new FileExecutionStore(baseDir)
  for (const runId of ["run_1", "run_2", "run_3"]) {
    const journal = await RunJournal.start(store, {
      workflow: { id: "demo", version: "1.0.0" },
      stepCount: 1,
      runId,
    })
    await journal.complete()
  }
  const seeded = await seedFromStore(store, 2)
  // listRuns 返回顺序不定；seedFromStore 自行排序 + 截断
  assert.equal(seeded.length, 2)
  assert.ok(seeded.every((r) => r.status === "completed"))
})
