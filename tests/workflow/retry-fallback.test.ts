/**
 * retry / fallback 单元测试 —— 含用户链路组合：agent -> check fail -> retry -> fallback
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  WorkflowFallbackError,
  WorkflowRetryError,
} from "../../src/runtime/errors.js"
import { fallback } from "../../src/workflow/fallback.js"
import { retry } from "../../src/workflow/retry.js"

function flakyTask(failTimes: number, cause: Error, onCall?: (n: number) => void) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    task: async (): Promise<string> => {
      calls += 1
      onCall?.(calls)
      if (calls <= failTimes) throw cause
      return `ok#${calls}`
    },
  }
}

test("retry: 第一次失败第二次成功 -> 返回成功值", async () => {
  const flaky = flakyTask(1, new Error("transient"))
  const result = await retry(flaky.task, { attempts: 3, delayMs: 1 })
  assert.equal(result, "ok#2")
  assert.equal(flaky.calls, 2)
})

test("retry: 耗尽 -> WorkflowRetryError(attempts, lastError)", async () => {
  const boom = new Error("always-fails")
  const flaky = flakyTask(99, boom)
  await assert.rejects(
    () => retry(flaky.task, { attempts: 3, delayMs: 1, label: "gen-code" }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowRetryError)
      assert.equal(error.attempts, 3)
      assert.equal(error.lastError, boom)
      assert.match(error.message, /3 attempts, gen-code/)
      assert.match(error.message, /always-fails/)
      return true
    },
  )
  assert.equal(flaky.calls, 3)
})

test("retry: attempts=1 不重试", async () => {
  const flaky = flakyTask(1, new Error("x"))
  await assert.rejects(() => retry(flaky.task, { attempts: 1, delayMs: 1 }))
  assert.equal(flaky.calls, 1)
})

test("retry: fixed 退避按 delayMs 等待", async () => {
  const flaky = flakyTask(2, new Error("x")) // 两次失败 -> 两次等待
  const start = Date.now()
  await retry(flaky.task, { attempts: 3, delayMs: 30, backoff: "fixed" })
  const elapsed = Date.now() - start
  assert.ok(elapsed >= 60, `elapsed=${elapsed}ms should be >= 60ms`)
})

test("retry: exponential 退避 1x/2x 且封顶 maxDelayMs", async () => {
  const flaky = flakyTask(99, new Error("x")) // 永远失败 -> 等待 10 + 20 + 25(封顶)
  const start = Date.now()
  await assert.rejects(() =>
    retry(flaky.task, {
      attempts: 4,
      delayMs: 10,
      backoff: "exponential",
      maxDelayMs: 25,
    }),
  )
  const elapsed = Date.now() - start
  // 10 + 20 + 25 = 55ms
  assert.ok(elapsed >= 55, `elapsed=${elapsed}ms should be >= 55ms`)
})

test("retry: retryOn 返回 false -> 原样抛出不包装", async () => {
  const quota = new Error("FreeUsageLimitError")
  const flaky = flakyTask(99, quota)
  await assert.rejects(
    () =>
      retry(flaky.task, {
        attempts: 5,
        delayMs: 1,
        retryOn: (e) => !String((e as Error).message).includes("FreeUsageLimit"),
      }),
    (error: unknown) => {
      assert.equal(error, quota) // 原始异常，非 WorkflowRetryError
      return true
    },
  )
  assert.equal(flaky.calls, 1)
})

test("fallback: 首个成功 -> 后续候选不执行", async () => {
  let secondCalled = false
  const result = await fallback([
    async () => "primary",
    async () => {
      secondCalled = true
      return "backup"
    },
  ])
  assert.equal(result, "primary")
  assert.equal(secondCalled, false)
})

test("fallback: 首个失败 -> 第二个成功", async () => {
  const result = await fallback(
    [
      async () => {
        throw new Error("primary down")
      },
      async () => "backup",
    ],
    { label: "deploy" },
  )
  assert.equal(result, "backup")
})

test("fallback: 全部失败 -> WorkflowFallbackError(errors 按序)", async () => {
  const e0 = new Error("c0")
  const e1 = new Error("c1")
  await assert.rejects(
    () =>
      fallback([
        async () => {
          throw e0
        },
        async () => {
          throw e1
        },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowFallbackError)
      assert.equal(error.errors[0], e0)
      assert.equal(error.errors[1], e1)
      assert.match(error.message, /c0/)
      assert.match(error.message, /c1/)
      return true
    },
  )
})

test("用户链路组合: retry 耗尽后降级到 fallback 候选", async () => {
  // 模拟：主路径（agent+check）总是失败，重试 2 次后走降级路径
  let primaryAttempts = 0
  let degradedCalled = false

  const result = await fallback([
    () =>
      retry(
        async () => {
          primaryAttempts += 1
          throw new Error("check failed: tests must pass")
        },
        { attempts: 2, delayMs: 1, label: "primary" },
      ),
    async () => {
      degradedCalled = true
      return "degraded-result"
    },
  ])

  assert.equal(result, "degraded-result")
  assert.equal(primaryAttempts, 2)
  assert.equal(degradedCalled, true)
})
