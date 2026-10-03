/**
 * titlecase 单元测试 —— 分词大小写归一 + 空白保留
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { titlecase } from "../../src/utils/titlecase.js"

test("titlecase: 普通句子", () => {
  assert.equal(titlecase("hello world foo"), "Hello World Foo")
})

test("titlecase: 已混合大小写归一", () => {
  assert.equal(titlecase("hELLo WoRLD"), "Hello World")
})

test("titlecase: 空串", () => {
  assert.equal(titlecase(""), "")
})

test("titlecase: 多连续空格（空格数量不变）", () => {
  assert.equal(titlecase("hello   world"), "Hello   World")
})

test("titlecase: 单字母", () => {
  assert.equal(titlecase("a"), "A")
})

test("titlecase: 单字母句子", () => {
  assert.equal(titlecase("a b c"), "A B C")
})
