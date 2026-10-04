/**
 * P1-6 结构化输出 shim 单测
 * 覆盖：合法 JSON -> structured / 围栏 JSON 提取 / 非 JSON 报错 /
 *       schema 违规逐一指名 / retries 营救 / prompt 指令注入
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { setExecutor } from "../../src/runtime/engine.js"
import { agent, AgentSchemaError } from "../../src/workflow/agent.js"

const SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number" },
    verdict: { type: "string", enum: ["pass", "fail"] },
  },
  required: ["score"],
}

function executorWith(outputs: string[]) {
  const prompts: string[] = []
  let i = 0
  return {
    prompts,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async execute(task: any) {
        prompts.push(task.prompt)
        const output = outputs[Math.min(i++, outputs.length - 1)]
        return { output }
      },
    } as never,
  }
}

test.afterEach(() => {
  setExecutor({ async execute() { return { output: "ok" } } })
})

test("合法 JSON -> structured 挂载且通过校验", async () => {
  const { api } = executorWith(['{"score": 8, "verdict": "pass"}'])
  setExecutor(api)
  const result = await agent("rate it", { schema: SCHEMA })
  assert.deepEqual(result.structured, { score: 8, verdict: "pass" })
})

test("prompt 已注入 schema 指令（子 agent 能看到契约）", async () => {
  const { api, prompts } = executorWith(['{"score": 1}'])
  setExecutor(api)
  await agent("rate it", { schema: SCHEMA })
  assert.match(prompts[0]!, /rate it[\s\S]*Respond with ONLY a JSON value/)
  assert.match(prompts[0]!, /"required":\["score"\]/)
})

test("围栏 JSON（```json 包裹）仍可提取", async () => {
  const { api } = executorWith(["```json\n{\"score\": 3}\n```"])
  setExecutor(api)
  const result = await agent("rate it", { schema: SCHEMA })
  assert.deepEqual(result.structured, { score: 3 })
})

test("非 JSON 输出 -> AgentSchemaError 明确报错", async () => {
  const { api } = executorWith(["I think it is fine, no numbers"])
  setExecutor(api)
  await assert.rejects(agent("rate it", { schema: SCHEMA }), (e: unknown) => {
    assert.ok(e instanceof AgentSchemaError)
    assert.match(e.message, /not valid JSON/)
    return true
  })
})

test("JSON 但违反 schema -> 违规逐一指名（类型/枚举）", async () => {
  const { api } = executorWith(['{"score": "high", "verdict": "maybe"}'])
  setExecutor(api)
  await assert.rejects(agent("rate it", { schema: SCHEMA }), (e: unknown) => {
    assert.ok(e instanceof AgentSchemaError)
    assert.match(e.message, /score: expected type number/)
    assert.match(e.message, /verdict: expected one of/)
    return true
  })
})

test("retries 营救：首次输出违规、第二次合规 -> 成功", async () => {
  const { api } = executorWith(["not json at all", '{"score": 10}'])
  setExecutor(api)
  const result = await agent("rate it", { schema: SCHEMA, retries: 1 })
  assert.deepEqual(result.structured, { score: 10 })
})
