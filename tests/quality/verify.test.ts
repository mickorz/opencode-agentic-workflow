/**
 * verify / assertVerify 单元测试 —— fake executor 注入评审输出
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { setExecutor } from "../../src/runtime/engine.js"
import { parseJsonLoose } from "../../src/quality/json.js"
import {
  assertVerify,
  verify,
  WorkflowVerifyError,
} from "../../src/quality/verify.js"

function reviewerExecutor(outputs: string[]) {
  let i = 0
  const prompts: string[] = []
  return {
    prompts,
    executor: {
      async execute(task: { prompt: string }) {
        prompts.push(task.prompt)
        const output = outputs[Math.min(i, outputs.length - 1)] ?? ""
        i += 1
        return { output }
      },
    },
  }
}

const PASS = JSON.stringify({ verdict: "pass", summary: "没问题", issues: [] })
const FAIL = JSON.stringify({ verdict: "fail", summary: "有缺陷", issues: ["缺测试"] })

test("parseJsonLoose: raw / fenced / decorated text", () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 })
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseJsonLoose('结论如下 {"a":1} 以上。'), { a: 1 })
  assert.equal(parseJsonLoose("完全不是 JSON"), undefined)
})

test("verify: single reviewer pass -> passed=true, never throws", async () => {
  const { executor } = reviewerExecutor([PASS])
  setExecutor(executor)
  const result = await verify("实现代码", { criteria: "符合需求" })
  assert.equal(result.passed, true)
  assert.equal(result.verdicts.length, 1)
  assert.equal(result.verdicts[0]?.verdict, "pass")
})

test("verify: reviewers=2, one fail -> passed=false", async () => {
  const { executor } = reviewerExecutor([PASS, FAIL])
  setExecutor(executor)
  const result = await verify("实现代码", { reviewers: 2 })
  assert.equal(result.passed, false)
  assert.equal(result.verdicts.length, 2)
  assert.deepEqual(
    result.verdicts.map((v) => v.verdict),
    ["pass", "fail"],
  )
})

test("verify: non-JSON reviewer output counts as fail", async () => {
  const { executor } = reviewerExecutor(["我觉得挺好的，没有问题"])
  setExecutor(executor)
  const result = await verify("实现代码")
  assert.equal(result.passed, false)
  assert.equal(result.verdicts[0]?.verdict, "fail")
  assert.match(result.verdicts[0]?.summary ?? "", /not valid JSON/)
})

test("verify: fenced JSON output is accepted", async () => {
  const { executor } = reviewerExecutor(["```json\n" + PASS + "\n```"])
  setExecutor(executor)
  const result = await verify("实现代码")
  assert.equal(result.passed, true)
})

test("verify: prompt contains artifact, criteria, reviewer index, JSON contract", async () => {
  const { executor, prompts } = reviewerExecutor([PASS, PASS])
  setExecutor(executor)
  await verify("ARTIFACT-X", { reviewers: 2, criteria: "安全无漏洞" })
  assert.equal(prompts.length, 2)
  assert.ok(prompts[0]?.includes("ARTIFACT-X"))
  assert.ok(prompts[0]?.includes("安全无漏洞"))
  assert.ok(prompts[0]?.includes("1/2"))
  assert.ok(prompts[1]?.includes("2/2"))
  assert.ok(prompts[0]?.includes('"verdict"'))
})

test("verify: AgentResult artifact uses .output field", async () => {
  const { executor, prompts } = reviewerExecutor([PASS])
  setExecutor(executor)
  await verify({ output: "OUTPUT-Y" })
  assert.ok(prompts[0]?.includes("OUTPUT-Y"))
})

test("verify: reviewers option floors at 1", async () => {
  const { executor, prompts } = reviewerExecutor([PASS])
  setExecutor(executor)
  await verify("x", { reviewers: 0 })
  assert.equal(prompts.length, 1)
})

test("assertVerify: throws WorkflowVerifyError carrying result on failure", async () => {
  const { executor } = reviewerExecutor([FAIL])
  setExecutor(executor)
  await assert.rejects(
    () => assertVerify("实现代码", { label: "代码评审" }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowVerifyError)
      assert.equal(error.result.passed, false)
      assert.equal(error.result.label, "代码评审")
      assert.match(error.message, /verify failed: 代码评审/)
      assert.match(error.message, /有缺陷/)
      return true
    },
  )
})

test("assertVerify: returns result on success", async () => {
  const { executor } = reviewerExecutor([PASS])
  setExecutor(executor)
  const result = await assertVerify("实现代码")
  assert.equal(result.passed, true)
})
