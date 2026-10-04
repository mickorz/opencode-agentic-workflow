/**
 * P1-3 后台运行 + run 控制 单测
 * 覆盖：detached 先行返回 runId / completion 收口 / 协作式取消（步骤边界，
 * journal=aborted、剩余步 skipped）/ 阻塞路径取消同样收口 aborted /
 * 孤儿 stop 直接收口 / status 列表与详情格式 / 已终态 stop 幂等 /
 * aborted run 可 resume 续跑
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { WorkflowRegistry } from "../../src/registry/registry.js"
import {
  startWorkflow,
  startWorkflowDetached,
  resumeWorkflow,
} from "../../src/registry/runner.js"
import { WorkflowExecutionError } from "../../src/registry/errors.js"
import { isLive, requestCancel } from "../../src/registry/run-control.js"
import { FileExecutionStore } from "../../src/state/file-store.js"
import type { ExecutionStore } from "../../src/state/store.js"
import { RunJournal } from "../../src/state/recorder.js"
import { controlStatus, controlStop } from "../../src/plugin/workflow-control.js"

let baseDir: string
/** 步骤钩子：每个步骤执行时挂起直到放行（未设置 = 立即通过） */
let stepHook: (() => Promise<void>) | undefined

test.before(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "agw-ctl-"))
})

function newStore(): ExecutionStore {
  return new FileExecutionStore(
    path.join(baseDir, `journal-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  )
}

/** 两步流程：每步执行前先过 stepHook（测试用它制造挂起点） */
function twoStepFlow(id: string) {
  return {
    id,
    version: "1.0.0",
    description: "two steps",
    stepNames: ["s1", "s2"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async run(_args: unknown, ctx: any) {
      const ran: string[] = []
      await ctx.runSteps([
        async () => {
          await stepHook?.()
          ran.push("s1")
          return { s: "s1" } as never
        },
        async () => {
          await stepHook?.()
          ran.push("s2")
          return { s: "s2" } as never
        },
      ])
      return { output: `ran:${ran.join("+")}` }
    },
  }
}

/** 手动闸门：第 n 次钩子调用挂起，直到 release(n) */
function manualGates() {
  const releases: Array<() => void> = []
  const promises: Array<Promise<void>> = []
  stepHook = () => {
    const p = new Promise<void>((resolve) => {
      releases.push(resolve)
    })
    promises.push(p)
    return p
  }
  return {
    release(index: number) {
      releases[index]?.()
    },
    async settled() {
      await Promise.allSettled(promises)
    },
  }
}

/** 轮询 journal 直到第 index 步进入指定状态（消除微任务时序竞态） */
async function waitForStep(
  store: ExecutionStore,
  runId: string,
  index: number,
  status: string,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const run = await store.getRun(runId)
    if (run?.steps[index]?.status === status) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`step ${index} never reached status ${status}`)
}

test.afterEach(() => {
  stepHook = undefined
})

test("detached：立即返回 runId（执行未完），completion 随后收口 completed", async () => {
  const registry = new WorkflowRegistry().register(twoStepFlow("bg-flow"))
  const store = newStore()
  const gates = manualGates()

  const detached = await startWorkflowDetached(registry, store, "bg-flow", { topic: "T" })
  assert.ok(detached.runId.length > 0)
  // s1 已启动（挂起中）：run running、活体已登记
  await waitForStep(store, detached.runId, 0, "running")
  assert.equal(isLive(detached.runId), true)
  assert.equal((await store.getRun(detached.runId))?.status, "running")

  const done = detached.completion
  gates.release(0)
  await waitForStep(store, detached.runId, 1, "running") // s2 钩子已挂起
  gates.release(1)
  const result = await done
  assert.match(result.output, /ran:s1\+s2/)
  assert.equal((await store.getRun(detached.runId))?.status, "completed")
  assert.equal(isLive(detached.runId), false)
})

test("stop 活体：协作式取消在步骤边界生效，journal=aborted、剩余步 skipped", async () => {
  const registry = new WorkflowRegistry().register(twoStepFlow("stop-flow"))
  const store = newStore()
  const gates = manualGates()

  const detached = await startWorkflowDetached(registry, store, "stop-flow", { topic: "T" })
  // s1 挂起中（已过 s1 边界检查）→ 此时 stop，取消必落在 s2 边界
  await waitForStep(store, detached.runId, 0, "running")
  const stopMsg = await controlStop(store, detached.runId)
  assert.match(stopMsg, /stop requested.*next step boundary/s)

  const outcome = detached.completion.then(
    () => "resolved",
    (e) => (e instanceof WorkflowExecutionError ? "rejected-wrapped" : `other:${e.constructor.name}`),
  )
  gates.release(0) // s1 执行完 → s2 边界检查命中取消
  assert.equal(await outcome, "rejected-wrapped")

  const run = (await store.getRun(detached.runId))!
  assert.equal(run.status, "aborted")
  assert.equal(run.steps[0]!.status, "completed")
  assert.equal(run.steps[1]!.status, "skipped")
  const detail = await controlStatus(store, detached.runId)
  assert.match(detail, /status: aborted/)
  assert.match(detail, /aborted run can be resumed/)
})

test("阻塞路径取消：startWorkflow 同样收口 aborted（非 failed）", async () => {
  const registry = new WorkflowRegistry().register({
    ...twoStepFlow("fg-stop"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async run(_args: unknown, ctx: any) {
      let ran = 0
      await ctx.runSteps([
        async () => {
          ran += 1
          requestCancel(ctx.runId) // 第一步内请求取消 → 第二步边界触发
          return { n: ran } as never
        },
        async () => {
          ran += 1
          return { n: ran } as never
        },
      ])
      return { output: `ran:${ran}` }
    },
  })
  const store = newStore()
  await assert.rejects(
    startWorkflow(registry, store, "fg-stop", { topic: "T" }),
    WorkflowExecutionError,
  )
  const runs = await store.listRuns("fg-stop")
  assert.equal(runs[0]!.status, "aborted")
})

test("孤儿 stop：journal running 但无活体 → 直接收口 aborted（悬置 run 解）", async () => {
  const store = newStore()
  // 人造悬置：journal 落盘 running 后进程"消失"（不执行、无活体登记）
  const journal = await RunJournal.start(store, {
    workflow: { id: "ghost", version: "1.0.0" },
    args: { topic: "T" },
    stepNames: ["a", "b"],
    stepCount: 2,
  })
  const msg = await controlStop(store, journal.run.runId)
  assert.match(msg, /orphaned.*marked aborted/s)
  const run = (await store.getRun(journal.run.runId))!
  assert.equal(run.status, "aborted")
  assert.equal(run.steps.every((s) => s.status === "skipped"), true)
})

test("已终态 stop 幂等：completed 的 run 再 stop 只报状态不动数据", async () => {
  const registry = new WorkflowRegistry().register(twoStepFlow("done-flow"))
  const store = newStore()
  const finished = await startWorkflow(registry, store, "done-flow", { topic: "T" })
  const msg = await controlStop(store, finished.runId)
  assert.match(msg, /already completed - nothing to stop/)
  assert.equal((await store.getRun(finished.runId))?.status, "completed")
})

test("status：空库报无记录；有 run 列表倒序带步数进度", async () => {
  const store = newStore()
  assert.match(await controlStatus(store), /no runs recorded/)
  await RunJournal.start(store, {
    workflow: { id: "w1", version: "1.0.0" },
    args: { topic: "T" },
    stepNames: ["a"],
    stepCount: 1,
  })
  const list = await controlStatus(store)
  assert.match(list, /1 run\(s\), newest first/)
  assert.match(list, /w1@1\.0\.0 running steps=0\/1/)
})

test("status 单 run 不存在：明确报 not found", async () => {
  const store = newStore()
  assert.match(await controlStatus(store, "run_nonexistent"), /run not found: run_nonexistent/)
})

test("aborted run 可 resume：跳过 completed 前缀续跑并收口 completed", async () => {
  const store = newStore()
  // 造一条 aborted 且 s1 completed 的 run（模拟中途停止）
  const journal = await RunJournal.start(store, {
    workflow: { id: "two", version: "1.0.0" },
    args: { topic: "T" },
    stepNames: ["s1", "s2"],
    stepCount: 2,
  })
  await journal.stepStarted(0)
  await journal.stepCompleted(0, { s: "s1" })
  await journal.abort(new Error("stopped"))
  const runId = journal.run.runId

  const registry = new WorkflowRegistry().register(twoStepFlow("two"))
  const resumed = await resumeWorkflow(registry, store, runId)
  assert.match(resumed.output, /ran:s2/)
  assert.equal((await store.getRun(runId))?.status, "completed")
})
