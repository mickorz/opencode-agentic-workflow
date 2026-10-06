/**
 * Progress RPC 契约测试 —— 事件名一致性 + 载荷收窄
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ProgressRpc,
  PROGRESS_EVENT,
  parseRunDetail,
  parseRunDetailRequest,
  parseRunSnapshot,
  parseRunSnapshotList,
  parseSessionReplay,
  parseSessionReplayRequest,
} from "../../src/plugin/progress-rpc.js"
import type { RunProgressSnapshot } from "../../src/observability/events.js"

function snapshot(overrides?: Partial<RunProgressSnapshot>): RunProgressSnapshot {
  return {
    runId: "run_1",
    workflow: { id: "demo", version: "1.0.0" },
    status: "running",
    startedAt: 1000,
    steps: [
      { index: 0, name: "gather", status: "completed", startedAt: 1000, completedAt: 2000 },
      { index: 1, status: "running", startedAt: 2000 },
    ],
    ...overrides,
  }
}

test("事件名与 Rpc 定义一致（TUI 订阅键拼写保证）", () => {
  assert.equal(PROGRESS_EVENT, `rpc.${ProgressRpc.id}.progress`)
})

test("parseRunSnapshot: 合法快照原样通过", () => {
  const input = snapshot()
  assert.deepEqual(parseRunSnapshot(input), input)
})

test("parseRunSnapshot: 缺字段/类型错一律拒绝", () => {
  assert.equal(parseRunSnapshot(undefined), undefined)
  assert.equal(parseRunSnapshot(null), undefined)
  assert.equal(parseRunSnapshot("run_1"), undefined)
  assert.equal(parseRunSnapshot({}), undefined)
  assert.equal(parseRunSnapshot({ ...snapshot(), runId: 42 }), undefined)
  assert.equal(parseRunSnapshot({ ...snapshot(), status: 1 }), undefined)
  assert.equal(parseRunSnapshot({ ...snapshot(), startedAt: "1000" }), undefined)
  assert.equal(parseRunSnapshot({ ...snapshot(), workflow: { id: "x" } }), undefined)
  assert.equal(parseRunSnapshot({ ...snapshot(), steps: "nope" }), undefined)
  assert.equal(
    parseRunSnapshot({ ...snapshot(), steps: [{ index: "0", status: "running" }] }),
    undefined,
  )
})

test("parseRunSnapshotList: 逐条过滤，非法整体丢弃", () => {
  const good = snapshot()
  const list = parseRunSnapshotList({ runs: [good, { broken: true }, snapshot({ runId: "run_2" })] })
  assert.deepEqual(list.map((r) => r.runId), ["run_1", "run_2"])
  assert.deepEqual(parseRunSnapshotList({}), [])
  assert.deepEqual(parseRunSnapshotList({ runs: "x" }), [])
  assert.deepEqual(parseRunSnapshotList(null), [])
})

test("detail 方法定义存在（server handler 与 TUI 调用共享的契约键）", () => {
  const methods = ProgressRpc.methods as Record<string, unknown>
  assert.ok(methods.detail)
  assert.ok(methods.snapshot)
})

test("parseRunDetailRequest: runId 收窄", () => {
  assert.equal(parseRunDetailRequest({ runId: "run_1" }), "run_1")
  assert.equal(parseRunDetailRequest({}), undefined)
  assert.equal(parseRunDetailRequest({ runId: 3 }), undefined)
  assert.equal(parseRunDetailRequest("run_1"), undefined)
  assert.equal(parseRunDetailRequest(null), undefined)
})

test("parseRunDetail: 合法详情原样通过", () => {
  const output = {
    run: {
      runId: "run_1",
      workflow: { id: "demo", version: "1.0.0" },
      status: "completed",
      startedAt: 1000,
      completedAt: 2000,
      parentRunId: "run_p",
      depth: 1,
      args: '{"topic":"t"}',
      steps: [
        {
          index: 0,
          name: "gather",
          status: "completed",
          startedAt: 1000,
          completedAt: 2000,
          output: "产物文本",
        },
      ],
    },
  }
  const parsed = parseRunDetail(output)
  assert.equal(parsed?.runId, "run_1")
  assert.equal(parsed?.steps[0]?.output, "产物文本")
  assert.equal(parsed?.parentRunId, "run_p")
})

test("parseRunDetail: null（无 journal/未知 run）与不合法形状拒绝", () => {
  assert.equal(parseRunDetail({ run: null }), undefined)
  assert.equal(parseRunDetail({ run: "run_1" }), undefined)
  assert.equal(parseRunDetail({}), undefined)
  assert.equal(parseRunDetail(null), undefined)
  // 必备字段缺失逐项拒绝
  const base = {
    runId: "run_1",
    workflow: { id: "demo", version: "1.0.0" },
    status: "completed",
    startedAt: 1000,
    steps: [{ index: 0, status: "completed" }],
  }
  assert.equal(parseRunDetail({ run: { ...base, runId: 1 } }), undefined)
  assert.equal(
    parseRunDetail({ run: { ...base, workflow: { id: "demo" } } }),
    undefined,
  )
  assert.equal(parseRunDetail({ run: { ...base, steps: [{ status: "x" }] } }), undefined)
  assert.equal(parseRunDetail({ run: { ...base, steps: "x" } }), undefined)
})

test("parseRunDetail: 透传步骤 usage/model 元数据", () => {
  const output = {
    run: {
      runId: "run_1",
      workflow: { id: "demo", version: "1.0.0" },
      status: "completed",
      startedAt: 1,
      steps: [
        {
          index: 0,
          status: "completed",
          usage: { input: 1, output: 2, reasoning: 3 },
          model: "m/x",
        },
      ],
    },
  }
  assert.deepEqual(parseRunDetail(output)?.steps[0]?.usage, {
    input: 1,
    output: 2,
    reasoning: 3,
  })
  assert.equal(parseRunDetail(output)?.steps[0]?.model, "m/x")
})

test("parseSessionReplayRequest: 收窄入参（index 可选）", () => {
  assert.deepEqual(parseSessionReplayRequest({ runId: "run_1", step: "gather" }), {
    runId: "run_1",
    step: "gather",
  })
  assert.deepEqual(
    parseSessionReplayRequest({ runId: "run_1", step: "gather", index: 0 }),
    { runId: "run_1", step: "gather", index: 0 },
  )
  // 坏入参 -> undefined
  assert.equal(parseSessionReplayRequest({ runId: "run_1" }), undefined)
  assert.equal(parseSessionReplayRequest({ step: "gather" }), undefined)
  assert.equal(parseSessionReplayRequest("x"), undefined)
  assert.equal(parseSessionReplayRequest(null), undefined)
})

test("parseSessionReplay: 收窄回放载荷（消息逐条校验）", () => {
  const output = {
    session: {
      sessionID: "ses_1",
      step: "gather",
      messages: [
        { type: "user", text: "q" },
        { type: "assistant", text: "a" },
      ],
    },
  }
  assert.deepEqual(parseSessionReplay(output), {
    sessionID: "ses_1",
    step: "gather",
    messages: [
      { type: "user", text: "q" },
      { type: "assistant", text: "a" },
    ],
  })
  // step 可选
  const noStep = parseSessionReplay({ session: { sessionID: "ses_1", messages: [] } })
  assert.deepEqual(noStep, { sessionID: "ses_1", messages: [] })
  // 坏载荷 -> undefined
  assert.equal(parseSessionReplay({ session: { messages: [] } }), undefined)
  assert.equal(parseSessionReplay({ session: { sessionID: "s" } }), undefined)
  assert.equal(
    parseSessionReplay({ session: { sessionID: "s", messages: [{ type: "user" }] } }),
    undefined,
  )
  assert.equal(parseSessionReplay({}), undefined)
})
