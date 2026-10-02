/**
 * Reliable Workflow 单元测试 —— mock executor + 策略门 + 注入命令
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { setCheckpointGate } from "../../src/quality/checkpoint.js"
import { PolicyCheckpointGate } from "../../src/plugin/policy-checkpoint-gate.js"
import { WorkflowCheckError } from "../../src/quality/check.js"
import { WorkflowSequenceError } from "../../src/runtime/errors.js"
import { setExecutor } from "../../src/runtime/engine.js"
import {
  NodeCommandRunner,
  setCommandRunner,
} from "../../src/runtime/command.js"
import { runReliableWorkflow } from "../../src/workflow/reliable.js"

const PASS = JSON.stringify({ verdict: "pass", summary: "ok", issues: [] })

function agentExecutor(outputs: string[]) {
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
  setCommandRunner(new NodeCommandRunner())
  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))
})

test("reliable workflow: 全链路成功（agent + check + verify x2 + checkpoint）", async () => {
  const { prompts } = agentExecutor(["分析产物正文", PASS, PASS])
  setExecutor(agentExecutor([]).executor)
  // 重新绑定带记录的 executor
  const recorder = agentExecutor(["分析产物正文", PASS, PASS])
  setExecutor(recorder.executor)
  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))

  const report = await runReliableWorkflow("登录模块", { reviewers: 2 })

  // 1 次 agent + 2 次 reviewer = 3 次子任务
  assert.equal(recorder.prompts.length, 3)
  assert.ok(recorder.prompts[0]?.includes("登录模块"))
  assert.ok(recorder.prompts[1]?.includes("分析产物正文"))
  assert.ok(recorder.prompts[2]?.includes("分析产物正文"))

  assert.equal(report.checkOk, true)
  assert.equal(report.verified, true)
  assert.equal(report.checkpointApproved, true)
  assert.match(report.output, /确定性检查 通过/)
  assert.match(report.output, /2\/2 reviewer 通过/)
  assert.match(report.output, /已批准/)
})

test("reliable workflow: check 失败 -> fail-fast 中断，verify/checkpoint 不执行", async () => {
  const recorder = agentExecutor(["产物", "不应被执行"])
  setExecutor(recorder.executor)
  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))
  setCommandRunner({
    async run(command) {
      return { command, code: 1, stdout: "", stderr: "boom", timedOut: false }
    },
  })

  await assert.rejects(
    () => runReliableWorkflow("任意主题"),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowSequenceError)
      const cause = error.errors[0]?.cause
      assert.ok(cause instanceof WorkflowCheckError)
      assert.match(cause.message, /check: .* must succeed/)
      return true
    },
  )

  // 只有 agent 执行了，reviewer 未被调用
  assert.equal(recorder.prompts.length, 1)
})

test("reliable workflow: verify 失败 -> 中断，checkpoint 不执行", async () => {
  const FAIL = JSON.stringify({ verdict: "fail", summary: "不合格", issues: ["x"] })
  const recorder = agentExecutor(["产物", FAIL, PASS])
  setExecutor(recorder.executor)
  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))

  await assert.rejects(
    () => runReliableWorkflow("任意主题", { reviewers: 2 }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowSequenceError)
      return true
    },
  )

  // agent + 2 reviewers 都执行了（collect 语义由 verify 内部 parallel fail-fast 保证）
  assert.equal(recorder.prompts.length, 3)
})

test("reliable workflow: checkpoint 拒绝 -> 中断并抛 WorkflowCheckpointError", async () => {
  const recorder = agentExecutor(["产物", PASS])
  setExecutor(recorder.executor)
  setCheckpointGate(new PolicyCheckpointGate("auto-reject"))

  await assert.rejects(
    () => runReliableWorkflow("任意主题", { reviewers: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowSequenceError)
      const cause = error.errors[0]?.cause
      assert.ok(cause instanceof Error)
      assert.match(cause.message, /checkpoint rejected/)
      return true
    },
  )
})
