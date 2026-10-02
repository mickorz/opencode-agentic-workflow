/**
 * check / assert 单元测试
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { assert as assertCheck, check, WorkflowCheckError } from "../../src/quality/check.js"

test("check: returns ok=true when predicate passes (sync + async)", async () => {
  const sync = await check(() => true, "sync pass")
  const async_ = await check(async () => true, "async pass")
  assert.equal(sync.ok, true)
  assert.equal(async_.ok, true)
  assert.equal(sync.detail, undefined)
})

test("check: predicate returning truthy non-boolean counts as false", async () => {
  const result = await check(() => 1 as unknown as boolean, "strict boolean")
  assert.equal(result.ok, false)
})

test("check: throwing predicate becomes ok=false with detail", async () => {
  const result = await check(() => {
    throw new Error("boom")
  }, "throws")
  assert.equal(result.ok, false)
  assert.equal(result.detail, "boom")
})

test("assert: passes through CheckResult on success", async () => {
  const result = await assertCheck(() => true, "ok case")
  assert.equal(result.ok, true)
})

test("assert: throws WorkflowCheckError carrying result on failure", async () => {
  assert.rejects(
    () => assertCheck(() => false, "fail case"),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowCheckError)
      assert.equal(error.result.label, "fail case")
      assert.equal(error.result.ok, false)
      assert.match(error.message, /check failed: fail case/)
      return true
    },
  )
})
