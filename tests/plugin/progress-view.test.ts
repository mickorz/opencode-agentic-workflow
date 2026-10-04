/**
 * 进度面板视图模型测试 —— 纯函数层（TUI 渲染的最小不可测面之外全覆盖）
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  formatDuration,
  renderDetailLines,
  renderDetailSection,
  renderPanelLines,
  toRunViewModel,
} from "../../src/plugin/progress-view.js"
import type { RunDetail } from "../../src/state/recorder.js"
import type { RunProgressSnapshot } from "../../src/observability/events.js"

const NOW = 10_000

function snapshot(overrides?: Partial<RunProgressSnapshot>): RunProgressSnapshot {
  return {
    runId: "run_1",
    workflow: { id: "feature-development", version: "1.0.0" },
    status: "running",
    startedAt: 4_000,
    steps: [
      { index: 0, name: "gather", status: "completed", startedAt: 4_000, completedAt: 6_000 },
      { index: 1, name: "implement", status: "running", startedAt: 6_500 },
      { index: 2, name: "verify", status: "pending" },
    ],
    ...overrides,
  }
}

test("formatDuration: 秒/分/时三档", () => {
  assert.equal(formatDuration(0), "0s")
  assert.equal(formatDuration(12_340), "12.3s")
  assert.equal(formatDuration(62_000), "1m02s")
  assert.equal(formatDuration(3_780_000), "1h03m")
  assert.equal(formatDuration(-5), "0s")
})

test("toRunViewModel: 进行中 run 的时长随 now 流动，步骤时长缺省容忍", () => {
  const vm = toRunViewModel(snapshot(), NOW)
  assert.equal(vm.title, "feature-development@1.0.0")
  assert.equal(vm.glyph, "▶")
  assert.equal(vm.duration, "6.0s")
  assert.deepEqual(
    vm.steps.map((s) => `${s.glyph} ${s.label}${s.duration ? ` ${s.duration}` : ""}`),
    ["✓ gather 2.0s", "▶ implement 3.5s", "· verify"],
  )
})

test("toRunViewModel: 完成用 completedAt 收口；失败摘要带出", () => {
  const vm = toRunViewModel(
    snapshot({ status: "failed", completedAt: 9_000, failure: "verify rejected the patch" }),
    NOW,
  )
  assert.equal(vm.glyph, "✗")
  assert.equal(vm.duration, "5.0s")
  assert.equal(vm.failure, "verify rejected the patch")
})

test("toRunViewModel: 无名步骤回退 step N；未知状态问号", () => {
  const vm = toRunViewModel(
    snapshot({
      steps: [
        { index: 0, status: "weird" },
        { index: 1, status: "skipped", name: "cleanup" },
      ],
    }),
    NOW,
  )
  assert.equal(vm.steps[0]?.label, "step 0")
  assert.equal(vm.steps[0]?.glyph, "?")
  assert.equal(vm.steps[1]?.glyph, "–")
})

test("renderPanelLines: 空态占位", () => {
  assert.deepEqual(renderPanelLines([], NOW), [
    "Agentic Workflow",
    "(no runs yet — start one with workflow_start)",
  ])
})

test("renderPanelLines: 最新 run 展开步骤树，其余收为单行；失败附摘要行", () => {
  const lines = renderPanelLines(
    [
      snapshot({ status: "failed", completedAt: 9_000, failure: "boom" }),
      snapshot({ runId: "run_2", startedAt: 1_000, status: "completed", completedAt: 2_000 }),
    ],
    NOW,
  )
  assert.deepEqual(lines, [
    "Agentic Workflow",
    "✗ feature-development@1.0.0  5.0s",
    "  ✓ gather  2.0s",
    "  ▶ implement  2.5s",
    "  · verify",
    "  ↳ boom",
    "✓ feature-development@1.0.0  1.0s",
  ])
  // 步骤停表语义：run 失败后，仍处 running 的步骤时长停在 run 收口时刻
  assert.equal(lines[3], "  ▶ implement  2.5s")
})

test("renderPanelLines: maxWidth 截断加省略号（标题行不截断）", () => {
  const lines = renderPanelLines([snapshot()], NOW, { maxWidth: 10 })
  assert.ok(lines.slice(1).every((l) => l.length <= 10))
  assert.ok(lines[1]?.endsWith("…"))
})

test("P2-9 lineage：subflow 子 run 缩进挂在父 run 下（深度感知 + 失败摘要）", () => {
  const parent = snapshot({ runId: "run_p", startedAt: 5000, status: "running" })
  const child = snapshot({
    runId: "run_c",
    startedAt: 6000,
    status: "failed",
    completedAt: 8000,
    failure: "child exploded",
    parentRunId: "run_p",
    depth: 1,
  })
  const grandchild = snapshot({
    runId: "run_g",
    startedAt: 7000,
    status: "running",
    parentRunId: "run_c",
    depth: 2,
  })
  const lines = renderPanelLines([parent, child, grandchild], NOW)
  assert.deepEqual(lines, [
    "Agentic Workflow",
    "▶ feature-development@1.0.0  5.0s",
    "  ✓ gather  2.0s",
    "  ▶ implement  3.5s",
    "  · verify",
    "    ↳ ✗ feature-development@1.0.0  2.0s · subflow",
    "      ↳ child exploded",
    "        ↳ ▶ feature-development@1.0.0  3.0s ⇢ subflow",
  ])
})

test("renderDetailLines: 头行/lineage/args/步骤输出与错误预览", () => {
  const detail: RunDetail = {
    runId: "run_d",
    workflow: { id: "demo", version: "1.0.0" },
    status: "completed",
    startedAt: 1_000,
    completedAt: 43_000,
    parentRunId: "run_p",
    depth: 1,
    args: '{"topic":"t"}',
    steps: [
      {
        index: 0,
        name: "gather",
        status: "completed",
        startedAt: 1_000,
        completedAt: 13_000,
        output: "hello world",
      },
      {
        index: 1,
        name: "check",
        status: "failed",
        startedAt: 13_000,
        completedAt: 16_200,
        error: "WorkflowCheckError: no",
      },
    ],
  }
  const lines = renderDetailLines(detail)
  assert.equal(lines[0], "✓ demo@1.0.0 · completed · 42.0s")
  assert.ok(lines[1]?.includes("run_d"))
  assert.ok(lines[1]?.includes("parent run_p"))
  assert.ok(lines[1]?.includes("depth 1"))
  assert.equal(lines[2], '  args {"topic":"t"}')
  assert.equal(lines[3], "  ✓ gather  12.0s")
  assert.equal(lines[4], "    → hello world")
  assert.equal(lines[5], "  ✗ check  3.2s")
  assert.equal(lines[6], "    ✗ WorkflowCheckError: no")
})

test("renderDetailLines: 进行中时长用注入 now；限宽折行 + 上限截断", () => {
  const detail: RunDetail = {
    runId: "run_r",
    workflow: { id: "w", version: "1.0.0" },
    status: "running",
    startedAt: 10_000,
    steps: [
      {
        index: 0,
        status: "running",
        startedAt: 10_000,
        output: "ab".repeat(60),
      },
    ],
  }
  // 进行中：now 注入决定 run 与步骤时长
  const lines = renderDetailLines(detail, 21_000)
  assert.equal(lines[0], "▶ w@1.0.0 · running · 11.0s")
  assert.equal(lines[2], "  ▶ step 0  11.0s")
  // 限宽 24（预览宽度 20）：120 字符预览折成 2 行封顶，末行 … 收尾
  const wrapped = renderDetailLines(detail, 21_000, { maxWidth: 24, maxPreviewLines: 2 })
  const preview = wrapped.filter((l) => l.startsWith("    "))
  assert.equal(preview.length, 2)
  assert.ok(preview[1]?.endsWith("…"))
  assert.ok((preview[1]?.length ?? 0) <= 24)
  // 头行在限宽下截断
  assert.ok((wrapped[0]?.length ?? 0) <= 24)
})

test("renderDetailSection: 仅当缓存的详情属于板上最新 run 时输出", () => {
  const runs: RunProgressSnapshot[] = [
    {
      runId: "run_x",
      workflow: { id: "demo", version: "1.0.0" },
      status: "completed",
      startedAt: 1,
      steps: [],
    },
  ]
  assert.deepEqual(renderDetailSection(runs, undefined), [])
  assert.deepEqual(renderDetailSection([], { runId: "run_x", lines: ["a"] }), [])
  assert.deepEqual(renderDetailSection(runs, { runId: "run_other", lines: ["a"] }), [])
  assert.deepEqual(renderDetailSection(runs, { runId: "run_x", lines: [] }), [])
  assert.deepEqual(renderDetailSection(runs, { runId: "run_x", lines: ["a", "b"] }), [
    "── detail",
    "a",
    "b",
  ])
})
