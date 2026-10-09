/**
 * 进度面板视图模型测试 —— 纯函数层（TUI 渲染的最小不可测面之外全覆盖）
 * v0.7.0：行模型 PanelRow（text + tone + bold）；新增 token/模型信息密度、
 * prompt.footer 状态条与 sidebar 紧凑树渲染器
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  formatDuration,
  renderDetailRows,
  renderDetailSection,
  renderHomeFooterRows,
  renderPanelRows,
  renderPromptFooterRows,
  renderSessionRows,
  renderSessionSection,
  renderSidebarRows,
  statusTone,
  toRunViewModel,
  type PanelRow,
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

/** 行对象数组 -> 纯文本投影（多数断言只关心文本；tone/bold 单独点测） */
function texts(rows: PanelRow[]): string[] {
  return rows.map((r) => r.text)
}

test("formatDuration: 秒/分/时三档", () => {
  assert.equal(formatDuration(0), "0s")
  assert.equal(formatDuration(12_340), "12.3s")
  assert.equal(formatDuration(62_000), "1m02s")
  assert.equal(formatDuration(3_780_000), "1h03m")
  assert.equal(formatDuration(-5), "0s")
})

test("statusTone: 四态语义色映射", () => {
  assert.equal(statusTone("completed"), "success")
  assert.equal(statusTone("running"), "warning")
  assert.equal(statusTone("failed"), "error")
  assert.equal(statusTone("aborted"), "error")
  assert.equal(statusTone("pending"), "muted")
  assert.equal(statusTone("weird"), "muted")
})

test("toRunViewModel: 进行中 run 的时长随 now 流动，步骤时长缺省容忍", () => {
  const vm = toRunViewModel(snapshot(), NOW)
  assert.equal(vm.title, "feature-development@1.0.0")
  assert.equal(vm.glyph, "▶")
  assert.equal(vm.tone, "warning")
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
  assert.equal(vm.tone, "error")
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

test("toRunViewModel: v0.7.0 信息密度——running 计数 + token 合计 + 步骤 token/模型", () => {
  const vm = toRunViewModel(
    snapshot({
      steps: [
        {
          index: 0,
          name: "gather",
          status: "completed",
          startedAt: 4_000,
          completedAt: 6_000,
          usage: { input: 1200, output: 300, reasoning: 0 },
          model: "glm/glm-5.3-flash",
        },
        { index: 1, name: "implement", status: "running", startedAt: 6_500 },
      ],
    }),
    NOW,
  )
  assert.equal(vm.runningCount, 1)
  assert.equal(vm.tokensTotal, "1.5k")
  assert.equal(vm.steps[0]?.tokens, "1.5k")
  assert.equal(vm.steps[0]?.model, "glm/glm-5.3-flash")
  // 无任何 usage 的 run 不产出 tokensTotal（缺省容忍）
  assert.equal(toRunViewModel(snapshot(), NOW).tokensTotal, undefined)
})

test("renderPanelRows: 空态占位", () => {
  assert.deepEqual(texts(renderPanelRows([], NOW)), [
    "Agentic Workflow",
    "(no runs yet — start one with workflow_start)",
  ])
})

test("renderPanelRows: 最新 run 展开步骤树，其余收为单行；失败附摘要行", () => {
  const rows = renderPanelRows(
    [
      snapshot({ status: "failed", completedAt: 9_000, failure: "boom" }),
      snapshot({ runId: "run_2", startedAt: 1_000, status: "completed", completedAt: 2_000 }),
    ],
    NOW,
  )
  assert.deepEqual(texts(rows), [
    "Agentic Workflow",
    "✗ feature-development@1.0.0  5.0s",
    "  ✓ gather  2.0s",
    "  ▶ implement  2.5s",
    "  · verify",
    "  ↳ boom",
    "✓ feature-development@1.0.0  1.0s",
  ])
  // 步骤停表语义：run 失败后，仍处 running 的步骤时长停在 run 收口时刻
  assert.equal(rows[3]?.text, "  ▶ implement  2.5s")
  // v0.7.0 语义色：失败 run 头行 error + 粗体；失败摘要行 error；完成 run 头行 success
  assert.equal(rows[1]?.tone, "error")
  assert.equal(rows[1]?.bold, true)
  assert.equal(rows[5]?.tone, "error")
  assert.equal(rows[6]?.tone, "success")
  // 运行中步骤行 warning；待办步骤行 muted
  const running = renderPanelRows([snapshot()], NOW)
  assert.equal(running[3]?.tone, "warning")
  assert.equal(running[4]?.tone, "muted")
})

test("renderPanelRows: 头行带 running 计数与 token 合计后缀", () => {
  const rows = renderPanelRows(
    [
      snapshot({
        steps: [
          {
            index: 0,
            name: "gather",
            status: "completed",
            startedAt: 4_000,
            completedAt: 6_000,
            usage: { input: 900, output: 100, reasoning: 0 },
          },
          { index: 1, name: "implement", status: "running", startedAt: 6_500 },
        ],
      }),
    ],
    NOW,
  )
  assert.equal(rows[1]?.text, "▶ feature-development@1.0.0  6.0s  · 1 running · 1.0k tok")
  // 步骤行元数据后缀：token + 模型
  assert.equal(rows[2]?.text, "  ✓ gather  2.0s  · 1.0k tok")
})

test("renderPanelRows: maxWidth 截断加省略号（标题行不截断）", () => {
  const rows = renderPanelRows([snapshot()], NOW, { maxWidth: 10 })
  assert.ok(rows.slice(1).every((r) => r.text.length <= 10))
  assert.ok(rows[1]?.text.endsWith("…"))
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
  const rows = renderPanelRows([parent, child, grandchild], NOW)
  assert.deepEqual(texts(rows), [
    "Agentic Workflow",
    "▶ feature-development@1.0.0  5.0s  · 1 running",
    "  ✓ gather  2.0s",
    "  ▶ implement  3.5s",
    "  · verify",
    "    ↳ ✗ feature-development@1.0.0  2.0s · subflow",
    "      ↳ child exploded",
    "        ↳ ▶ feature-development@1.0.0  3.0s ⇢ subflow",
  ])
})

test("renderPromptFooterRows: 仅运行中 run；done/total + running 摘要", () => {
  const rows = renderPromptFooterRows([
    snapshot(),
    snapshot({ runId: "run_2", status: "completed", completedAt: 9_000 }),
  ])
  assert.deepEqual(
    rows.map((r) => ({ text: r.text, tone: r.tone })),
    [
      { text: "◐ feature-development@1.0.0 1/3 · 1 running", tone: "warning" },
    ],
  )
  assert.deepEqual(renderPromptFooterRows([snapshot({ runId: "x", status: "completed" })]), [])
})

test("renderHomeFooterRows: 主页常驻行——空板不渲染；运行中优先；否则最近 run 摘要", () => {
  assert.deepEqual(renderHomeFooterRows([]), [])
  // 运行中：warning 色 + 数量 + 流程名（多个 running 取最新一条的名）
  const running = renderHomeFooterRows([
    snapshot({ runId: "r_new", status: "running" }),
    snapshot({ runId: "r_old", status: "running", startedAt: 1_000 }),
  ])
  assert.deepEqual(running, [
    { text: "◐ 2 running · feature-development@1.0.0", tone: "warning" },
  ])
  // 无运行：最近 run 单行摘要（muted）
  const idle = renderHomeFooterRows([
    snapshot({ status: "completed", completedAt: 9_000 }),
  ])
  assert.deepEqual(idle, [{ text: "✓ feature-development@1.0.0 · completed", tone: "muted" }])
})

test("renderSidebarRows: 空板占位；行数预算截断带提示", () => {
  const empty = renderSidebarRows([])
  assert.equal(empty.length, 2)
  // 多 run 超预算：截断 + 提示行
  const many: RunProgressSnapshot[] = Array.from({ length: 10 }, (_, i) =>
    snapshot({
      runId: `run_${i}`,
      startedAt: 1_000 + i,
      status: "completed",
      completedAt: 2_000,
      steps: [{ index: 0, status: "completed" }],
    }),
  )
  const rows = renderSidebarRows(many, NOW, { maxRows: 6 })
  assert.equal(rows.length, 7)
  assert.ok(rows[rows.length - 1]?.text.startsWith("… +"))
  assert.ok(rows[rows.length - 1]?.text.includes("/workflow"))
  // 默认窄宽截断生效（侧栏宽度 40）
  assert.ok(renderSidebarRows(many, NOW).every((r) => r.text.length <= 41))
})

test("renderDetailRows: 头行/lineage/args/步骤输出与错误预览", () => {
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
  const rows = renderDetailRows(detail)
  assert.equal(rows[0]?.text, "✓ demo@1.0.0 · completed · 42.0s")
  assert.equal(rows[0]?.tone, "success")
  assert.equal(rows[0]?.bold, true)
  assert.ok(rows[1]?.text.includes("run_d"))
  assert.ok(rows[1]?.text.includes("parent run_p"))
  assert.ok(rows[1]?.text.includes("depth 1"))
  assert.equal(rows[2]?.text, '  args {"topic":"t"}')
  assert.equal(rows[3]?.text, "  ✓ gather  12.0s")
  assert.equal(rows[4]?.text, "    → hello world")
  assert.equal(rows[5]?.text, "  ✗ check  3.2s")
  assert.equal(rows[6]?.text, "    ✗ WorkflowCheckError: no")
  // v0.7.0：元数据行 muted；预览行 muted；错误行 error
  assert.equal(rows[1]?.tone, "muted")
  assert.equal(rows[4]?.tone, "muted")
  assert.equal(rows[6]?.tone, "error")
})

test("renderDetailRows: 进行中时长用注入 now；限宽折行 + 上限截断", () => {
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
  // 进行中：now 注入决定 run 与步骤时长；running 计数后缀（v0.7.0）
  const rows = renderDetailRows(detail, 21_000)
  assert.equal(rows[0]?.text, "▶ w@1.0.0 · running · 11.0s  · 1 running")
  assert.equal(rows[2]?.text, "  ▶ step 0  11.0s")
  // 限宽 24（预览宽度 20）：120 字符预览折成 2 行封顶，末行 … 收尾
  const wrapped = renderDetailRows(detail, 21_000, { maxWidth: 24, maxPreviewLines: 2 })
  const preview = wrapped.filter((r) => r.text.startsWith("    "))
  assert.equal(preview.length, 2)
  assert.ok(preview[1]?.text.endsWith("…"))
  assert.ok((preview[1]?.text.length ?? 0) <= 24)
  // 头行在限宽下截断
  assert.ok((wrapped[0]?.text.length ?? 0) <= 24)
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
  assert.deepEqual(renderDetailSection([], { runId: "run_x", rows: [{ text: "a" }] }), [])
  assert.deepEqual(renderDetailSection(runs, { runId: "run_other", rows: [{ text: "a" }] }), [])
  assert.deepEqual(renderDetailSection(runs, { runId: "run_x", rows: [] }), [])
  const section = renderDetailSection(runs, { runId: "run_x", rows: [{ text: "a" }, { text: "b" }] })
  assert.deepEqual(texts(section), ["── detail", "a", "b"])
  assert.equal(section[0]?.tone, "muted")
  assert.equal(section[0]?.bold, true)
})

test("renderDetailRows: 步骤 token/模型元数据后缀", () => {
  const detail: RunDetail = {
    runId: "run_m",
    workflow: { id: "w", version: "1.0.0" },
    status: "completed",
    startedAt: 0,
    completedAt: 1000,
    steps: [
      {
        index: 0,
        name: "gather",
        status: "completed",
        startedAt: 0,
        completedAt: 1000,
        output: "o",
        usage: { input: 1200, output: 300, reasoning: 0 },
        model: "glm/glm-5.3-flash",
      },
      { index: 1, name: "check", status: "completed", startedAt: 1000, completedAt: 1000 },
    ],
  }
  const rows = renderDetailRows(detail, 1000)
  // v0.7.0：detail 头行也带 token 合计后缀（v1 Inspector 元数据行对位）
  assert.equal(rows[0]?.text, "✓ w@1.0.0 · completed · 1.0s  · 1.5k tok")
  assert.equal(rows[2]?.text, "  ✓ gather  1.0s  · 1.5k tok · glm/glm-5.3-flash")
  assert.equal(rows[3]?.text, "    → o")
  // 无元数据步骤不加后缀（0 时长按 "0s"）
  assert.equal(rows[4]?.text, "  ✓ check  0s")
})

test("renderSessionRows: 步骤头 + 逐消息前缀 + 折行与行数预算", () => {
  const replay = {
    sessionID: "ses_abc123",
    step: "gather",
    messages: [
      { type: "user", text: "调研 A" },
      { type: "assistant", text: "结论 B" },
      { type: "tool", text: "其他类型缩进" },
    ],
  }
  // 不折行：头行一步骤名+会话 ID，消息带类型前缀
  const rows = renderSessionRows(replay)
  assert.equal(rows[0]?.text, "gather · ses_abc123")
  assert.equal(rows[0]?.tone, "muted")
  assert.equal(rows[1]?.text, "❯ 调研 A")
  assert.equal(rows[2]?.text, "· 结论 B")
  assert.equal(rows[3]?.text, "↳ 其他类型缩进")
  // assistant 消息 muted
  assert.equal(rows[2]?.tone, "muted")
  assert.equal(rows[1]?.tone, undefined)

  // 定宽折行：长文本按宽度切块，续行缩进两格
  const wrapped = renderSessionRows(
    { sessionID: "s", messages: [{ type: "user", text: "abcdefghijk" }] },
    8,
  )
  assert.deepEqual(texts(wrapped), ["s", "❯ abcdefgh", "  ijk"])

  // 行数预算：超出截断加 …
  const capped = renderSessionRows(
    { sessionID: "s", messages: [{ type: "assistant", text: "x".repeat(100) }] },
    8,
    3,
  )
  assert.equal(capped.length, 4)
  assert.equal(capped[capped.length - 1]?.text, "…")

  // 无步骤名时头行只有会话 ID
  assert.equal(renderSessionRows({ sessionID: "s", messages: [] })[0]?.text, "s")
})

test("renderSessionSection: 属于板上最新 run 才输出，否则空", () => {
  const runs: RunProgressSnapshot[] = [
    {
      runId: "run_new",
      workflow: { id: "w", version: "1.0.0" },
      status: "completed",
      startedAt: 2,
      steps: [{ index: 0, status: "completed" }],
    },
    {
      runId: "run_old",
      workflow: { id: "w", version: "1.0.0" },
      status: "completed",
      startedAt: 1,
      steps: [{ index: 0, status: "completed" }],
    },
  ]
  const session = {
    runId: "run_new",
    step: "gather",
    rows: [{ text: "gather · ses_1" }, { text: "❯ q" }],
  }
  assert.deepEqual(texts(renderSessionSection(runs, session)), [
    "── session",
    "gather · ses_1",
    "❯ q",
  ])
  // 非最新 run / 空行 / 缺席 -> 空
  assert.deepEqual(renderSessionSection(runs, { ...session, runId: "run_old" }), [])
  assert.deepEqual(renderSessionSection(runs, { ...session, rows: [] }), [])
  assert.deepEqual(renderSessionSection(runs, undefined), [])
  assert.deepEqual(renderSessionSection([], session), [])
})
