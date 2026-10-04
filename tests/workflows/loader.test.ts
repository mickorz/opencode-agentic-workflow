/**
 * 声明式 workflow 装载器测试（P4）
 * 覆盖：入口展开（文件/目录/不存在/空目录）、校验全分支（顶层/步骤/
 * verify 形态）、reservedIds 与同文件重复、模板解析（topic/args/steps/
 * 未知变量）、run 行为（agent+checkpoint+fileExists 全链、output 模板、
 * 缺省 output、fileExists 相对 workspaceRoot）
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  loadDeclarativeWorkflows,
  resolveTemplate,
} from "../../src/workflows/loader.js"
import { setExecutor } from "../../src/runtime/engine.js"
import { sequence } from "../../src/workflow/sequence.js"
import type { AgentExecutor, AgentTask } from "../../src/runtime/executor.js"
import { setCheckpointGate } from "../../src/quality/checkpoint.js"
import { PolicyCheckpointGate } from "../../src/plugin/policy-checkpoint-gate.js"

/** echo executor：记录 prompt，返回 prompt 尾段 */
class EchoExecutor implements AgentExecutor {
  readonly prompts: string[] = []
  async execute(task: AgentTask) {
    this.prompts.push(task.prompt)
    return { output: `echo:${task.prompt.slice(0, 30)}` }
  }
}

let baseDir: string

test.before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-loader-"))
  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))
})

async function writeWorkflow(name: string, content: unknown): Promise<string> {
  const file = path.join(baseDir, name)
  await fs.writeFile(file, typeof content === "string" ? content : JSON.stringify(content))
  return file
}

/** 最小合法声明 */
const valid = {
  id: "release-notes",
  version: "1.0.0",
  description: "test flow",
  steps: [
    { name: "draft", agent: "为 {{topic}} 起草" },
    { name: "gate", checkpoint: "批准 {{topic}}？" },
    { name: "check", fileExists: "notes.md" },
  ],
  output: "OUT: {{steps.draft}}",
}

test("run：自定义 args（audience）注入模板（P0-1 args 可达性）", async () => {
  const echo = new EchoExecutor()
  setExecutor(echo)
  const workDir = await fs.mkdtemp(path.join(baseDir, "ws-args-"))

  const flow = {
    ...valid,
    id: "digest",
    args: {
      type: "object",
      properties: {
        topic: { type: "string" },
        audience: { type: "string", description: "目标读者" },
      },
      required: ["topic", "audience"],
    },
    steps: [
      { name: "draft", agent: "为 {{topic}} 写速览，目标读者：{{args.audience}}" },
      { name: "gate", checkpoint: "批准 {{topic}}？" },
    ],
    output: "OUT",
  }
  await writeWorkflow("args-flow.json", flow)
  const { definitions } = await loadDeclarativeWorkflows([path.join(baseDir, "args-flow.json")], baseDir)

  const { output } = await runDefinition(definitions[0]!, { topic: "状态机", audience: "中学生" }, workDir)
  assert.equal(output, "OUT")
  // agent prompt 同时注入了 topic 与自定义 args.audience
  assert.match(echo.prompts[0]!, /为 状态机 写速览/)
  assert.match(echo.prompts[0]!, /目标读者：中学生/)
})

test("装载：合法文件转换为 definition（stepNames/描述/缺省 argsSchema）", async () => {
  await writeWorkflow("ok.json", valid)
  const { definitions, errors } = await loadDeclarativeWorkflows(
    [path.join(baseDir, "ok.json")],
    baseDir,
  )
  assert.deepEqual(errors, [])
  assert.equal(definitions.length, 1)
  const def = definitions[0]!
  assert.equal(def.id, "release-notes")
  assert.equal(def.version, "1.0.0")
  assert.deepEqual(def.stepNames, ["draft", "gate", "check"])
  assert.deepEqual((def.argsSchema as { required?: string[] }).required, ["topic"])
})

test("装载：目录入口扫描一层 *.json（排序）；相对路径基于 baseDir", async () => {
  const dir = path.join(baseDir, "flows")
  await fs.mkdir(dir)
  await writeWorkflow(path.join("flows", "b-second.json"), { ...valid, id: "b-second" })
  await writeWorkflow(path.join("flows", "a-first.json"), { ...valid, id: "a-first" })
  await fs.writeFile(path.join(dir, "readme.txt"), "not json")
  const { definitions, errors } = await loadDeclarativeWorkflows(["flows"], baseDir)
  assert.deepEqual(errors, [])
  assert.deepEqual(definitions.map((d) => d.id).sort(), ["a-first", "b-second"])
})

test("装载：文件级错误全部跳过不阻断（不存在/坏 JSON/校验失败/reserved/重复）", async () => {
  await writeWorkflow("broken.json", "{ not json")
  await writeWorkflow("bad-id.json", { ...valid, id: "Bad_Id" })
  await writeWorkflow("no-steps.json", { id: "no-steps" })
  await writeWorkflow("builtin.json", { ...valid, id: "artifact", steps: [{ name: "x", agent: "y" }] })
  const dupFile = await writeWorkflow("dup.json", { id: "dup-flow", steps: [{ name: "x", agent: "y" }] })
  await writeWorkflow("dup2.json", { id: "dup-flow", steps: [{ name: "x", agent: "y" }] })
  const { definitions, errors } = await loadDeclarativeWorkflows(
    [
      "missing-dir",
      path.join(baseDir, "broken.json"),
      path.join(baseDir, "bad-id.json"),
      path.join(baseDir, "no-steps.json"),
      path.join(baseDir, "builtin.json"),
      path.join(baseDir, "dup.json"),
      path.join(baseDir, "dup2.json"),
    ],
    baseDir,
    ["artifact"],
  )
  const ids = definitions.map((d) => d.id)
  assert.ok(ids.includes("dup-flow")) // 第一份 dup 合法注册
  assert.equal(ids.filter((i) => i === "dup-flow").length, 1)
  assert.equal(definitions.length, 1)
  const joined = errors.join("\n")
  assert.match(joined, /missing-dir: no such file/)
  assert.match(joined, /broken\.json: invalid JSON/)
  assert.match(joined, /bad-id\.json: "id" must match/)
  assert.match(joined, /no-steps\.json: "steps" must be a non-empty array/)
  assert.match(joined, /builtin\.json: id "artifact" is reserved/)
  assert.match(joined, /dup2\.json: duplicate dup-flow@1\.0\.0/)
})

test("校验：步骤键互斥与未知键", async () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["both-keys.json", { id: "x-flow", steps: [{ name: "s", agent: "a", checkpoint: "c" }] }, /exactly one of/],
    ["no-key.json", { id: "x-flow", steps: [{ name: "s" }] }, /exactly one of/],
    ["unknown-step-key.json", { id: "x-flow", steps: [{ name: "s", agent: "a", retries: 3 }] }, /unknown key\(s\) \[retries\]/],
    ["unknown-top-key.json", { id: "x-flow", hooks: true, steps: [{ name: "s", agent: "a" }] }, /unknown top-level key "hooks"/],
    ["verify-shape.json", { id: "x-flow", steps: [{ name: "s", verify: { criteria: "x" } }] }, /verify must be/],
  ]
  for (const [name, content, pattern] of cases) {
    await writeWorkflow(name, content)
    const { definitions, errors } = await loadDeclarativeWorkflows([path.join(baseDir, name)], baseDir)
    assert.equal(definitions.length, 0, `${name} 应被拒`)
    assert.match(errors[0]!, pattern)
  }
})

test("模板：topic / args.x / steps.<name> 解析；未知变量逐一报错", () => {
  const outputs = new Map([["draft", "DRAFT-TEXT"]])
  assert.equal(resolveTemplate("{{topic}} | {{ args.x }} | {{steps.draft}}", { topic: "T", x: 42 }, outputs), "T | 42 | DRAFT-TEXT")
  assert.equal(resolveTemplate("无变量原样通过", {}, outputs), "无变量原样通过")
  assert.throws(() => resolveTemplate("{{topic}}", {}, outputs), /\{\{topic\}\} is not provided/)
  assert.throws(() => resolveTemplate("{{args.missing}}", {}, outputs), /args\.missing/)
  assert.throws(() => resolveTemplate("{{steps.other}}", {}, outputs), /steps\.other.*available step outputs: \[draft\]/)
  assert.throws(() => resolveTemplate("{{workspace}}", {}, outputs), /unknown template variable/)
})

/** 以 stub ctx 跑 definition.run（runSteps = 真实 sequence） */
async function runDefinition(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  definition: any,
  args: Record<string, unknown>,
  workspaceRoot: string,
): Promise<{ output: string; state: Record<string, unknown> | undefined }> {
  let state: Record<string, unknown> | undefined
  const ctx = {
    workspaceRoot,
    runSteps: async (steps: Array<(prev?: Record<string, unknown>) => Promise<Record<string, unknown>>>, options?: { stepNames?: string[] }) => {
      state = await sequence(steps, options as { stepNames?: string[] })
      return state
    },
  }
  const result = await definition.run(args, ctx)
  return { output: result.output, state }
}

test("run：agent→checkpoint→fileExists 全链（模板注入 prompt、缺省 root 解析、output 模板）", async () => {
  const echo = new EchoExecutor()
  setExecutor(echo)
  const workDir = await fs.mkdtemp(path.join(baseDir, "ws-"))
  await fs.writeFile(path.join(workDir, "notes.md"), "content")

  await writeWorkflow("run-flow.json", valid)
  const { definitions } = await loadDeclarativeWorkflows([path.join(baseDir, "run-flow.json")], baseDir)
  const { output, state } = await runDefinition(definitions[0]!, { topic: "T1" }, workDir)

  // agent prompt 注入了 {{topic}}
  assert.match(echo.prompts[0]!, /为 T1 起草/)
  // output 模板使用了 agent 步输出
  assert.match(output, /^OUT: echo:/)
  // 状态累积：三步各留键，fileExists 步记录绝对路径
  assert.equal(state?.gate, "approved")
  assert.match(String(state?.check), /notes\.md$/)
})

test("run：缺省 output = 最后一个 agent 步输出；无 agent 步时为完成文案", async () => {
  const echo = new EchoExecutor()
  setExecutor(echo)
  await writeWorkflow(
    "default-out.json",
    { id: "default-out", steps: [{ name: "only", agent: "做点事" }] },
  )
  const d1 = (await loadDeclarativeWorkflows([path.join(baseDir, "default-out.json")], baseDir)).definitions[0]!
  const r1 = await runDefinition(d1, { topic: "T" }, baseDir)
  assert.match(r1.output, /^echo:/)

  await writeWorkflow(
    "no-agent.json",
    { id: "no-agent", steps: [{ name: "gate", checkpoint: "批" }] },
  )
  const d2 = (await loadDeclarativeWorkflows([path.join(baseDir, "no-agent.json")], baseDir)).definitions[0]!
  const r2 = await runDefinition(d2, { topic: "T" }, baseDir)
  assert.equal(r2.output, "workflow no-agent completed")
})

test("run：fileExists 在 workspaceRoot 下不存在 → 步骤失败；模板缺变量 → 步骤失败", async () => {
  const echo = new EchoExecutor()
  setExecutor(echo)
  const emptyDir = await fs.mkdtemp(path.join(baseDir, "empty-"))
  await writeWorkflow("run-flow2.json", valid)
  const def = (await loadDeclarativeWorkflows([path.join(baseDir, "run-flow2.json")], baseDir)).definitions[0]!
  await assert.rejects(() => runDefinition(def, { topic: "T" }, emptyDir), /notes\.md exists in workspace/)

  // 缺 topic：第一步模板就应报错（清晰指出变量名）
  await writeWorkflow("need-args.json", {
    id: "need-args",
    steps: [{ name: "s", agent: "主题是 {{args.subject}}" }],
  })
  const def2 = (await loadDeclarativeWorkflows([path.join(baseDir, "need-args.json")], baseDir)).definitions[0]!
  await assert.rejects(() => runDefinition(def2, {}, emptyDir), /args\.subject.*is not provided/)
})
