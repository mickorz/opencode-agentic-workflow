/**
 * 进度面板视图模型测试 —— 纯函数层（TUI 渲染的最小不可测面之外全覆盖）
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  formatDuration,
  renderPanelLines,
  toRunViewModel,
} from "../../src/plugin/progress-view.js"
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
