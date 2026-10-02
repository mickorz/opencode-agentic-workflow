/**
 * checkpoint 单元测试 —— 审批语义 + 策略门 + 用户链路集成
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  checkpoint,
  setCheckpointGate,
  WorkflowCheckpointError,
} from "../../src/quality/checkpoint.js"
import { WorkflowSequenceError } from "../../src/runtime/errors.js"
import { PolicyCheckpointGate } from "../../src/plugin/policy-checkpoint-gate.js"
import { sequence } from "../../src/workflow/sequence.js"

function gateWith(decision: { approved: boolean; reason?: string }) {
  const requests: Array<{ label: string; message: string }> = []
  return {
    requests,
    gate: {
      async ask(request: { label: string; message: string }) {
        requests.push(request)
        return decision
      },
    },
  }
}

test("checkpoint: 批准 -> 返回 undefined，gate 收到 label/message", async () => {
  const { gate, requests } = gateWith({ approved: true })
  setCheckpointGate(gate)
  const result = await checkpoint("验证完成，是否继续？", { label: "human-review" })
  assert.equal(result, undefined)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.label, "human-review")
  assert.equal(requests[0]?.message, "验证完成，是否继续？")
})

test("checkpoint: 拒绝 -> WorkflowCheckpointError(label, reason)", async () => {
  const { gate } = gateWith({ approved: false, reason: "质量不达标" })
  setCheckpointGate(gate)
  await assert.rejects(
    () => checkpoint("继续？", { label: "gate-1" }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowCheckpointError)
      assert.equal(error.label, "gate-1")
      assert.equal(error.reason, "质量不达标")
      assert.match(error.message, /checkpoint rejected: gate-1/)
      return true
    },
  )
})

test("checkpoint: 未注入 gate -> 明确报错", async () => {
  // 动态 import 带 query 绕过模块缓存，获得未绑定状态的新模块实例
  const fresh = await import(
    new URL(`file://${process.cwd()}/src/quality/checkpoint.js?fresh=${Math.random()}`).href
  )
  assert.throws(() => fresh.requireCheckpointGate(), /no checkpoint gate bound/)
})

test("PolicyCheckpointGate: auto-approve 默认批准", async () => {
  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))
  await checkpoint("继续？") // 不抛错即通过
})

test("PolicyCheckpointGate: auto-reject 拒绝并带原因", async () => {
  setCheckpointGate(new PolicyCheckpointGate("auto-reject"))
  await assert.rejects(
    () => checkpoint("继续？"),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowCheckpointError)
      assert.match(error.reason ?? "", /auto-reject/)
      return true
    },
  )
})

test("用户链路集成: checkpoint 拒绝中断 sequence，后续步骤不执行", async () => {
  setCheckpointGate(new PolicyCheckpointGate("auto-reject"))
  const executed: string[] = []

  await assert.rejects(
    () =>
      sequence([
        async () => {
          executed.push("step-1")
          return "done"
        },
        async () => {
          await checkpoint("验证完成，是否继续？", { label: "final-review" })
          executed.push("step-2")
          return "done-2"
        },
        async () => {
          executed.push("step-3") // 不应执行
          return "done-3"
        },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowSequenceError)
      const cause = error.errors[0]?.cause
      assert.ok(cause instanceof WorkflowCheckpointError)
      assert.equal(cause.label, "final-review")
      return true
    },
  )

  assert.deepEqual(executed, ["step-1"])
})
