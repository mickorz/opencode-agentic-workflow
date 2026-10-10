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
  /** v0.10.0：appendStep meta（timeoutMs/attemptsMax）与收口 attempt */
  meta?: { timeoutMs?: number; attemptsMax?: number }
  attempt?: number
}

async function runV1Script(
  source: string,
  options?: {
    executor?: AgentExecutor
    gate?: { ask: (req: { label: string; message: string }) => Promise<{ approved: boolean; reason?: string }> }
    subflow?: (
      id: string,
      args?: unknown,
    ) => Promise<{ runId: string; output: string; result?: unknown }>
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
    async appendStep(
      name: string | undefined,
      input?: unknown,
      meta?: { timeoutMs?: number; attemptsMax?: number },
    ) {
      const index = steps.length
      steps.push({ index, name, input, meta })
      return index
    },
    async stepCompleted(index: number, output?: unknown, attempt?: number) {
      steps[index]!.output = output
      if (attempt !== undefined) steps[index]!.attempt = attempt
    },
    async stepFailed(index: number, error: unknown, attempt?: number) {
      steps[index]!.error = error
      if (attempt !== undefined) steps[index]!.attempt = attempt
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

test("装载：v0.9.0 单形态——v1 .js 装载，同目录 .mjs fail-loud 不装载", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-legacy-mix-"))
  await fs.writeFile(path.join(dir, "legacy_flow.js"), SMOKE_V1, "utf8")
  await fs.writeFile(
    path.join(dir, "modern_flow.mjs"),
    `export default { id: "modern", version: "1.0.0", async run() { return { output: "ok" } } }\n`,
    "utf8",
  )
  const { definitions, errors } = await loadCustomWorkflows([dir], dir)
  assert.deepEqual(definitions.map((d) => d.id), ["smoke_test"])
  assert.match(errors.join("\n"), /modern_flow\.mjs: \.mjs\/\.cjs workflow files were removed in v0\.9\.0/)
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
  // fallback 包一层吸收闸门登记（v1 的显式吸收姿势），同时保住 parallel 返回值
  const source = `export const meta = { name: 'p_test' }
const results = await fallback([
  () => parallel([
    () => agent('好'),
    () => agent('坏', { timeoutMs: 1 }),
  ]),
  () => 'unreachable',
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
  // 超时分支塌缩 null（v1 语义）；正常分支保留；fallback 吸收登记后 run 完成
  assert.deepEqual(result, ["echo:好", null])

  // 不吸收的裸 parallel：run 终检闸门触发（v1 failure-gate 对位）
  const bare = `export const meta = { name: 'p_test2' }
const r = await parallel([() => agent('坏', { timeoutMs: 1 })])
return r
`
  await assert.rejects(
    runV1Script(bare, { executor: timeoutExecutor }),
    /阶段失败闸门触发/,
  )

  // v1 分类学：普通 Error 默认可恢复 → 塌缩 null + 登记闸门 → run 终检触发
  const plainErr = `export const meta = { name: 'p_test3' }
const r = await parallel([() => agent('好')])
return r
`
  const badExecutor: AgentExecutor = {
    async execute() {
      throw new TypeError("普通执行错误")
    },
  }
  await assert.rejects(
    runV1Script(plainErr, { executor: badExecutor }),
    /阶段失败闸门触发/,
  )

  // 真结构性（适配层契约：未知选项）→ parallel 立即上抛，不塌缩
  const structural = `export const meta = { name: 'p_test4' }
const r = await parallel([() => agent('好', { noSuchOption: 1 })])
return r
`
  await assert.rejects(
    runV1Script(structural, { executor: echoExecutor() }),
    /不支持选项 "noSuchOption"/,
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

  // v1 分类学：普通 Error 也算可恢复 → sequence 停止返 null，run 正常完成
  // （seq_fail_parent 对位：后续节点不执行，流程不崩）
  const plainStop = `export const meta = { name: 'seq_plain_stop' }
const seen = []
const r = await sequence([
  () => { seen.push('a'); return 'step-a' },
  () => { seen.push('b'); throw new Error('第二个节点故意失败') },
  () => { seen.push('c'); return 'never' },
])
const after = await agent('回复固定文本：STOP-CHECK')
return { seqResult: r, isNull: r === null, seen, after }
`
  const plain = await runV1Script(plainStop, { executor: echoExecutor() })
  assert.deepEqual(plain.result, {
    seqResult: null,
    isNull: true,
    seen: ["a", "b"],
    after: "echo:回复固定文本：STOP-CHECK",
  })
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
  // v1 语义：workflow() 返回子流程返回值本体（此处子输出为纯文本 → 字符串）
  assert.equal(result, 'calc:{"topic":"1+1"}')
  assert.equal(steps[0]!.name, "subflow:calc")
})

test("workflow：返回值对象还原（v1 的 spec.brief 直取语义）", async () => {
  const source = `export const meta = { name: 'wf_obj' }
const spec = await workflow('calc')
return spec.brief
`
  const { result } = await runV1Script(source, {
    executor: echoExecutor(),
    subflow: async () => ({ runId: "sub_2", output: JSON.stringify({ brief: "一句话规格" }) }),
  })
  assert.equal(result, "一句话规格")
})

test("workflow：subflow 内存直传 result 保真（{output:text} 形状不丢结构）", async () => {
  const source = `export const meta = { name: 'wf_direct' }
const r = await workflow('sentence_a')
return { got: r.output, kind: typeof r }
`
  const childReturn = { output: "海是地球表面广阔相连的咸水体。" }
  const { result } = await runV1Script(source, {
    executor: echoExecutor(),
    // 内存链路：output 已被 toOutput 抽平，result 携带本体
    subflow: async () => ({
      runId: "sub_3",
      output: childReturn.output,
      result: childReturn,
    }),
  })
  assert.deepEqual(result, { got: "海是地球表面广阔相连的咸水体。", kind: "object" })
})

test("workflow：result 缺失时回落 output 解析（跨进程/旧链路兼容）", async () => {
  const source = `export const meta = { name: 'wf_fallback' }
const r = await workflow('calc')
return typeof r === 'string' ? r : r.output
`
  // 旧链路只有抽平后的 output（{output:"text"} 已不可逆）→ 按纯文本返回
  const { result } = await runV1Script(source, {
    executor: echoExecutor(),
    subflow: async () => ({ runId: "sub_4", output: "纯文本句子" }),
  })
  assert.equal(result, "纯文本句子")
})

test("version()：返回插件运行时版本（与 package.json 一致）", async () => {
  const source = `export const meta = { name: 'ver_check' }
return version()
`
  const { result } = await runV1Script(source, { executor: echoExecutor() })
  const pkgVersion = JSON.parse(await fs.readFile("package.json", "utf8")).version
  assert.equal(result, pkgVersion)
  assert.match(String(result), /^\d+\.\d+\.\d+$/)
})

test("workflow：路径形与对象形引用经装载索引解析（脚本一字不改）", async () => {
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), "agw-legacy-ref-"))
  const nativeDir = path.join(proj, "scripts", "native")
  await fs.mkdir(nativeDir, { recursive: true })
  await fs.writeFile(
    path.join(proj, "scripts", "util.js"),
    `export const meta = { name: 'ref_util' }\nreturn 'u'\n`,
    "utf8",
  )
  await fs.writeFile(
    path.join(nativeDir, "child.js"),
    `export const meta = { name: 'ref_child', description: '被路径引用的子流程' }\nreturn { tag: args.tag ?? 'none' }\n`,
    "utf8",
  )
  // 镜像真实装载拓扑：scripts/ 根（顶层文件）+ scripts/native/ 根——
  // 根的父目录（= 工程根）成为解析基准，'./scripts/native/x.js' 由此命中
  const { definitions, errors } = await loadCustomWorkflows(
    [path.join(proj, "scripts"), path.join(proj, "scripts", "native")],
    proj,
  )
  assert.deepEqual(errors, [])
  assert.equal(definitions.length, 2)

  const calls: Array<{ id: string; args: unknown }> = []
  const { result, steps } = await runV1Script(
    `export const meta = { name: 'runner' }
const a = await workflow('./scripts/native/child.js', { tag: 'PATH' })
const b = await workflow({ scriptPath: './scripts/native/child.js', label: 'B道' }, { tag: 'OBJ' })
return { a, b }
`,
    {
      executor: echoExecutor(),
      workspaceRoot: proj,
      subflow: async (id, args) => {
        calls.push({ id, args })
        const tag = (args as { tag?: string } | undefined)?.tag ?? "none"
        return { runId: `sub_${calls.length}`, output: JSON.stringify({ tag }) }
      },
    },
  )
  assert.deepEqual(calls.map((c) => c.id), ["ref_child", "ref_child"])
  assert.deepEqual(result, { a: { tag: "PATH" }, b: { tag: "OBJ" } })
  assert.deepEqual(
    steps.map((s) => s.name),
    ["subflow:ref_child", "subflow:ref_child(B道)"],
  )
})

test("workflow：args 克隆隔离——子流程改 args 不污染父对象（v1 mutate 验收对位）", async () => {
  const source = `export const meta = { name: 'wf_clone' }
const cfg = { counter: 1 }
await workflow('mutate_child', { cfg })
return { counter: cfg.counter, injected: 'injected' in cfg }
`
  // 假 subflow：真实模拟子流程对 args 的原位改写（无克隆即污染父对象）
  const { result } = await runV1Script(source, {
    executor: echoExecutor(),
    subflow: async (_id, args) => {
      const cfg = (args as { cfg?: { counter?: number; injected?: boolean } }).cfg
      if (cfg) {
        cfg.counter = 999
        cfg.injected = true
      }
      return { runId: "sub_c", output: "ok" }
    },
  })
  assert.deepEqual(result, { counter: 1, injected: false })
})

test("workflow：未知引用 fail-loud（列出已试基准）", async () => {
  const source = `export const meta = { name: 'wf_bad' }
await workflow('./nope/missing.js')
return 1
`
  await assert.rejects(
    runV1Script(source, {
      executor: echoExecutor(),
      subflow: async (id) => ({ runId: "x", output: id }),
    }),
    /找不到对应 flow/,
  )
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

test("agent 选项治理：未知键 fail-loud；agentType 警告后忽略（v1 降级语义）", async () => {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (msg: string) => warnings.push(msg)
  try {
    const unknown = `export const meta = { name: 'opt_bad' }
await agent('x', { label: 'l', fancyNewOption: 1 })
return 1
`
    await assert.rejects(
      runV1Script(unknown, { executor: echoExecutor() }),
      /不支持选项 "fancyNewOption"/,
    )

    const withType = `export const meta = { name: 'opt_type' }
const r = await agent('x', { label: 'l', agentType: 'general' })
return r
`
    const ok = await runV1Script(withType, { executor: echoExecutor() })
    assert.equal(ok.result, "echo:x")
    assert.equal(warnings.filter((w) => w.includes("agentType")).length, 1)
  } finally {
    console.warn = originalWarn
  }
})

test("isolation worktree：git 仓库内 per-call worktree + 提示词注入 + 用后拆除；非 git 降级", async () => {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const run = promisify(execFile)
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "agw-legacy-wt-"))
  await run("git", ["init", "-q"], { cwd: repo })
  await run("git", ["config", "user.email", "t@t"], { cwd: repo })
  await run("git", ["config", "user.name", "t"], { cwd: repo })
  await run("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo })

  const prompts: string[] = []
  const executor: AgentExecutor = {
    async execute(task) {
      prompts.push(task.prompt)
      return { output: `cwd:${task.cwd ?? "none"}` }
    },
  }
  const source = `export const meta = { name: 'wt_test' }
const r = await agent('写点东西', { label: '隔离写手', isolation: 'worktree' })
return r
`
  const { result } = await runV1Script(source, { executor, workspaceRoot: repo })
  // 提示词带 v1 同款工作目录说明；cwd 绑定到 worktree 根
  assert.match(prompts[0]!, /\[工作目录\].*git worktree/)
  assert.match(result as string, /^cwd:/)
  assert.ok(!(result as string).includes("none"))
  // worktree 已拆除（worktrees 目录下无残留子目录）
  const wtDir = path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`)
  const leftover = await fs.readdir(wtDir).catch(() => [] as string[])
  assert.equal(leftover.filter((d) => d.startsWith("legacy-")).length, 0)

  // 非 git 目录：响亮降级共享目录（v1 同款语义），执行不受影响
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (msg: string) => warnings.push(msg)
  try {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "agw-legacy-nowt-"))
    const degraded = await runV1Script(source, { executor, workspaceRoot: plain })
    assert.match(degraded.result as string, /^cwd:none|^cwd:\/.*plain/)
    assert.equal(warnings.filter((w) => w.includes("worktree 隔离不可用")).length, 1)
  } finally {
    console.warn = originalWarn
  }
}, { timeout: 30_000 })

test("AgentTimeoutError 顶层塌缩 null + run 终检闸门（v1 语义：可恢复失败不抛）", async () => {
  const source = `export const meta = { name: 'tc_test' }
const slow = await agent('慢', { timeoutMs: 1 })
const tail = await agent('回复固定文本：收尾成功')
return { slow, tail }
`
  const timeoutExecutor: AgentExecutor = {
    async execute(task) {
      if (task.prompt.includes("慢")) await new Promise(() => {})
      return { output: "收尾成功" }
    },
  }
  const outcome = await runV1Script(source, { executor: timeoutExecutor }).then(
    () => ({ ok: true as const }),
    (e: unknown) => ({ ok: false as const, e }),
  )
  // 超时 agent 塌缩 null；同阶段 tail 照常执行；无后续 phase/fallback 吸收 →
  // run 终检闸门抛「阶段失败闸门触发」（v1 语义）
  assert.equal(outcome.ok, false)
  assert.match(String(outcome.e), /阶段失败闸门触发/)
  void AgentTimeoutError
})

test("阶段失败闸门：同 phase tail 照常执行，下一 phase() 边界终止（v1 failure_gate 对位）", async () => {
  const source = `export const meta = { name: 'gate_test' }
phase('执行')
const bad = await agent('必超时', { timeoutMs: 1, retries: 0 })
const tail = await agent('回复固定文本：TAIL-OK')
phase('汇总')
return 'unreachable'
`
  const timeoutExecutor: AgentExecutor = {
    async execute(task) {
      if (task.prompt.includes("必超时")) await new Promise(() => {})
      return { output: "TAIL-OK" }
    },
  }
  await assert.rejects(
    runV1Script(source, { executor: timeoutExecutor }),
    /阶段失败闸门触发/,
  )
})

test("阶段失败闸门：fallback 成功吸收（v1 语义），run 正常完成", async () => {
  const source = `export const meta = { name: 'gate_fb_test' }
const bad = await agent('必超时', { timeoutMs: 1, retries: 0 })
const rescued = await fallback([
  () => check(() => false, '候选一不满足'),
  () => 'rescued-value',
])
return { bad, rescued }
`
  const timeoutExecutor: AgentExecutor = {
    async execute(task) {
      if (task.prompt.includes("必超时")) await new Promise(() => {})
      return { output: "x" }
    },
  }
  const { result } = await runV1Script(source, { executor: timeoutExecutor })
  assert.deepEqual(result, { bad: null, rescued: "rescued-value" })
})

test("执行：v0.10.0 agent 重试/超时元数据进 journal（attempt 收口 + 耗尽语义）", async () => {
  const source = `export const meta = { name: 'attempt_flow' }
const ok = await agent('重试后成功', { retries: 2, timeoutMs: 60000 })
const dead = await fallback([
  () => agent('必失败', { retries: 1 }),
  () => 'rescued',
])
return { ok, dead }
`
  let calls = 0
  const flaky: AgentExecutor = {
    async execute(task) {
      calls += 1
      if (task.prompt.includes("重试后成功") && calls <= 1) {
        throw new Error("boom #1")
      }
      if (task.prompt.includes("必失败")) throw new Error("always fails")
      return { output: "ok" }
    },
  }
  const { result, steps } = await runV1Script(source, { executor: flaky })
  // fallback 成功吸收可恢复失败（v1 语义），run 正常完成
  assert.deepEqual(result, { ok: "ok", dead: "rescued" })

  // 成功步：meta 记录 timeoutMs/attemptsMax，attempt = 2（第二次成功）
  const okStep = steps.find((s) => s.error === undefined && s.name === "agent-1")
  assert.notEqual(okStep, undefined)
  assert.deepEqual(okStep?.meta, { timeoutMs: 60000, attemptsMax: 3 })
  assert.equal(okStep?.attempt, 2)

  // 失败步：attempt = attemptsMax（重试耗尽；fallback 吸收不抹 journal 记录）
  const deadStep = steps.find((s) => s.error !== undefined)
  assert.notEqual(deadStep, undefined)
  assert.equal(deadStep?.attempt, 2)
  assert.deepEqual(deadStep?.meta, { attemptsMax: 2 })
})
