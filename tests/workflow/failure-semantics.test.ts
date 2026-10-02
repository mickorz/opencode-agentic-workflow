/**
 * 失败语义测试 —— sequence / parallel 的 fail-fast / continue / collect / partial
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  WorkflowCheckError,
} from "../../src/quality/check.js"
import {
  WorkflowError,
  WorkflowParallelError,
  WorkflowSequenceError,
} from "../../src/runtime/errors.js"
import {
  WorkflowVerifyError,
} from "../../src/quality/verify.js"
import { parallel } from "../../src/workflow/parallel.js"
import { sequence } from "../../src/workflow/sequence.js"

// ---- sequence ----

test("sequence fail-fast: 第一步骤失败即中止，后续不执行", async () => {
  const executed: number[] = []
  await assert.rejects(
    () =>
      sequence<string>([
        async () => {
          executed.push(0)
          return "a"
        },
        async () => {
          executed.push(1)
          throw new Error("step-1 boom")
        },
        async () => {
          executed.push(2)
          return "c"
        },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowSequenceError)
      assert.equal(error.errors.length, 1)
      assert.equal(error.errors[0]?.stepIndex, 1)
      assert.equal(error.lastValue, "a")
      assert.ok(error.errors[0]?.cause instanceof Error)
      return true
    },
  )
  assert.deepEqual(executed, [0, 1])
})

test("sequence fail-fast: stepNames 出现在错误信息中", async () => {
  await assert.rejects(
    () =>
      sequence<string>(
        [
          async () => {
            throw new Error("boom")
          },
        ],
        { stepNames: ["check-tests"] },
      ),
    /step #0 \(check-tests\)/,
  )
})

test("sequence continue: 失败后仍执行全部步骤，prev 为最后一次成功值", async () => {
  const executed: number[] = []
  const seenPrev: Array<string | undefined> = []

  await assert.rejects(
    () =>
      sequence<string>(
        [
          async () => {
            executed.push(0)
            return "a"
          },
          async () => {
            executed.push(1)
            throw new Error("boom-1")
          },
          async (prev) => {
            executed.push(2)
            seenPrev.push(prev)
            return "c"
          },
        ],
        { onFailure: "continue" },
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowSequenceError)
      assert.equal(error.errors.length, 1)
      assert.equal(error.errors[0]?.stepIndex, 1)
      assert.equal(error.lastValue, "c")
      return true
    },
  )

  assert.deepEqual(executed, [0, 1, 2])
  assert.deepEqual(seenPrev, ["a"]) // 步骤 2 收到的是步骤 0 的成功值
})

test("sequence continue: 全部成功时正常返回", async () => {
  const result = await sequence<string>(
    [
      async () => "a",
      async (prev) => `${prev}-b`,
    ],
    { onFailure: "continue" },
  )
  assert.equal(result, "a-b")
})

// ---- parallel ----

test("parallel fail-fast: 第一个失败即拒绝，且晚到失败不产生 unhandled rejection", async () => {
  process.on("unhandledRejection", (reason) => {
    assert.fail(`unhandled rejection: ${String(reason)}`)
  })

  await assert.rejects(
    () =>
      parallel([
        () =>
          new Promise<string>((_, rej) =>
            setTimeout(() => rej(new Error("fast-fail")), 10),
          ),
        () =>
          new Promise<string>((_, rej) =>
            setTimeout(() => rej(new Error("late-fail")), 40),
          ),
        () => new Promise<string>((res) => setTimeout(() => res("ok"), 5)),
      ]),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowParallelError)
      assert.equal(error.mode, "fail-fast")
      assert.equal(error.failures.length, 1)
      assert.equal(error.failures[0]?.index, 0)
      return true
    },
  )

  // 等晚到的 rejection 走完事件循环；若未吞掉会触发上面的 unhandledRejection 断言
  await new Promise((res) => setTimeout(res, 80))
  process.removeAllListeners("unhandledRejection")
})

test("parallel collect: 等全部落定，携带全部失败与成功结果", async () => {
  await assert.rejects(
    () =>
      parallel(
        [
          () => Promise.resolve("r0"),
          () => Promise.reject(new Error("e1")),
          () => Promise.resolve("r2"),
        ],
        { onFailure: "collect" },
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowParallelError)
      assert.equal(error.mode, "collect")
      assert.deepEqual(
        error.failures.map((f: { index: number }) => f.index),
        [1],
      )
      assert.equal(error.results[0], "r0")
      assert.equal(error.results[1], undefined)
      assert.equal(error.results[2], "r2")
      return true
    },
  )
})

test("parallel partial: 失败槽位 undefined，不抛错", async () => {
  const results = await parallel<string | undefined>(
    [
      () => Promise.resolve("r0"),
      () => Promise.reject(new Error("e1")),
      () => Promise.resolve("r2"),
    ],
    { onFailure: "partial" },
  )
  assert.deepEqual(results, ["r0", undefined, "r2"])
})

test("parallel: 空任务数组返回空结果（各模式）", async () => {
  assert.deepEqual(await parallel([]), [])
  assert.deepEqual(await parallel([], { onFailure: "collect" }), [])
  assert.deepEqual(await parallel([], { onFailure: "partial" }), [])
})

test("parallel 默认 fail-fast 保持 P0 行为：全部成功返回有序结果", async () => {
  const results = await parallel([
    () => Promise.resolve("a"),
    () => Promise.resolve("b"),
  ])
  assert.deepEqual(results, ["a", "b"])
})

// ---- 错误家族 ----

test("错误家族：Check/Verify/Sequence/Parallel 均为 WorkflowError", async () => {
  const check = new WorkflowCheckError({ label: "l", ok: false })
  const verify = new WorkflowVerifyError({
    label: "l",
    passed: false,
    verdicts: [],
  })
  const seq = new WorkflowSequenceError([], undefined)
  const par = new WorkflowParallelError([], [], "fail-fast")

  for (const error of [check, verify, seq, par]) {
    assert.ok(error instanceof WorkflowError)
    assert.ok(error instanceof Error)
  }
})
