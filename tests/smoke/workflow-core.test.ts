/**
 * Workflow Core 单元测试 —— 全部使用 MockExecutor，不触碰 OpenCode
 *
 * 覆盖：
 *  - agent() 经 executor 执行（Acceptance 02 前置）
 *  - parallel() 并行扇出/汇总（Acceptance 02）
 *  - sequence() 顺序传递
 *  - phase() 仅输出日志不影响结果
 *  - 未绑定 executor 时 agent() 报错
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { MockExecutor, type AgentExecutor, type AgentResult } from "../../src/runtime/executor.js"
import { setExecutor } from "../../src/runtime/engine.js"
import { agent } from "../../src/workflow/agent.js"
import { parallel } from "../../src/workflow/parallel.js"
import { sequence } from "../../src/workflow/sequence.js"

test("agent() delegates to bound executor", async () => {
  setExecutor(new MockExecutor())
  const result = await agent("分析登录模块")
  assert.equal(result.output, "[mock] 分析登录模块")
})

test("parallel() fans out and collects results in order", async () => {
  const recorder: string[] = []
  const executor: AgentExecutor = {
    async execute(task) {
      recorder.push(task.prompt)
      return { output: `done:${task.prompt}` }
    },
  }
  setExecutor(executor)

  const results = await parallel([
    () => agent("A"),
    () => agent("B"),
    () => agent("C"),
  ])

  assert.deepEqual(
    results.map((r: AgentResult) => r.output),
    ["done:A", "done:B", "done:C"],
  )
  assert.equal(recorder.length, 3)
})

test("sequence() passes previous result to next step", async () => {
  setExecutor(new MockExecutor())

  const final = await sequence<string>([
    async () => "step-1",
    async (prev) => `${prev}-2`,
    async (prev) => `${prev}-3`,
  ])

  assert.equal(final, "step-1-2-3")
})

test("phase() is metadata-only and does not throw", async () => {
  setExecutor(new MockExecutor())
  // phase 只打日志；不抛错即通过
  const { phase } = await import("../../src/workflow/phase.js")
  phase("Research")
})

test("agent() without bound executor throws", async () => {
  // 带 query 导入绕过模块缓存，得到未绑定 executor 的全新 engine 实例
  const enginePath = new URL(`file://${process.cwd()}/src/runtime/engine.js?fresh=${Math.random()}`)
  const engineFresh = await import(enginePath.href)
  assert.throws(() => engineFresh.requireExecutor(), /no executor bound/)
})
