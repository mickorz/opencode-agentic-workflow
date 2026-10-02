/**
 * 并发限制测试 —— 验证 withConcurrencyLimit 的上限与 FIFO 排队
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import type { AgentExecutor } from "../../src/runtime/executor.js"
import { Semaphore, withConcurrencyLimit } from "../../src/runtime/semaphore.js"

function defer() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => (resolve = res))
  return { resolve, promise }
}

test("Semaphore: never exceeds limit, FIFO handoff", async () => {
  const limit = 3
  const semaphore = new Semaphore(limit)
  let active = 0
  let peak = 0
  const order: number[] = []

  const jobs = Array.from({ length: 8 }, (_, i) =>
    semaphore.run(async () => {
      active += 1
      peak = Math.max(peak, active)
      order.push(i)
      await new Promise((res) => setTimeout(res, 10))
      active -= 1
      return i
    }),
  )

  const results = await Promise.all(jobs)
  assert.equal(peak, limit)
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7])
})

test("Semaphore: slot released after failure", async () => {
  const semaphore = new Semaphore(1)
  const gate = defer()

  const first = semaphore.run(async () => {
    await gate.promise
    throw new Error("boom")
  })
  const second = semaphore.run(async () => "ok")

  // 先放行 gate 再 await first，否则 first 永远不 reject，测试死锁
  await Promise.resolve() // 让 second 进入等待队列
  gate.resolve()

  await assert.rejects(() => first, /boom/)
  assert.equal(await second, "ok")
})

test("withConcurrencyLimit: caps concurrent executor calls at 3 (default)", async () => {
  let active = 0
  let peak = 0
  const slow: AgentExecutor = {
    async execute(task) {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((res) => setTimeout(res, 15))
      active -= 1
      return { output: task.prompt }
    },
  }

  const limited = withConcurrencyLimit(slow)
  const results = await Promise.all(
    Array.from({ length: 7 }, (_, i) => limited.execute({ prompt: `t${i}` })),
  )

  assert.equal(peak, 3)
  assert.deepEqual(
    results.map((r) => r.output),
    ["t0", "t1", "t2", "t3", "t4", "t5", "t6"],
  )
})
