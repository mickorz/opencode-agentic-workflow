/**
 * Smoke Workflow 结构测试 —— MockExecutor 下验证并行扇出与汇总收拢
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { setExecutor } from "../../src/runtime/engine.js"
import { runSmokeWorkflow } from "../../src/workflow/smoke.js"

test("smoke workflow: 3 parallel agents then summary agent", async (t) => {
  const prompts: string[] = []
  setExecutor({
    async execute(task) {
      prompts.push(task.prompt)
      // 前三次为并行分析，第四次为汇总；汇总 prompt 应包含三份结果
      return { output: `result#${prompts.length}` }
    },
  })

  const result = await runSmokeWorkflow("测试主题")

  // 共 4 次执行：3 并行 + 1 汇总
  assert.equal(prompts.length, 4)
  // 汇总 prompt 内嵌了三份结果 JSON
  const summaryPrompt = prompts[3]
  assert.ok(summaryPrompt.includes("result#1"))
  assert.ok(summaryPrompt.includes("result#2"))
  assert.ok(summaryPrompt.includes("result#3"))
  // 三个并行分析各自覆盖不同角度
  assert.ok(prompts[0].includes("架构设计"))
  assert.ok(prompts[1].includes("风险与约束"))
  assert.ok(prompts[2].includes("实施步骤"))
  // 最终返回汇总 agent 的输出
  assert.equal(result.output, "result#4")
})
