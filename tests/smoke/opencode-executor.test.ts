/**
 * OpenCodeV2Executor 单元测试 —— 用 fake session 域验证调用序列与结果提取
 *
 * 不发起真实请求：只验证
 *  1. create -> prompt -> wait -> context 的调用顺序与参数
 *  2. 从消息列表提取最后一条 assistant 的 text parts
 *  3. 无 assistant 文本时抛错
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { OpenCodeV2Executor } from "../../src/plugin/opencode-v2-executor.js"
import { isRunSession } from "../../src/plugin/run-sessions.js"

interface FakeMessage {
  type: string
  content?: Array<{ type: string; text: string }>
}

function makeFakeSession(messages: FakeMessage[]) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  let sessionCounter = 0
  return {
    calls,
    session: {
      async create(args: Record<string, unknown>) {
        calls.push({ method: "create", args })
        sessionCounter += 1
        return { id: `sess_${sessionCounter}` }
      },
      async prompt(args: Record<string, unknown>) {
        calls.push({ method: "prompt", args })
        return { type: "user" }
      },
      async wait(args: Record<string, unknown>) {
        calls.push({ method: "wait", args })
      },
      async context(args: Record<string, unknown>) {
        calls.push({ method: "context", args })
        return messages
      },
    },
  }
}

test("executor: create -> prompt -> wait -> context and extracts assistant text", async () => {
  const fake = makeFakeSession([
    { type: "user", content: [{ type: "text", text: "用户输入" }] },
    {
      type: "assistant",
      content: [
        { type: "reasoning", text: "思考中" },
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ],
    },
  ])

  const executor = new OpenCodeV2Executor({
    session: fake.session as never,
    parentSessionId: "main_session",
  })

  const result = await executor.execute({ prompt: "分析" })

  assert.equal(result.output, "第一段\n第二段")

  assert.deepEqual(
    fake.calls.map((c) => c.method),
    ["create", "prompt", "wait", "context"],
  )
  assert.equal(fake.calls[0]?.args.parentID, "main_session")
  assert.equal(fake.calls[1]?.args.sessionID, "sess_1")
  assert.equal(fake.calls[1]?.args.text, "分析")
  assert.equal(fake.calls[2]?.args.sessionID, "sess_1")
  assert.equal(fake.calls[3]?.args.sessionID, "sess_1")
})

test("executor: throws when session has no assistant text", async () => {
  const fake = makeFakeSession([
    { type: "user", content: [{ type: "text", text: "用户输入" }] },
    { type: "assistant", content: [] },
  ])

  const executor = new OpenCodeV2Executor({
    session: fake.session as never,
  })

  await assert.rejects(
    () => executor.execute({ prompt: "分析" }),
    /failed: assistant message has no text parts/,
  )
})

test("executor: 提取 assistant 消息的 usage/model；宿主 cost 正值优先", async () => {
  const fake = makeFakeSession([
    {
      type: "assistant",
      content: [{ type: "text", text: "结果" }],
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } },
      cost: 0.5,
      model: { providerID: "glm", id: "flash" },
    } as never,
  ])
  const executor = new OpenCodeV2Executor({
    session: fake.session as never,
    estimateCost: () => 0.001,
  })
  const result = await executor.execute({ prompt: "p" })
  assert.equal(result.usage?.input, 100)
  assert.equal(result.usage?.cache.read, 10)
  assert.equal(result.model, "glm/flash")
  assert.equal(result.costUSD, 0.5, "宿主正值优先于估算")
})

test("executor: 宿主 cost 为 0/缺失时走价目估算兜底", async () => {
  const base = {
    type: "assistant",
    content: [{ type: "text", text: "结果" }],
    tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    model: { providerID: "glm", id: "flash" },
  }
  let estimateCalls: Array<[string, unknown]> = []

  // cost: 0（宿主记账为 0 但实价非零的实测场景）
  const fakeZero = makeFakeSession([{ ...base, cost: 0 } as never])
  const execZero = new OpenCodeV2Executor({
    session: fakeZero.session as never,
    estimateCost: (model, usage) => {
      estimateCalls.push([model, usage])
      return 0.00123
    },
  })
  const zero = await execZero.execute({ prompt: "p" })
  assert.equal(zero.costUSD, 0.00123, "宿主 0 -> 估算")
  assert.equal(estimateCalls.length, 1)
  assert.equal(estimateCalls[0]?.[0], "glm/flash")

  // cost 缺失 + 无估算器 -> 保留宿主 undefined
  const fakeMissing = makeFakeSession([base as never])
  const execMissing = new OpenCodeV2Executor({ session: fakeMissing.session as never })
  const missing = await execMissing.execute({ prompt: "p" })
  assert.equal(missing.costUSD, undefined)

  // 宿主正值 + 无估算器 -> 宿主值
  const fakePositive = makeFakeSession([{ ...base, cost: 2 } as never])
  const execPositive = new OpenCodeV2Executor({ session: fakePositive.session as never })
  const positive = await execPositive.execute({ prompt: "p" })
  assert.equal(positive.costUSD, 2)
})

test("executor: 会话登记覆盖任务执行期（并发 run 递归防护的数据源）", async () => {
  // wait 挂起：execute 进行中（会话应被登记），释放后（应已注销）
  let releaseWait: (() => void) | undefined
  const waitGate = new Promise<void>((resolve) => {
    releaseWait = resolve
  })
  const fake = makeFakeSession([
    { type: "assistant", content: [{ type: "text", text: "ok" }] },
  ])
  const originalWait = fake.session.wait.bind(fake.session)
  fake.session.wait = async (args: Record<string, unknown>) => {
    await waitGate
    return originalWait(args)
  }
  const executor = new OpenCodeV2Executor({ session: fake.session as never })

  const pending = executor.execute({ prompt: "p" })
  // 微任务两跳让 execute 走到 wait（create/prompt 已发生）
  await Promise.resolve()
  await Promise.resolve()
  // 会话在飞：已登记（sess_1 —— fake 的第一个会话）
  assert.equal(isRunSession("sess_1"), true)

  releaseWait?.()
  await pending
  // 任务结束：注销（空闲会话不会再发起工具调用）
  assert.equal(isRunSession("sess_1"), false)
})

test("executor: 失败路径同样注销（不留永久登记）", async () => {
  const fake = makeFakeSession([{ type: "user", content: [{ type: "text", text: "无回复" }] }])
  const executor = new OpenCodeV2Executor({ session: fake.session as never })
  await assert.rejects(executor.execute({ prompt: "p" }), /without assistant message/)
  assert.equal(isRunSession("sess_1"), false)
})
