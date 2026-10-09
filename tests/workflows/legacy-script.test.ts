/**
 * v1 脚本适配层测试 —— 走真实装载路径（临时 flows 目录 + loadCustomWorkflows）
 *
 * 覆盖：
 *  - 形态识别 / meta 剥离（注释前置、括号不配平）/ 包裹拒绝（static import、多余 export）
 *  - 装载：v1 .js 与 v2 .mjs 同目录共存；meta 校验 fail-loud
 *  - 执行：agent 字符串与 schema 返回形、parallel 语义（可恢复塌缩 null / 结构性上抛）、
 *    sequence 传值与可恢复停止、check、retry、checkpoint（gate 批准/拒绝/default 回落）、
 *    verify/judgePanel（v1 返回形）、fileExists 同步、subflow、journal 动态步骤
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { setExecutor, type AgentExecutor } from "../../src/runtime/engine.js"
import { AgentTimeoutError } from "../../src/workflow/agent.js"
import { setCheckpointGate } from "../../src/quality/checkpoint.js"
import { loadCustomWorkflows } from "../../src/workflows/loader.js"
import {
  detectLegacyScript,
  splitLegacyMeta,
  validateLegacyMeta,
  wrapLegacyModule,
} from "../../src/workflows/legacy-script.js"
import type { WorkflowContext, WorkflowDefinition } from "../../src/registry/definition.js"
import type { RunJournal } from "../../src/state/recorder.js"

const SMOKE_V1 = `export const meta = { name: 'smoke_test', description: '最小冒烟：2 个 agent 并行' }

phase('Scan')
const info = await agent('列出文件')

phase('Echo')
const results = await parallel([
  () => agent('说明工作流编排'),
  () => agent('说明确定性重放'),
])
return { info, results }
`

/** 执行 v1 脚本源码：写临时 .js → 装载 → 绑假 executor/journal 执行 */
interface FakeStep {
  index: number
  name?: string
  input?: unknown
  output?: unknown
  error?: unknown
}

async function runV1Script(
  source: string,
  options?: {
    executor?: AgentExecutor
    gate?: { ask: (req: { label: string; message: string }) => Promise<{ approved: boolean; reason?: string }> }
    subflow?: (id: string, args?: unknown) => Promise<{ runId: string; output: string }>
    workspaceRoot?: string
    args?: Record<string, unknown>
  },
): Promise<{ result: unknown; steps: FakeStep[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-legacy-"))
  await fs.writeFile(path.join(dir, "flow.js"), source, "utf8")
  const { definitions, errors } = await loadCustomWorkflows([dir], dir)
  assert.deepEqual(errors, [])
  assert.equal(definitions.length, 1)

  if (options?.executor !== undefined) setExecutor(options.executor)
  if (options?.gate !== undefined) setCheckpointGate(options.gate)

  const steps: FakeStep[] = []
  const journal = {
    async appendStep(name: string | undefined, input?: unknown) {
      const index = steps.length
      steps.push({ index, name, input })
      return index
    },
    async stepCompleted(index: number, output?: unknown) {
      steps[index]!.output = output
    },
    async stepFailed(index: number, error: unknown) {
      steps[index]!.error = error
    },
  } as unknown as RunJournal

  const ctx = {
    runId: "run_legacy_test",
    mode: "start",
    journal,
    workspaceRoot: options?.workspaceRoot ?? dir,
    ...(options?.subflow !== undefined ? { subflow: options.subflow } : {}),
  } as WorkflowContext

  try {
    const result = await (definitions[0] as WorkflowDefinition).run(options?.args ?? { topic: "测试" }, ctx)
    return { result, steps }
  } finally {
    setCheckpointGate(undefined)
  }
}

/** 回声 executor：无 jsonFor 回显提示词；有 jsonFor 一律返回其 JSON（schema 模式模拟） */
function echoExecutor(jsonFor?: (prompt: string) => unknown): AgentExecutor {
  return {
    async execute(task) {
      if (jsonFor !== undefined) {
        return { output: JSON.stringify(jsonFor(task.prompt)) }
      }
      return { output: `echo:${task.prompt}` }
    },
  }
}

// ── 形态识别与源码处理 ────────────────────────────────────────────────

test("detectLegacyScript：v1 形态识别，defineWorkflow 模块不误判", () => {
  assert.equal(detectLegacyScript(SMOKE_V1), true)
  assert.equal(
    detectLegacyScript(`import { defineWorkflow } from "@mickorz/opencode-agentic-workflow/core"\nexport default defineWorkflow({ id: "x", version: "1.0.0", run: async () => {} })`),
    false,
  )
  assert.equal(detectLegacyScript(`export const value = 1`), false)
})

test("splitLegacyMeta：注释前置保留在 body；配平失败报错", () => {
  const withComments = `// 顶部注释\nexport const meta = { name: 'a', description: '{假括号}' }\nphase('X')\nreturn 1`
  const split = splitLegacyMeta(withComments)
  assert.ok(split.ok)
  assert.match(split.metaStatement, /name: 'a'/)
  assert.ok(split.rest.includes("// 顶部注释"))
  assert.ok(split.rest.includes("phase('X')"))

  const bad = splitLegacyMeta(`export const meta = { name: 'a', nested: { x: 1 }\nreturn 1`)
  assert.ok(!bad.ok)
})

test("wrapLegacyModule：static import 与多余 export 拒绝（fail-loud）", () => {
  const split = splitLegacyMeta(SMOKE_V1)
  assert.ok(split.ok)
  const ok = wrapLegacyModule(split.metaStatement, split.rest)
  assert.ok(ok.ok)
  assert.match(ok.wrapped, /export default async function \(phase, agent, parallel/)

  const badImport = wrapLegacyModule("export const meta = {}", 'import fs from "node:fs"\nreturn 1')
  assert.ok(!badImport.ok)
  assert.match(badImport.error, /cannot use static import/)

  const badExport = wrapLegacyModule("export const meta = {}", "export const x = 1\nreturn 1")
  assert.ok(!badExport.ok)
})

test("validateLegacyMeta：name/description 形状校验", () => {
  assert.ok(validateLegacyMeta({ name: "smoke_test" }).ok)
  assert.ok(!validateLegacyMeta({ name: "bad-name" }).ok)
  assert.ok(!validateLegacyMeta({ name: "ok", description: 42 }).ok)
  assert.ok(!validateLegacyMeta(null).ok)
})

// ── 装载 ──────────────────────────────────────────────────────────────

test("装载：v1 .js 与 v2 .mjs 同目录共存，各按形态装载", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-legacy-mix-"))
  await fs.writeFile(path.join(dir, "legacy_flow.js"), SMOKE_V1, "utf8")
  await fs.writeFile(
    path.join(dir, "modern_flow.mjs"),
    `export default { id: "modern", version: "1.0.0", async run() { return { output: "ok" } } }\n`,
    "utf8",
  )
  const { definitions, errors } = await loadCustomWorkflows([dir], dir)
  assert.deepEqual(errors, [])
  const ids = definitions.map((d) => d.id).sort()
  assert.deepEqual(ids, ["modern", "smoke_test"])
})

test("装载：meta.name 非法 → 文件级 skip + 明确错误", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-legacy-bad-"))
  await fs.writeFile(
    path.join(dir, "bad.js"),
    `export const meta = { name: 'Bad-Name' }\nreturn 1`,
    "utf8",
  )
  const { definitions, errors } = await loadCustomWorkflows([dir], dir)
  assert.equal(definitions.length, 0)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /meta\.name/)
})

// ── 执行语义（v1 对位） ────────────────────────────────────────────────

test("执行：smoke 脚本——agent 字符串返回 + parallel 结果有序 + journal 动态步骤", async () => {
  const { result, steps } = await runV1Script(SMOKE_V1, { executor: echoExecutor() })
  assert.deepEqual(result, {
    info: "echo:列出文件",
    results: ["echo:说明工作流编排", "echo:说明确定性重放"],
  })
  // journal：3 个叶子 agent 步骤（parallel 不占步骤——与 v1 树的叶子粒度一致）
  assert.deepEqual(
    steps.map((s) => s.name),
    ["agent-1", "agent-2", "agent-3"],
  )
  assert.equal(steps[0]!.output, "echo:列出文件")
})

test("执行：agent schema 模式返回解析对象（v1 语义）", async () => {
  const source = `export const meta = { name: 'schema_test' }
const v = await agent('打分', { label: 'score', schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] } })
return v
`
  const { result, steps } = await runV1Script(source, {
    executor: echoExecutor(() => ({ score: 0.8 })),
  })
  assert.deepEqual(result, { score: 0.8 })
  assert.equal(steps[0]!.name, "score")
})

test("parallel：可恢复失败（agent 超时）塌缩 null；结构性错误上抛", async () => {
  const source = `export const meta = { name: 'p_test' }
const results = await parallel([
  () => agent('好'),
  () => agent('坏', { timeoutMs: 1 }),
])
return results
`
  // 超时 executor：立即挂起不返回 → 触发 AgentTimeoutError（可恢复）
  const timeoutExecutor: AgentExecutor = {
    async execute(task) {
      if (task.prompt === "坏") await new Promise(() => {})
      return { output: `echo:${task.prompt}` }
    },
  }
  const { result } = await runV1Script(source, { executor: timeoutExecutor })
  // 超时分支塌缩 null（v1 语义）；正常分支保留
  assert.deepEqual(result, ["echo:好", null])

  // 结构性错误：整个 parallel 拒绝
  const structural = `export const meta = { name: 'p_test2' }
const r = await parallel([() => agent('好')])
return r
`
  const badExecutor: AgentExecutor = {
    async execute() {
      throw new TypeError("结构性错误")
    },
  }
  await assert.rejects(
    runV1Script(structural, { executor: badExecutor }),
    /结构性错误/,
  )
})

test("sequence：传值链 + 可恢复失败停止返回 null（v1 语义）", async () => {
  const source = `export const meta = { name: 'seq_test' }
const v = await sequence([
  async () => 'a',
  async (prev) => prev + '-b',
  async (prev) => prev + '-c',
])
return v
`
  const { result } = await runV1Script(source, { executor: echoExecutor() })
  assert.equal(result, "a-b-c")

  const stopSource = `export const meta = { name: 'seq_stop' }
const v = await sequence([
  async () => 'a',
  async () => { return check(() => false, '不通过') },
])
return v
`
  const stop = await runV1Script(stopSource, { executor: echoExecutor() })
  assert.equal(stop.result, null)
})

test("check：通过返回 true；未通过抛可恢复错误（带自定义消息）", async () => {
  const pass = `export const meta = { name: 'c_test' }
await check(() => true)
return 'pass'
`
  const p = await runV1Script(pass, { executor: echoExecutor() })
  assert.equal(p.result, "pass")

  const fail = `export const meta = { name: 'c_fail' }
await check(() => false, '自定义失败消息')
return 'unreachable'
`
  await assert.rejects(runV1Script(fail, { executor: echoExecutor() }), /自定义失败消息/)
})

test("retry：until 短路返回；耗尽返回最后一次（不抛）——v1 语义", async () => {
  const source = `export const meta = { name: 'r_test' }
let n = 0
const v = await retry(
  () => ++n,
  { attempts: 5, until: (r) => r >= 3 },
)
return { v, n }
`
  const { result } = await runV1Script(source, { executor: echoExecutor() })
  assert.deepEqual(result, { v: 3, n: 3 })
})

test("checkpoint：gate 批准=true / 拒绝=false；无 gate 回落 default", async () => {
  const source = `export const meta = { name: 'cp_test' }
const ok = await checkpoint('允许吗？', { default: true })
return ok
`
  // gate 批准
  const approved = await runV1Script(source, {
    executor: echoExecutor(),
    gate: { ask: async () => ({ approved: true }) },
  })
  assert.equal(approved.result, true)
  assert.equal(approved.steps[0]!.name, "checkpoint:checkpoint")

  // gate 拒绝 → false（不抛，v1 语义）
  const rejected = await runV1Script(source, {
    executor: echoExecutor(),
    gate: { ask: async () => ({ approved: false, reason: "不批" }) },
  })
  assert.equal(rejected.result, false)

  // 无 gate → default=true
  const defaulted = await runV1Script(source, { executor: echoExecutor() })
  assert.equal(defaulted.result, true)

  // 无 gate 且无 default → fail-loud
  const noDefault = `export const meta = { name: 'cp_nd' }
await checkpoint('必须人工')
return 'unreachable'
`
  await assert.rejects(runV1Script(noDefault, { executor: echoExecutor() }), /default/)
})

test("verify：对抗评审返回 v1 形（real/realCount/total）", async () => {
  const source = `export const meta = { name: 'v_test' }
const verdict = await verify('地球绕太阳转', { reviewers: 2 })
return { real: verdict.real, realCount: verdict.realCount, total: verdict.total }
`
  const { result, steps } = await runV1Script(source, {
    executor: echoExecutor(() => ({ real: true, reason: "常识" })),
  })
  assert.deepEqual(result, { real: true, realCount: 2, total: 2 })
  assert.deepEqual(
    steps.map((s) => s.name),
    ["verify 1", "verify 2"],
  )
})

test("judgePanel：均分打分取最高（v1 形返回 best）", async () => {
  const source = `export const meta = { name: 'j_test' }
const best = await judgePanel(['甲', '乙'], { judges: 2, rubric: '朗朗上口' })
return { index: best.index, score: best.score, attempt: best.attempt }
`
  // 按候选文本区分打分：乙得分更高
  const { result, steps } = await runV1Script(source, {
    executor: echoExecutor((prompt) => ({ score: prompt.includes("乙") ? 0.9 : 0.2 })),
  })
  assert.deepEqual(result, { index: 1, score: 0.9, attempt: "乙" })
  // 2 候选 × 2 judge = 4 个 agent 步骤，label 带坐标
  assert.deepEqual(
    steps.map((s) => s.name),
    ["judge 1.1", "judge 1.2", "judge 2.1", "judge 2.2"],
  )
})

test("fileExists：同步语义，相对 workspaceRoot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-legacy-fe-"))
  await fs.writeFile(path.join(dir, "exists.txt"), "x", "utf8")
  const source = `export const meta = { name: 'fe_test' }
const a = fileExists('exists.txt')
const b = fileExists('missing.txt')
return { a, b }
`
  const { result } = await runV1Script(source, { executor: echoExecutor(), workspaceRoot: dir })
  assert.deepEqual(result, { a: true, b: false })
})

test("workflow：子流程经 ctx.subflow（journal 记 subflow 步骤）", async () => {
  const source = `export const meta = { name: 'wf_test' }
const r = await workflow('calc', { topic: '1+1' })
return r
`
  const { result, steps } = await runV1Script(source, {
    executor: echoExecutor(),
    subflow: async (id, args) => ({ runId: "sub_1", output: `${id}:${JSON.stringify(args)}` }),
  })
  assert.deepEqual(result, { runId: "sub_1", output: 'calc:{"topic":"1+1"}' })
  assert.equal(steps[0]!.name, "subflow:calc")
})

test("phase/log/console/setConcurrency：不抛（setConcurrency 响亮警告后忽略）", async () => {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (msg: string) => warnings.push(msg)
  try {
    const source = `export const meta = { name: 'misc_test' }
phase('P1')
log('日志一行')
console.log('console.log 也可用')
setConcurrency(4)
const info = await agent('跑一下')
return info
`
    const { result } = await runV1Script(source, { executor: echoExecutor() })
    assert.equal(result, "echo:跑一下")
    assert.equal(warnings.filter((w) => w.includes("setConcurrency")).length, 1)
  } finally {
    console.warn = originalWarn
  }
})

test("AgentTimeoutError 仍可被脚本自身 try/catch（v1 行为对位）", async () => {
  const source = `export const meta = { name: 'tc_test' }
let caught = 'none'
try {
  await agent('慢', { timeoutMs: 1 })
} catch (e) {
  caught = 'caught'
}
return caught
`
  const timeoutExecutor: AgentExecutor = {
    async execute() {
      await new Promise(() => {})
    },
  }
  const { result } = await runV1Script(source, { executor: timeoutExecutor })
  assert.equal(result, "caught")
  void AgentTimeoutError
})
