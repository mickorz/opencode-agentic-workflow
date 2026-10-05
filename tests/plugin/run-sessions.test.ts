/**
 * run-sessions 单元测试 —— 并发 run 时代的递归防护判别
 * 覆盖：登记/注销生命周期、isInsideRunSession（直接命中/祖先链/未命中/
 *       跳数封顶防御）
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  isInsideRunSession,
  isRunSession,
  trackRunSession,
  trackedRunSessionCount,
  untrackRunSession,
} from "../../src/plugin/run-sessions.js"

test("登记生命周期：track 后可见，untrack 后不可见", () => {
  const before = trackedRunSessionCount()
  trackRunSession("sess_a")
  assert.equal(isRunSession("sess_a"), true)
  assert.equal(trackedRunSessionCount(), before + 1)
  untrackRunSession("sess_a")
  assert.equal(isRunSession("sess_a"), false)
  assert.equal(trackedRunSessionCount(), before)
  // 重复注销无害
  untrackRunSession("sess_a")
  assert.equal(trackedRunSessionCount(), before)
})

test("isInsideRunSession: 调用会话自身被登记（run 的直接 agent 会话）", async () => {
  trackRunSession("sess_run")
  try {
    const parent = async () => undefined
    assert.equal(await isInsideRunSession("sess_run", parent), true)
    assert.equal(await isInsideRunSession("sess_other", parent), false)
  } finally {
    untrackRunSession("sess_run")
  }
})

test("isInsideRunSession: 祖先链命中（run 的 agent 派生子 agent 再调工具）", async () => {
  trackRunSession("sess_run")
  try {
    // 子 agent -> run agent -> 主会话（无父）
    const parents = new Map([
      ["sess_subagent", "sess_run"],
      ["sess_main", undefined],
    ])
    const parent = async (id: string) => parents.get(id)
    assert.equal(await isInsideRunSession("sess_subagent", parent), true)
    assert.equal(await isInsideRunSession("sess_main", parent), false)
  } finally {
    untrackRunSession("sess_run")
  }
})

test("isInsideRunSession: 跳数封顶（防御环/脏数据；不无限遍历）", async () => {
  // 环：a -> b -> a（无命中），封顶后返回 false 而非死循环
  const parents = new Map([
    ["a", "b"],
    ["b", "a"],
  ])
  const parent = async (id: string) => parents.get(id)
  assert.equal(await isInsideRunSession("a", parent, 8), false)
  // 长链超出跳数：中途存在登记也只在前 maxHops 内判别
  trackRunSession("deep_10")
  try {
    const chain = new Map<string, string | undefined>()
    for (let i = 0; i < 12; i++) chain.set(`n${i}`, `n${i + 1}`)
    chain.set("n12", "deep_10")
    const chainParent = async (id: string) => chain.get(id)
    assert.equal(await isInsideRunSession("n0", chainParent, 8), false)
    assert.equal(await isInsideRunSession("n0", chainParent, 14), true)
  } finally {
    untrackRunSession("deep_10")
  }
})
