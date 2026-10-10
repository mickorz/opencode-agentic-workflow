/**
 * ProgressBoard 单元测试 —— 快照流维护 + store 种子 + bind 装配
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { ProgressBoard, bindProgressBoard, seedFromStore } from "../../src/plugin/progress-board.js"
import { createEventBus, emitEvent, setEventBus, type RunProgressSnapshot } from "../../src/observability/events.js"
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

  // 历史两条（落盘顺序故意旧->新）：run_old 已完成（终态，不播种）；
  // run_new 被中断（不收口，卡 running——启动面板应只浮现它）
  await RunJournal.start(store, {
    workflow: { id: "demo", version: "1.0.0" },
    stepCount: 1,
    stepNames: ["only"],
    runId: "run_old",
  }).then((j) => j.complete())
  await RunJournal.start(store, {
    workflow: { id: "demo", version: "1.0.0" },
    stepCount: 1,
    stepNames: ["only"],
    runId: "run_new",
  })

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

  // 种子只含被中断的 run_new（终态 run_old 不再上启动面板）
  const seeded = (await reg.snapshot?.({})) as { runs: RunProgressSnapshot[] }
  assert.deepEqual(
    seeded.runs.map((r) => r.runId),
    ["run_new"],
  )

  // 事件流入（board 订阅的 bus）-> 板更新 -> snapshot 反映
  // （startedAt 用真实时钟之后的值，确保排在历史 run 之前）
  bus.dispatch({ type: "run.progress", run: snapshot("run_live", Date.now() + 1000), time: 1 })
  const after = (await reg.snapshot?.({})) as { runs: RunProgressSnapshot[] }
  assert.equal(after.runs[0]?.runId, "run_live")
  assert.deepEqual(
    after.runs.map((r) => r.runId),
    ["run_live", "run_new"],
  )

  board?.dispose()
})

test("seedFromStore: 只播种非终态（被中断）run；newest-first + 容量截断", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-seed-"))
  const store = new FileExecutionStore(baseDir)
  const start = (runId: string) =>
    RunJournal.start(store, {
      workflow: { id: "demo", version: "1.0.0" },
      stepCount: 1,
      runId,
    })

  await start("run_1").then((j) => j.complete()) // 终态：completed
  await start("run_2") // 非终态：被中断（不收口，卡 running）
  await start("run_3").then((j) => j.fail(new Error("x"))) // 终态：failed（可 resumeRunId，但不播种）
  await start("run_4").then((j) => j.abort("stop")) // 终态：aborted
  await start("run_5") // 非终态：最新的被中断

  const seeded = await seedFromStore(store)
  assert.deepEqual(
    seeded.map((r) => r.runId),
    ["run_5", "run_2"],
  )
  assert.ok(seeded.every((r) => r.status === "running"))

  // 容量截断作用于过滤之后（newest first 取前 N）
  const capped = await seedFromStore(store, 1)
  assert.deepEqual(
    capped.map((r) => r.runId),
    ["run_5"],
  )
})

test("bindProgressBoard: detail 方法（journal 单读；未知 run/坏入参 -> null）", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-board-detail-"))
  const store = new FileExecutionStore(baseDir)

  const journal = await RunJournal.start(store, {
    workflow: { id: "demo", version: "1.0.0" },
    args: { topic: "T" },
    stepCount: 2,
    stepNames: ["gather", "verify"],
    runId: "run_detail",
  })
  await journal.stepStarted(0)
  await journal.stepCompleted(0, "产物文本")
  await journal.stepStarted(1)
  await journal.stepCompleted(1, "ok")
  await journal.complete()

  const registrations: Array<Record<string, (input: unknown) => Promise<unknown>>> = []
  const bus = createEventBus()
  setEventBus(bus)
  let board: Awaited<ReturnType<typeof bindProgressBoard>> | undefined
  try {
    board = await bindProgressBoard({
      rpc: {
        register: async (
          def: unknown,
          handlers: Record<string, (input: unknown) => Promise<unknown>>,
        ) => {
          registrations.push({ id: (def as { id: string }).id, ...handlers })
          return { events: { emit: async () => {} } }
        },
      } as never,
      store,
    })
  } finally {
    setEventBus(createEventBus())
  }

  const reg = registrations[0]
  assert.ok(reg)
  assert.equal(typeof reg.detail, "function")

  // 命中：journal 单读，含 args/步骤输出预览
  const hit = (await reg.detail?.({ runId: "run_detail" })) as {
    run: { runId: string; status: string; args?: string; steps: Array<{ output?: string }> }
  }
  assert.equal(hit.run.runId, "run_detail")
  assert.equal(hit.run.status, "completed")
  assert.ok(hit.run.args?.includes("topic"))
  assert.equal(hit.run.steps[0]?.output, "产物文本")

  // 未知 run / 坏入参 -> null（面板不渲染详情区，不抛错）
  const missing = (await reg.detail?.({ runId: "run_nope" })) as { run: unknown }
  assert.equal(missing.run, null)
  const malformed = (await reg.detail?.({ nope: 1 })) as { run: unknown }
  assert.equal(malformed.run, null)

  board?.dispose()
})

test("bindProgressBoard: 无 store（未配 journalDir）时 detail 恒为 null", async () => {
  const registrations: Array<Record<string, (input: unknown) => Promise<unknown>>> = []
  const bus = createEventBus()
  setEventBus(bus)
  let board: Awaited<ReturnType<typeof bindProgressBoard>> | undefined
  try {
    board = await bindProgressBoard({
      rpc: {
        register: async (
          def: unknown,
          handlers: Record<string, (input: unknown) => Promise<unknown>>,
        ) => {
          registrations.push({ id: (def as { id: string }).id, ...handlers })
          return { events: { emit: async () => {} } }
        },
      } as never,
    })
  } finally {
    setEventBus(createEventBus())
  }
  const reg = registrations[0]
  const out = (await reg.detail?.({ runId: "run_any" })) as { run: unknown }
  assert.equal(out.run, null)
  board?.dispose()
})

test("bindProgressBoard: session 方法（journal 定位步骤会话 -> 拉取 -> 截断）", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-board-session-"))
  const store = new FileExecutionStore(baseDir)

  const bus = createEventBus()
  setEventBus(bus)
  try {
    const journal = await RunJournal.start(store, {
      workflow: { id: "demo", version: "1.0.0" },
      stepCount: 2,
      stepNames: ["fanout", "wrap"],
      runId: "run_sess",
    })
    await journal.stepStarted(0)
    emitEvent({ type: "agent.completed", durationMs: 5, outputLength: 5, runId: "run_sess", sessionID: "ses_a" })
    emitEvent({ type: "agent.completed", durationMs: 5, outputLength: 5, runId: "run_sess", sessionID: "ses_b" })
    await journal.stepCompleted(0, "done")
    await journal.stepStarted(1)
    await journal.stepCompleted(1, "ok")
    await journal.complete()
  } finally {
    setEventBus(createEventBus())
  }

  const fetched: string[] = []
  const registrations: Array<Record<string, (input: unknown) => Promise<unknown>>> = []
  let board: Awaited<ReturnType<typeof bindProgressBoard>> | undefined
  board = await bindProgressBoard({
    rpc: {
      register: async (
        def: unknown,
        handlers: Record<string, (input: unknown) => Promise<unknown>>,
      ) => {
        registrations.push({ id: (def as { id: string }).id, ...handlers })
        return { events: { emit: async () => {} } }
      },
    } as never,
    store,
    fetchSessionMessages: async (sessionID) => {
      fetched.push(sessionID)
      return [
        { type: "user", text: "调研主题".repeat(600) },
        { type: "assistant", text: "结论".repeat(400) },
      ]
    },
  })

  const reg = registrations[0]
  assert.ok(reg)
  assert.equal(typeof reg.session, "function")

  // 命中：缺省取该步骤最后一个会话；条数保留 + 单条文本截断 800
  const hit = (await reg.session?.({ runId: "run_sess", step: "fanout" })) as {
    session: { sessionID: string; step?: string; messages: Array<{ type: string; text: string }> }
  }
  assert.deepEqual(fetched, ["ses_b"])
  assert.equal(hit.session.sessionID, "ses_b")
  assert.equal(hit.session.step, "fanout")
  assert.equal(hit.session.messages.length, 2)
  assert.ok(hit.session.messages[0]?.text.length <= 800)

  // index 选第一个会话（pipeline 多条目）
  const first = (await reg.session?.({ runId: "run_sess", step: "fanout", index: 0 })) as {
    session: { sessionID: string }
  }
  assert.equal(first.session.sessionID, "ses_a")

  // 未知步骤 / 无会话步骤 / 坏入参 -> null（不抛错）
  const noStep = (await reg.session?.({ runId: "run_sess", step: "nope" })) as { session: unknown }
  assert.equal(noStep.session, null)
  const noSession = (await reg.session?.({ runId: "run_sess", step: "wrap" })) as { session: unknown }
  assert.equal(noSession.session, null)
  const malformed = (await reg.session?.({ runId: "run_sess" })) as { session: unknown }
  assert.equal(malformed.session, null)

  board.dispose()
})

test("bindProgressBoard: 无 fetchSessionMessages（旧宿主）时 session 恒为 null", async () => {
  const registrations: Array<Record<string, (input: unknown) => Promise<unknown>>> = []
  const board = await bindProgressBoard({
    rpc: {
      register: async (
        def: unknown,
        handlers: Record<string, (input: unknown) => Promise<unknown>>,
      ) => {
        registrations.push({ id: (def as { id: string }).id, ...handlers })
        return { events: { emit: async () => {} } }
      },
    } as never,
  })
  const reg = registrations[0]
  const out = (await reg.session?.({ runId: "run_any", step: "any" })) as { session: unknown }
  assert.equal(out.session, null)
  board.dispose()
})
