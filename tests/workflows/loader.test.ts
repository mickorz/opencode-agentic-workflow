/**
 * 代码 workflow 装载器测试（P2-14 + v0.6.0 JS-only）
 * 覆盖：三导出形态、模块内自定义逻辑、坏形状逐一跳过（无导出/缺 id/
 * 缺 run/import 失败/reserved/重复 id@version）、目录扫描与空目录文案、
 * <pkg>/core 裸说明符重写（无 node_modules 的用户目录可解析、相对导入
 * 保留、.cjs 明确报错、临时文件清理）、.json 移除提示
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { loadCustomWorkflows } from "../../src/workflows/loader.js"

let baseDir: string

test.before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-loader-"))
})

async function writeWorkflow(name: string, content: string): Promise<string> {
  const file = path.join(baseDir, name)
  await fs.writeFile(file, content)
  return file
}

test("代码装载：.mjs default export / .cjs module.exports / named definition 三形态全收", async () => {
  await writeWorkflow(
    "code-default.mjs",
    `export default { id: "code-default", version: "1.0.0", description: "mjs default",
      stepNames: ["a"], run: async () => ({ output: "ok" }) }`,
  )
  await writeWorkflow(
    "code-cjs.cjs",
    `module.exports = { id: "code-cjs", version: "1.0.0",
      stepNames: ["a"], run: async () => ({ output: "ok" }) }`,
  )
  await writeWorkflow(
    "code-named.mjs",
    `export const definition = { id: "code-named", version: "1.0.0",
      stepNames: ["a"], run: async () => ({ output: "ok" }) }`,
  )
  const { definitions, errors } = await loadCustomWorkflows(
    ["code-default.mjs", "code-cjs.cjs", "code-named.mjs"].map((n) => path.join(baseDir, n)),
    baseDir,
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(
    definitions.map((d) => d.id).sort(),
    ["code-cjs", "code-default", "code-named"],
  )
  for (const d of definitions) {
    assert.equal(typeof d.run, "function")
  }
})

test("代码装载：模块内自定义逻辑真实可执行（变量 + 方法）", async () => {
  await writeWorkflow(
    "code-logic.mjs",
    `const slugify = (s) => String(s).trim().replaceAll(" ", "-").toLowerCase()
     export default {
       id: "code-logic", version: "1.0.0", stepNames: ["a"],
       run: async (args) => ({ output: "slug:" + slugify(args.topic) }),
     }`,
  )
  const { definitions, errors } = await loadCustomWorkflows([path.join(baseDir, "code-logic.mjs")], baseDir)
  assert.deepEqual(errors, [])
  const fakeCtx = { runId: "r", mode: "start", runSteps: async () => undefined } as never
  const result = (await definitions[0]!.run({ topic: "Hello Custom Logic" }, fakeCtx)) as { output: string }
  assert.equal(result.output, "slug:hello-custom-logic")
})

test("代码装载：坏形状逐一报错跳过（无导出/缺 id/缺 run/import 失败/reserved/重复）", async () => {
  const dir = path.join(baseDir, "code-bad-dir")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "a-empty.mjs"), `export const nothing = 1`)
  await fs.writeFile(path.join(dir, "b-no-id.mjs"), `export default { version: "1.0.0", run: async () => {} }`)
  await fs.writeFile(path.join(dir, "c-no-run.mjs"), `export default { id: "code-no-run", version: "1.0.0" }`)
  await fs.writeFile(path.join(dir, "d-broken.mjs"), `export default { id: "code-broken" `)
  await fs.writeFile(
    path.join(dir, "e-builtin.mjs"),
    `export default { id: "smoke", version: "9.9.9", run: async () => {} }`,
  )
  await fs.writeFile(
    path.join(dir, "f-dup.mjs"),
    `export default { id: "dup-flow", version: "1.0.0", run: async () => ({ output: "ok" }) }`,
  )
  await fs.writeFile(
    path.join(dir, "g-dup.mjs"),
    `export default { id: "dup-flow", version: "1.0.0", run: async () => ({ output: "ok" }) }`,
  )
  const { definitions, errors } = await loadCustomWorkflows([dir], baseDir, ["smoke"])
  assert.deepEqual(definitions.map((d) => d.id), ["dup-flow"])
  const joined = errors.join("\n")
  assert.match(joined, /a-empty\.mjs: module must export a workflow/)
  assert.match(joined, /b-no-id\.mjs: workflow\.id must be a non-empty string/)
  assert.match(joined, /c-no-run\.mjs: workflow\.run must be a function/)
  assert.match(joined, /d-broken\.mjs: failed to import/)
  assert.match(joined, /e-builtin\.mjs: id "smoke" is reserved/)
  assert.match(joined, /g-dup\.mjs: duplicate dup-flow@1\.0\.0/)
})

test("代码装载：空目录报错文案只列代码扩展名；点开头文件不参与扫描", async () => {
  const dir = path.join(baseDir, "code-empty-dir")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, ".hidden.mjs"), `export default { id: "hidden", version: "1.0.0", run: async () => {} }`)
  const result = await loadCustomWorkflows([dir], baseDir)
  assert.deepEqual(result.definitions, [])
  assert.match(result.errors[0] ?? "", /no workflow files \(\.js\/\.mjs\/\.cjs\)/)
})

test("裸说明符重写：无 node_modules 的目录可 import <pkg>/core 并真实可用", async () => {
  // baseDir 是 os.tmpdir() 下的临时目录——node_modules 链上必然没有本包，
  // 等价于用户项目目录的全局安装场景
  await writeWorkflow(
    "bare-core.mjs",
    `import { agent, defineWorkflow } from "@mickorz/opencode-agentic-workflow/core"
     export default defineWorkflow({
       id: "bare-core", version: "1.0.0", stepNames: ["probe"],
       run: async () => ({ output: "agent:" + typeof agent + ",workflow:" + typeof defineWorkflow }),
     })`,
  )
  const { definitions, errors } = await loadCustomWorkflows([path.join(baseDir, "bare-core.mjs")], baseDir)
  assert.deepEqual(errors, [])
  assert.equal(definitions[0]!.id, "bare-core")
  const fakeCtx = { runId: "r", mode: "start", runSteps: async () => undefined } as never
  const result = (await definitions[0]!.run({}, fakeCtx)) as { output: string }
  assert.equal(result.output, "agent:function,workflow:function")
})

test("裸说明符重写：文件内其余相对导入保持可用（临时 .mjs 落在原目录）", async () => {
  await writeWorkflow(
    "with-helper.mjs",
    `import { shout } from "./helper-shout.mjs"
     export default {
       id: "with-helper", version: "1.0.0", stepNames: ["a"],
       run: async (args) => ({ output: shout(args.topic) }),
     }`,
  )
  await writeWorkflow("helper-shout.mjs", `export const shout = (s) => String(s).toUpperCase() + "!"`)
  const { definitions, errors } = await loadCustomWorkflows([path.join(baseDir, "with-helper.mjs")], baseDir)
  assert.deepEqual(errors, [])
  const fakeCtx = { runId: "r", mode: "start", runSteps: async () => undefined } as never
  const result = (await definitions[0]!.run({ topic: "works" }, fakeCtx)) as { output: string }
  assert.equal(result.output, "WORKS!")
})

test("裸说明符重写：装载后目录无残留临时文件", async () => {
  const dir = path.join(baseDir, "temp-clean-dir")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "uses-core.mjs"),
    `import { defineWorkflow } from "@mickorz/opencode-agentic-workflow/core"
     export default defineWorkflow({ id: "uses-core", version: "1.0.0", stepNames: [], run: async () => ({ output: "ok" }) })`,
  )
  const { errors } = await loadCustomWorkflows([dir], baseDir)
  assert.deepEqual(errors, [])
  const names = await fs.readdir(dir)
  assert.deepEqual(names.filter((n) => n.includes(".aw.mjs")), [])
})

test("裸说明符重写：.cjs 引用 <pkg>/core 给出明确改名提示", async () => {
  await writeWorkflow(
    "cjs-core.cjs",
    `const { agent } = require("@mickorz/opencode-agentic-workflow/core")
     module.exports = { id: "cjs-core", version: "1.0.0", run: async () => ({ output: typeof agent }) }`,
  )
  const { definitions, errors } = await loadCustomWorkflows([path.join(baseDir, "cjs-core.cjs")], baseDir)
  assert.deepEqual(definitions, [])
  assert.match(errors[0] ?? "", /cjs-core\.cjs: .*rename to \.mjs/)
})

test(".json 移除：目录内 .json 给迁移提示且不装载；显式 .json 入口同样提示", async () => {
  const dir = path.join(baseDir, "json-removal-dir")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "legacy.json"), JSON.stringify({ id: "legacy", steps: [] }))
  await fs.writeFile(
    path.join(dir, "modern.mjs"),
    `export default { id: "modern", version: "1.0.0", run: async () => ({ output: "ok" }) }`,
  )
  const dirResult = await loadCustomWorkflows([dir], baseDir)
  assert.deepEqual(dirResult.definitions.map((d) => d.id), ["modern"])
  assert.match(dirResult.errors.join("\n"), /legacy\.json: JSON workflows were removed in v0\.6\.0/)

  const fileResult = await loadCustomWorkflows([path.join(baseDir, "json-removal-dir", "legacy.json")], baseDir)
  assert.deepEqual(fileResult.definitions, [])
  assert.match(fileResult.errors[0] ?? "", /JSON workflows were removed in v0\.6\.0/)
})
