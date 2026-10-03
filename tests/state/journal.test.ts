/**
 * journal 模型单元测试 —— 纯函数，无 IO
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  createRun,
  generateRunId,
  isValidRunId,
  toErrorRecord,
} from "../../src/state/journal.js"

test("createRun: 初始形状（running / currentStep=-1 / steps 全 pending）", () => {
  const run = createRun({
    workflow: { id: "reliable", version: "1.0.0" },
    args: { topic: "登录" },
    stepNames: ["agent", "check", "verify", "checkpoint"],
    stepCount: 4,
  })
  assert.equal(run.status, "running")
  assert.equal(run.currentStep, -1)
  assert.equal(run.steps.length, 4)
  assert.deepEqual(
    run.steps.map((s) => s.status),
    ["pending", "pending", "pending", "pending"],
  )
  assert.equal(run.steps[1]?.name, "check")
  assert.deepEqual(run.args, { topic: "登录" })
  assert.ok(isValidRunId(run.runId))
  assert.equal(run.completedAt, undefined)
})

test("createRun: stepCount 校验（负数/小数抛错）", () => {
  assert.throws(() => createRun({ workflow: { id: "w", version: "1.0.0" }, stepCount: -1 }), /non-negative integer/)
  assert.throws(() => createRun({ workflow: { id: "w", version: "1.0.0" }, stepCount: 1.5 }), /non-negative integer/)
  // 0 合法（空 sequence）
  const run = createRun({ workflow: { id: "w", version: "1.0.0" }, stepCount: 0 })
  assert.deepEqual(run.steps, [])
})

test("generateRunId: 前缀格式且不重复", () => {
  const a = generateRunId()
  const b = generateRunId()
  assert.match(a, /^run_\d+_[0-9a-z]+$/)
  assert.notEqual(a, b)
})

test("isValidRunId: 白名单（防路径穿越）", () => {
  assert.ok(isValidRunId("run_1700000000_ab12cd34"))
  assert.ok(isValidRunId("a"))
  assert.ok(isValidRunId("A-b_2.3"))
  // 空串 / 路径穿越 / 斜杠 / 首字符非字母数字 / 超长
  assert.ok(!isValidRunId(""))
  assert.ok(!isValidRunId("../evil"))
  assert.ok(!isValidRunId("a/b"))
  assert.ok(!isValidRunId(".hidden"))
  assert.ok(!isValidRunId("x".repeat(129)))
})

test("toErrorRecord: Error 取 name+message，非 Error 字符串化", () => {
  assert.deepEqual(toErrorRecord(new Error("boom")), { name: "Error", message: "boom" })
  const custom = new Error("x")
  custom.name = "WorkflowCheckError"
  assert.deepEqual(toErrorRecord(custom), { name: "WorkflowCheckError", message: "x" })
  assert.deepEqual(toErrorRecord("plain"), { name: "Error", message: "plain" })
})
