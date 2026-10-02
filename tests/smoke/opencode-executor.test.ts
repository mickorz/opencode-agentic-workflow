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
