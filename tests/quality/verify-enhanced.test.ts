/**
 * P2-11 verify 增强 单测：passThreshold 投票 + lenses 多视角
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { setExecutor } from "../../src/runtime/engine.js"
import { verify } from "../../src/quality/verify.js"

const PASS = JSON.stringify({ verdict: "pass", summary: "没问题", issues: [] })
const FAIL = JSON.stringify({ verdict: "fail", summary: "有缺陷", issues: ["缺测试"] })

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

test.afterEach(() => {
  setExecutor({ async execute() { return { output: PASS } } })
})

// ── passThreshold 投票 ──────────────────────────────────────────────────

test("默认全票（旧行为）：2/3 pass 仍 fail", async () => {
  const { executor } = reviewerExecutor([PASS, PASS, FAIL])
  setExecutor(executor)
  const result = await verify("artifact", { reviewers: 3 })
  assert.equal(result.passed, false)
})

test("threshold 0.5 多数决：2/3 pass -> 通过", async () => {
  const { executor } = reviewerExecutor([PASS, PASS, FAIL])
  setExecutor(executor)
  const result = await verify("artifact", { reviewers: 3, passThreshold: 0.5 })
  assert.equal(result.passed, true)
  assert.equal(result.verdicts.length, 3)
})

test("threshold 不达标：1/3 < 0.5 -> 拒绝", async () => {
  const { executor } = reviewerExecutor([FAIL, FAIL, PASS])
  setExecutor(executor)
  const result = await verify("artifact", { reviewers: 3, passThreshold: 0.5 })
  assert.equal(result.passed, false)
})

test("threshold 非法取值：结构性错误立即抛出", async () => {
  setExecutor(reviewerExecutor([PASS]).executor)
  await assert.rejects(verify("a", { passThreshold: 0 }), /passThreshold must be in \(0, 1\]/)
  await assert.rejects(verify("a", { passThreshold: 1.5 }), /passThreshold must be in \(0, 1\]/)
})

// ── lenses 多视角 ───────────────────────────────────────────────────────

const LENSES = [
  { name: "correctness", criteria: "技术论断准确无误" },
  { name: "completeness", criteria: "覆盖主题全部要点" },
]

test("lenses：一个视角一个评审员，prompt 带视角身份与专属标准，结论记录来源", async () => {
  const { executor, prompts } = reviewerExecutor([PASS, PASS])
  setExecutor(executor)
  const result = await verify("artifact", { lenses: LENSES })
  assert.equal(result.passed, true)
  assert.equal(result.verdicts.length, 2)
  assert.deepEqual(
    result.verdicts.map((v) => v.lens),
    ["correctness", "completeness"],
  )
  assert.match(prompts[0]!, /「correctness」视角评审员/)
  assert.match(prompts[0]!, /评审标准（视角 correctness）：技术论断准确无误/)
  assert.match(prompts[1]!, /「completeness」视角评审员/)
})

test("lenses 覆盖 reviewers/criteria；与 threshold 组合投票", async () => {
  const { executor } = reviewerExecutor([FAIL, PASS])
  setExecutor(executor)
  // correctness 视角否决，但 threshold 0.5 → 1/2 pass 仍达标
  const result = await verify("artifact", {
    lenses: LENSES,
    reviewers: 9, // 应被忽略（评审员数 = lenses 数）
    criteria: "全局标准（应被忽略）",
    passThreshold: 0.5,
  })
  assert.equal(result.passed, true)
  assert.equal(result.verdicts.length, 2)
})

test("lenses 全票默认：一个视角 fail -> 整体拒绝", async () => {
  const { executor } = reviewerExecutor([FAIL, PASS])
  setExecutor(executor)
  const result = await verify("artifact", { lenses: LENSES })
  assert.equal(result.passed, false)
})
