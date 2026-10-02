/**
 * InteractiveCheckpointGate 单元测试 —— fake RpcDomain 注入
 * 覆盖：事件广播 / RPC 应答 / 超时策略 / 并发请求 / dispose / core 集成
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { checkpoint, setCheckpointGate, WorkflowCheckpointError } from "../../src/quality/checkpoint.js"
import {
  CHECKPOINT_REQUESTED_EVENT,
  CheckpointRpc,
  parseCheckpointReply,
} from "../../src/plugin/checkpoint-rpc.js"
import { InteractiveCheckpointGate } from "../../src/plugin/interactive-checkpoint-gate.js"

type RpcDomainArg = ConstructorParameters<typeof InteractiveCheckpointGate>[0]
type ReplyResult = { ok: boolean }

function fakeRpc() {
  const emitted: Array<{ name: string; data: Record<string, unknown> }> = []
  let replyHandler: ((input: unknown) => Promise<ReplyResult>) | undefined

  const rpc = {
    async register(_definition: unknown, handlers: Record<string, unknown>) {
      replyHandler = handlers.reply as (input: unknown) => Promise<ReplyResult>
      return {
        events: {
          async emit(name: string, data: Record<string, unknown>) {
            emitted.push({ name, data })
          },
        },
      }
    },
  } as unknown as RpcDomainArg

  return {
    emitted,
    rpc,
    reply: (input: unknown): Promise<ReplyResult> => {
      if (!replyHandler) throw new Error("handler not registered")
      return replyHandler(input)
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("bind(): 注册 reply handler；ask() 广播 requested 事件", async () => {
  const fake = fakeRpc()
  const gate = new InteractiveCheckpointGate(fake.rpc, { timeoutMs: 1000 })
  await gate.bind()

  const asking = gate.ask({ label: "final-review", message: "验证完成，是否继续？" })
  await sleep(5)

  assert.equal(fake.emitted.length, 1)
  assert.equal(fake.emitted[0]?.name, "requested")
  assert.equal(fake.emitted[0]?.data.label, "final-review")
  assert.equal(fake.emitted[0]?.data.message, "验证完成，是否继续？")
  assert.ok(typeof fake.emitted[0]?.data.requestId === "string")

  const result = await fake.reply({
    requestId: fake.emitted[0]?.data.requestId,
    approved: true,
  })
  assert.deepEqual(result, { ok: true })

  assert.deepEqual(await asking, { approved: true, reason: undefined })
})

test("ask(): 拒绝应答携带 reason（默认补充 TUI 拒绝语义）", async () => {
  const fake = fakeRpc()
  const gate = new InteractiveCheckpointGate(fake.rpc, { timeoutMs: 1000 })
  await gate.bind()

  const asking = gate.ask({ label: "l", message: "m" })
  await sleep(5)
  await fake.reply({ requestId: fake.emitted[0]?.data.requestId, approved: false })
  assert.deepEqual(await asking, {
    approved: false,
    reason: "rejected by reviewer in TUI",
  })
})

test("ask(): 未知/非法应答返回 ok:false（不影响挂起中的请求）", async () => {
  const fake = fakeRpc()
  const gate = new InteractiveCheckpointGate(fake.rpc, { timeoutMs: 1000 })
  await gate.bind()

  const asking = gate.ask({ label: "l", message: "m" })
  await sleep(5)
  const requestId = fake.emitted[0]?.data.requestId

  // 未知 requestId
  assert.deepEqual(await fake.reply({ requestId: "nope", approved: true }), { ok: false })
  // 非法输入形状
  assert.deepEqual(await fake.reply({ requestId: "x" }), { ok: false })
  assert.deepEqual(await fake.reply("garbage"), { ok: false })
  assert.deepEqual(await fake.reply(null), { ok: false })

  // 原请求仍挂起，可被正确应答
  await fake.reply({ requestId, approved: true })
  assert.equal((await asking).approved, true)
})

test("ask(): 超时默认 reject；onTimeout=approve 时批准", async () => {
  const fake = fakeRpc()
  const gate = new InteractiveCheckpointGate(fake.rpc, { timeoutMs: 20 })
  await gate.bind()

  const decision = await gate.ask({ label: "l", message: "m" })
  assert.equal(decision.approved, false)
  assert.match(decision.reason ?? "", /no interactive reply within 20ms/)

  // 超时后再应答 -> ok:false（挂起已清理）
  const gate2 = new InteractiveCheckpointGate(fake.rpc, {
    timeoutMs: 20,
    onTimeout: "approve",
  })
  await gate2.bind()
  const approved = await gate2.ask({ label: "l", message: "m" })
  assert.equal(approved.approved, true)
  assert.match(approved.reason ?? "", /auto-approved after interactive timeout/)

  assert.equal(fake.emitted.length, 2)
})

test("并发请求：各自独立应答", async () => {
  const fake = fakeRpc()
  const gate = new InteractiveCheckpointGate(fake.rpc, { timeoutMs: 1000 })
  await gate.bind()

  const first = gate.ask({ label: "a", message: "m" })
  const second = gate.ask({ label: "b", message: "m" })
  await sleep(5)

  assert.equal(fake.emitted.length, 2)
  const [e1, e2] = fake.emitted
  assert.notEqual(e1?.data.requestId, e2?.data.requestId)

  await fake.reply({ requestId: e2?.data.requestId, approved: true })
  await fake.reply({ requestId: e1?.data.requestId, approved: false, reason: "质量不行" })

  assert.equal((await first).approved, false)
  assert.equal((await second).approved, true)
})

test("dispose(): 挂起请求全部按拒绝收口", async () => {
  const fake = fakeRpc()
  const gate = new InteractiveCheckpointGate(fake.rpc, { timeoutMs: 60_000 })
  await gate.bind()

  const asking = gate.ask({ label: "l", message: "m" })
  await sleep(5)
  gate.dispose()

  const decision = await asking
  assert.equal(decision.approved, false)
  assert.match(decision.reason ?? "", /gate disposed/)
})

test("ask(): 未 bind() 时明确抛错", async () => {
  const fake = fakeRpc()
  const gate = new InteractiveCheckpointGate(fake.rpc)
  await assert.rejects(() => gate.ask({ label: "l", message: "m" }), /not bound/)
})

test("core 集成: checkpoint() -> 交互门 -> TUI 应答批准/拒绝", async () => {
  const fake = fakeRpc()
  const gate = new InteractiveCheckpointGate(fake.rpc, { timeoutMs: 1000 })
  await gate.bind()
  setCheckpointGate(gate)

  // 批准路径
  const approving = checkpoint("验证完成，是否继续？", { label: "final-review" })
  await sleep(5)
  await fake.reply({ requestId: fake.emitted[0]?.data.requestId, approved: true })
  await approving // 不抛即通过

  // 拒绝路径：WorkflowCheckpointError
  const rejecting = checkpoint("再继续？", { label: "second" })
  await sleep(5)
  await fake.reply({
    requestId: fake.emitted[1]?.data.requestId,
    approved: false,
    reason: "人工否决",
  })
  await assert.rejects(
    () => rejecting,
    (error: unknown) => {
      assert.ok(error instanceof WorkflowCheckpointError)
      assert.equal(error.reason, "人工否决")
      return true
    },
  )
})

test("RPC 契约: 定义形状与事件名常量", () => {
  assert.equal(CheckpointRpc.id, "agentic-workflow")
  assert.equal(CHECKPOINT_REQUESTED_EVENT, "rpc.agentic-workflow.requested")
  assert.ok(CheckpointRpc.methods.reply)
  assert.ok(CheckpointRpc.events.requested)
})

test("parseCheckpointReply: 形状校验", () => {
  assert.deepEqual(parseCheckpointReply({ requestId: "r", approved: true }), {
    requestId: "r",
    approved: true,
  })
  assert.deepEqual(
    parseCheckpointReply({ requestId: "r", approved: false, reason: "x" }),
    { requestId: "r", approved: false, reason: "x" },
  )
  assert.equal(parseCheckpointReply({ requestId: "r" }), undefined)
  assert.equal(parseCheckpointReply({ requestId: 1, approved: true }), undefined)
  assert.equal(parseCheckpointReply({ requestId: "r", approved: "yes" }), undefined)
  assert.equal(parseCheckpointReply({ requestId: "r", approved: true, reason: 5 }), undefined)
  assert.equal(parseCheckpointReply(null), undefined)
})
