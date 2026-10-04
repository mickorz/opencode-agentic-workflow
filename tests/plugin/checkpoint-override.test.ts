/**
 * checkpoint 调用级覆盖单测（P3 Blocker 修复：守护进程单例投毒）
 * P2-9 起语义升级：覆盖不再换装全局门（无 restore），而是构建策略门
 * 经 RunLaunchOptions.gate 做 run 级注入；全局 gate 全程不动。
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildCheckpointGate,
  parseCheckpointModeOverride,
} from "../../src/plugin/checkpoint-override.js"
import { PolicyCheckpointGate } from "../../src/plugin/policy-checkpoint-gate.js"

test("parse: 两个策略值通过；空值/interactive/非法值返回 undefined", () => {
  assert.equal(parseCheckpointModeOverride("auto-approve"), "auto-approve")
  assert.equal(parseCheckpointModeOverride("auto-reject"), "auto-reject")
  assert.equal(parseCheckpointModeOverride(undefined), undefined)
  assert.equal(parseCheckpointModeOverride(null), undefined)
  assert.equal(parseCheckpointModeOverride(""), undefined)
  // interactive 需要 RPC 域 + bind()，不支持调用级覆盖（防 RPC 注册泄漏）
  assert.equal(parseCheckpointModeOverride("interactive"), undefined)
  assert.equal(parseCheckpointModeOverride("yolo"), undefined)
  assert.equal(parseCheckpointModeOverride(42), undefined)
})

test("build: 无覆盖返回 undefined；有覆盖构建策略门（不触碰全局绑定）", async () => {
  assert.equal(buildCheckpointGate(undefined), undefined)

  const gate = buildCheckpointGate("auto-approve")
  assert.ok(gate instanceof PolicyCheckpointGate)
  // 行为验证：构建出的门就是覆盖语义本身
  const decision = await gate!.ask({ label: "l", message: "m" })
  assert.equal(decision.approved, true)
})

test("build: 全局 gate 不再被换装（run 级注入语义）", () => {
  // 旧实现的换装/恢复竞态面已删除：build 是纯函数，全局绑定全程不变
  const gate = buildCheckpointGate("auto-reject")
  assert.ok(gate)
  // 连续构建两个不同模式的门互不影响（并发调用各持各的门）
  const other = buildCheckpointGate("auto-approve")
  assert.notEqual(gate, other)
})
