/**
 * kebabCase 单元测试 —— 分隔符归一 + 小写化
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { kebabCase } from "../../src/utils/string-case.js"

test("kebabCase: 普通英文句子", () => {
  assert.equal(kebabCase("hello world"), "hello-world")
})

test("kebabCase: 大小写混合", () => {
  assert.equal(kebabCase("Hello World FOO"), "hello-world-foo")
})

test("kebabCase: 单个连字符保留", () => {
  assert.equal(kebabCase("foo-bar"), "foo-bar")
})

test("kebabCase: 多个连字符归一", () => {
  assert.equal(kebabCase("foo--bar"), "foo-bar")
})

test("kebabCase: 下划线与连字符混用", () => {
  assert.equal(kebabCase("foo_bar-baz"), "foo-bar-baz")
})

test("kebabCase: 连续空格", () => {
  assert.equal(kebabCase("hello   world"), "hello-world")
})

test("kebabCase: 空串", () => {
  assert.equal(kebabCase(""), "")
})

test("kebabCase: 混合分隔符", () => {
  assert.equal(kebabCase("foo_bar baz"), "foo-bar-baz")
})

test("kebabCase: 首尾分隔符", () => {
  assert.equal(kebabCase("  hi -- there "), "hi-there")
})
