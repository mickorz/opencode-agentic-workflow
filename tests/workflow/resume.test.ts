/**
 * sequence journal + resume 单元测试 —— 真实 FileExecutionStore
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { WorkflowSequenceError } from "../../src/runtime/errors.js"
import { FileExecutionStore } from "../../src/state/file-store.js"
import { RunJournal } from "../../src/state/recorder.js"
import type { ExecutionStore } from "../../src/state/store.js"
import { resumeSequence, sequence } from "../../src/workflow/sequence.js"

let baseDir: string
let store: ExecutionStore

test.before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-resume-"))
})

test.beforeEach(() => {
  store = new FileExecutionStore(baseDir)
})

test("journal 写侧: 全部成功 -> run completed，逐步 output 落盘", async () => {
  const journal = await RunJournal.start(store, {
    workflowId: "w",
    stepNames: ["s1", "s2"],
    stepCount: 2,
  })
  const result = await sequence<string>(
    [
      async () => "a",
      async (prev) => `${prev}-b`,
    ],
    { journal },
  )
  assert.equal(result, "a-b")

  const loaded = await store.getRun(journal.run.runId)
  assert.equal(loaded?.status, "completed")
  assert.deepEqual(
    loaded?.steps.map((s) => s.status),
    ["completed", "completed"],
  )
  assert.equal(loaded?.steps[0]?.output, "a")
  assert.equal(loaded?.steps[1]?.output, "a-b")
})

test("journal 写侧: 失败 -> run failed + failure 记录 + 后续步骤 skipped", async () => {
  const journal = await RunJournal.start(store, {
    workflowId: "w",
    stepNames: ["ok", "boom", "never"],
    stepCount: 3,
  })
  await assert.rejects(
    () =>
      sequence<string>([
        async () => "a",
        async () => {
          throw new Error("step-1 boom")
        },
        async () => "c",
      ], { journal }),
    /step-1 boom/,
  )

  const loaded = await store.getRun(journal.run.runId)
  assert.equal(loaded?.status, "failed")
  assert.deepEqual(
    loaded?.steps.map((s) => s.status),
    ["completed", "failed", "skipped"],
  )
  assert.deepEqual(loaded?.steps[1]?.error, { name: "Error", message: "step-1 boom" })
  assert.match(loaded?.failure?.message ?? "", /sequence failed/)
})

test("journal 写侧: continue 模式失败累积后统一收口", async () => {
  const journal = await RunJournal.start(store, { workflowId: "w", stepCount: 3 })
  await assert.rejects(
    () =>
      sequence<string>(
        [
          async () => "a",
          async () => {
            throw new Error("boom-1")
          },
          async (prev) => `${prev}-c`,
        ],
        { journal, onFailure: "continue" },
      ),
    /boom-1/,
  )

  const loaded = await store.getRun(journal.run.runId)
  assert.equal(loaded?.status, "failed")
  assert.deepEqual(
    loaded?.steps.map((s) => s.status),
    ["completed", "failed", "completed"],
  )
})

test("resume: 失败的 run 恢复 -> completed 前缀跳过，从失败步骤重跑", async () => {
  // 第一次执行：step2 失败
  const journal = await RunJournal.start(store, {
    workflowId: "reliable",
    stepNames: ["s1", "s2", "s3"],
    stepCount: 3,
  })
  await assert.rejects(
    () =>
      sequence<string>([
        async () => "产物A",
        async () => {
          throw new Error("transient failure")
        },
        async (prev) => `${prev}-C`,
      ], { journal }),
    /transient/,
  )
  const runId = journal.run.runId

  // 恢复：同一 workflow 定义，step2 修复后成功
  const executed: number[] = []
  const result = await resumeSequence<string>(
    store,
    runId,
    [
      async () => {
        executed.push(0)
        return "产物A-重跑" // 不应执行
      },
      async (prev) => {
        executed.push(1)
        return `${prev}-B`
      },
      async (prev) => {
        executed.push(2)
        return `${prev}-C`
      },
    ],
    { stepNames: ["s1", "s2", "s3"] },
  )

  assert.equal(result, "产物A-B-C") // step1 取 journal 输出「产物A」
  assert.deepEqual(executed, [1, 2]) // step0 未重跑

  const loaded = await store.getRun(runId)
  assert.equal(loaded?.status, "completed")
  assert.deepEqual(
    loaded?.steps.map((s) => s.status),
    ["completed", "completed", "completed"],
  )
  assert.equal(loaded?.steps[2]?.output, "产物A-B-C")
})

test("resume: 崩溃中断（步骤 running）-> 从该步骤重跑", async () => {
  // 手工模拟：step0 完成、step1 刚 started 进程就崩溃（run 仍是 running）
  const journal = await RunJournal.start(store, {
    workflowId: "w",
    stepCount: 2,
  })
  await journal.stepStarted(0)
  await journal.stepCompleted(0, "A")
  await journal.stepStarted(1) // 崩溃：停在 running
  const runId = journal.run.runId

  const executed: number[] = []
  const result = await resumeSequence<string>(store, runId, [
    async () => {
      executed.push(0)
      return "A-re"
    },
    async (prev) => {
      executed.push(1)
      return `${prev}-B`
    },
  ])

  assert.equal(result, "A-B")
  assert.deepEqual(executed, [1])

  const loaded = await store.getRun(runId)
  assert.equal(loaded?.status, "completed")
})

test("resume: 已完成的 run 幂等返回最后输出，不执行任何步骤", async () => {
  const journal = await RunJournal.start(store, { workflowId: "w", stepCount: 2 })
  await sequence<string>([async () => "a", async (p) => `${p}-b`], { journal })

  const executed: number[] = []
  const result = await resumeSequence<string>(store, journal.run.runId, [
    async () => {
      executed.push(0)
      return "x"
    },
    async () => {
      executed.push(1)
      return "y"
    },
  ])
  assert.equal(result, "a-b") // journal 最后输出
  assert.deepEqual(executed, [])
})

test("resume: prev 链来自 journal 输出（含对象值）", async () => {
  const journal = await RunJournal.start(store, { workflowId: "w", stepCount: 2 })
  await assert.rejects(
    () =>
      sequence<{ output: string }>([
        async () => ({ output: "artifact" }),
        async () => {
          throw new Error("x")
        },
      ], { journal }),
    /x/,
  )

  const seenPrev: Array<{ output: string } | undefined> = []
  await resumeSequence<{ output: string }>(store, journal.run.runId, [
    async () => ({ output: "should-not-run" }),
    async (prev) => {
      seenPrev.push(prev)
      return { output: "final" }
    },
  ])
  assert.deepEqual(seenPrev, [{ output: "artifact" }])
})

test("resume: run 不存在 / 步骤数不匹配 -> 明确抛错", async () => {
  await assert.rejects(
    () => resumeSequence(store, "run_missing", [async () => "a"]),
    /run not found/,
  )

  const journal = await RunJournal.start(store, { workflowId: "w", stepCount: 3 })
  await journal.fail(new Error("x"))
  await assert.rejects(
    () => resumeSequence(store, journal.run.runId, [async () => "a", async () => "b"]),
    /step count mismatch/,
  )
})

test("reopen: completed run 拒绝 reopen；failed run 重置未完成步骤", async () => {
  const completed = await RunJournal.start(store, { workflowId: "w", stepCount: 1 })
  await completed.stepStarted(0)
  await completed.stepCompleted(0)
  await completed.complete()
  await assert.rejects(() => completed.reopen(), /cannot reopen completed/)

  const failed = await RunJournal.start(store, {
    workflowId: "w",
    stepNames: ["a", "b", "c"],
    stepCount: 3,
  })
  await failed.stepStarted(0)
  await failed.stepCompleted(0, "A")
  await failed.stepStarted(1)
  await failed.stepFailed(1, new Error("boom"))
  await failed.fail(new Error("run failed"))

  await failed.reopen()
  const loaded = await store.getRun(failed.run.runId)
  assert.equal(loaded?.status, "running")
  assert.equal(loaded?.completedAt, undefined)
  assert.equal(loaded?.failure, undefined)
  assert.deepEqual(
    loaded?.steps.map((s) => s.status),
    ["completed", "pending", "pending"],
  )
  assert.equal(loaded?.steps[1]?.error, undefined)
  assert.equal(loaded?.steps[0]?.output, "A") // completed 保留
})

test("journal 步骤数与 steps 不一致 -> sequence 直接抛错", async () => {
  const journal = await RunJournal.start(store, { workflowId: "w", stepCount: 3 })
  await assert.rejects(
    () => sequence<string>([async () => "a"], { journal }),
    /step count mismatch/,
  )
})
