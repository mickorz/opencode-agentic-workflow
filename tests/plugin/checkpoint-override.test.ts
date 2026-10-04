/**
 * checkpoint 调用级覆盖单测（P3 Blocker 修复：守护进程单例投毒）
 * 覆盖：parse 白名单（interactive 明确不支持）、无覆盖不动 gate、
 *       覆盖绑定策略门 + restore 恢复原门（含未绑定态）、行为级批准语义
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  applyCheckpointModeOverride,
  parseCheckpointModeOverride,
} from "../../src/plugin/checkpoint-override.js"
import { PolicyCheckpointGate } from "../../src/plugin/policy-checkpoint-gate.js"
import {
  getCheckpointGate,
  setCheckpointGate,
} from "../../src/quality/checkpoint.js"

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

test("apply: 无覆盖不动 gate，返回 undefined", () => {
  const before = getCheckpointGate()
  const restore = applyCheckpointModeOverride(undefined)
  assert.equal(restore, undefined)
  assert.equal(getCheckpointGate(), before)
})

test("apply: 覆盖绑定策略门，restore 恢复原门（含未绑定态）", () => {
  // 未绑定态：restore 应回到未绑定
  setCheckpointGate(undefined)
  let restore = applyCheckpointModeOverride("auto-approve")
  assert.ok(getCheckpointGate() instanceof PolicyCheckpointGate)
  restore?.()
  assert.equal(getCheckpointGate(), undefined)

  // 已绑定态：restore 恢复的是覆盖前的原门实例
  const original = new PolicyCheckpointGate("auto-reject")
  setCheckpointGate(original)
  restore = applyCheckpointModeOverride("auto-approve")
  assert.notEqual(getCheckpointGate(), original)
  restore?.()
  assert.equal(getCheckpointGate(), original)
})

test("apply: 行为验证——覆盖立即生效，restore 后回到原语义", async () => {
  setCheckpointGate(new PolicyCheckpointGate("auto-reject"))
  const restore = applyCheckpointModeOverride("auto-approve")
  try {
    const overridden = await getCheckpointGate()!.ask({ label: "l", message: "m" })
    assert.equal(overridden.approved, true)
  } finally {
    restore?.()
  }
  const restored = await getCheckpointGate()!.ask({ label: "l", message: "m" })
  assert.equal(restored.approved, false)
  assert.ok(restored.reason)
})
