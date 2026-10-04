/**
 * buildWorkflowArgs 单测（v1-parity P0-1：args 工具层透传）
 * 覆盖：无 args 仅 topic / 合并 / topic 优先级 / args 自带 topic /
 *       null 容忍 / 非对象 fail-loud
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { buildWorkflowArgs } from "../../src/plugin/tool-args.js"

test("无 args：仅 topic（向后兼容内置流程的原有形态）", () => {
  assert.deepEqual(buildWorkflowArgs("T", undefined), { topic: "T" })
  assert.deepEqual(buildWorkflowArgs("T", null), { topic: "T" })
})

test("合并：args 展开为 payload，topic 顶层叠加", () => {
  assert.deepEqual(buildWorkflowArgs("T", { audience: "中学生", depth: 2 }), {
    topic: "T",
    audience: "中学生",
    depth: 2,
  })
})

test("优先级：顶层 topic 覆盖 args.topic（显式字段是 canonical 来源）", () => {
  assert.equal(buildWorkflowArgs("TOP", { topic: "INNER" }).topic, "TOP")
  // 顶层未给 topic 时 args.topic 原样保留
  assert.equal(buildWorkflowArgs(undefined, { topic: "INNER" }).topic, "INNER")
})

test("两者皆空：空对象（required 校验会点名 missing topic）", () => {
  assert.deepEqual(buildWorkflowArgs(undefined, undefined), {})
})

test("fail-loud：args 非对象直接抛错（数组/字符串/数字），不静默吞", () => {
  assert.throws(() => buildWorkflowArgs("T", ["a"]), /must be an object.*array/)
  assert.throws(() => buildWorkflowArgs("T", "audience=x"), /must be an object/)
  assert.throws(() => buildWorkflowArgs("T", 42), /must be an object/)
})
