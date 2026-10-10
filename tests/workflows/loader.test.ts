/**
 * 代码 workflow 装载器测试（v0.9.0 单形态化）
 * 覆盖：v1 js 脚本唯一装载形态（happy path + reserved/重复）、.mjs/.cjs
 * fail-loud（目录内与显式入口）、defineWorkflow 模块 fail-loud、无 meta
 * 普通模块 fail-loud、.json 移除提示、空目录文案、legacy 装载后无临时文件残留
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

const legacyScript = (name: string) => `export const meta = {
  name: "${name}",
  description: "loader test fixture",
}
// v1 脚本形态：魔法全局 + 顶层 return
const topic = args.topic ?? "t"
return { output: "done:" + topic }
`

test("唯一形态 happy path：v1 js 脚本装载并真实可执行", async () => {
  const file = await writeWorkflow("legacy_ok.js", legacyScript("legacy_ok"))
  const { definitions, errors } = await loadCustomWorkflows([file], baseDir)
  assert.deepEqual(errors, [])
  assert.equal(definitions.length, 1)
  assert.equal(definitions[0]!.id, "legacy_ok")
  assert.equal(typeof definitions[0]!.run, "function")
})

test("v0.9.0 移除：目录内 .mjs/.cjs fail-loud 给改写指引；.js 照常装载", async () => {
  const dir = path.join(baseDir, "ext-removed-dir")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "keep.js"), legacyScript("ext_keep"))
  await fs.writeFile(
    path.join(dir, "old.mjs"),
    `export default { id: "old-mjs", version: "1.0.0", run: async () => ({ output: "ok" }) }`,
  )
  await fs.writeFile(
    path.join(dir, "old.cjs"),
    `module.exports = { id: "old-cjs", version: "1.0.0", run: async () => ({ output: "ok" }) }`,
  )
  const { definitions, errors } = await loadCustomWorkflows([dir], baseDir)
  assert.deepEqual(definitions.map((d) => d.id), ["ext_keep"])
  const joined = errors.join("\n")
  assert.match(joined, /old\.mjs: \.mjs\/\.cjs workflow files were removed in v0\.9\.0/)
  assert.match(joined, /old\.mjs: .*rename to \.js/)
  assert.match(joined, /old\.cjs: \.mjs\/\.cjs workflow files were removed in v0\.9\.0/)
})

test("v0.9.0 移除：显式 .mjs / .cjs 入口同样 fail-loud；未知扩展不装载", async () => {
  const mjs = await writeWorkflow(
    "explicit.mjs",
    `export default { id: "explicit-mjs", version: "1.0.0", run: async () => ({ output: "ok" }) }`,
  )
  const cjs = await writeWorkflow("explicit.cjs", `module.exports = {}`)
  const txt = await writeWorkflow("explicit.txt", `not a workflow`)
  const mjsResult = await loadCustomWorkflows([mjs], baseDir)
  assert.deepEqual(mjsResult.definitions, [])
  assert.match(mjsResult.errors[0] ?? "", /explicit\.mjs: .*removed in v0\.9\.0/)
  const cjsResult = await loadCustomWorkflows([cjs], baseDir)
  assert.match(cjsResult.errors[0] ?? "", /explicit\.cjs: .*removed in v0\.9\.0/)
  const txtResult = await loadCustomWorkflows([txt], baseDir)
  assert.match(txtResult.errors[0] ?? "", /explicit\.txt: not a workflow file \(only \.js loads since v0\.9\.0\)/)
})

test("v0.9.0 移除：defineWorkflow ESM 模块（.js 内）fail-loud 指引改写为 v1 脚本", async () => {
  const file = await writeWorkflow(
    "module-form.js",
    `import { defineWorkflow } from "@mickorz/opencode-agentic-workflow/core"
     export default defineWorkflow({ id: "module-form", version: "1.0.0", stepNames: [], run: async () => ({ output: "ok" }) })`,
  )
  const { definitions, errors } = await loadCustomWorkflows([file], baseDir)
  assert.deepEqual(definitions, [])
  assert.match(errors[0] ?? "", /module-form\.js: defineWorkflow ESM module workflows were removed in v0\.9\.0/)
  assert.match(errors[0] ?? "", /export const meta/)
})

test("v0.9.0 移除：无 meta 的普通 .js 模块 fail-loud 提示缺 export const meta", async () => {
  const file = await writeWorkflow("plain-module.js", `export const nothing = 1`)
  const { definitions, errors } = await loadCustomWorkflows([file], baseDir)
  assert.deepEqual(definitions, [])
  assert.match(errors[0] ?? "", /plain-module\.js: missing `export const meta/)
})

test("v1 脚本装载：reserved id 与重复 id@version 仍按文件级跳过", async () => {
  const dir = path.join(baseDir, "dup-dir")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "a-builtin.js"), legacyScript("smoke"))
  await fs.writeFile(path.join(dir, "b-dup.js"), legacyScript("dup_flow"))
  await fs.writeFile(path.join(dir, "c-dup.js"), legacyScript("dup_flow"))
  const { definitions, errors } = await loadCustomWorkflows([dir], baseDir, ["smoke"])
  assert.deepEqual(definitions.map((d) => d.id), ["dup_flow"])
  const joined = errors.join("\n")
  assert.match(joined, /a-builtin\.js: id "smoke" is reserved/)
  assert.match(joined, /c-dup\.js: duplicate dup_flow@1\.0\.0/)
})

test("空目录报错文案只列 .js；点开头文件不参与扫描", async () => {
  const dir = path.join(baseDir, "empty-dir")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, ".hidden.js"), legacyScript("hidden"))
  const result = await loadCustomWorkflows([dir], baseDir)
  assert.deepEqual(result.definitions, [])
  assert.match(result.errors[0] ?? "", /no workflow files \(\.js\)/)
})

test("legacy 装载后目录无残留临时文件", async () => {
  const dir = path.join(baseDir, "temp-clean-dir")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "uses_temp.js"), legacyScript("uses_temp"))
  const { errors } = await loadCustomWorkflows([dir], baseDir)
  assert.deepEqual(errors, [])
  const names = await fs.readdir(dir)
  assert.deepEqual(names.filter((n) => n.includes(".aw.mjs")), [])
})

test(".json 移除：目录内 .json 给迁移提示且不装载；显式 .json 入口同样提示", async () => {
  const dir = path.join(baseDir, "json-removal-dir")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "legacy.json"), JSON.stringify({ id: "legacy", steps: [] }))
  await fs.writeFile(path.join(dir, "modern.js"), legacyScript("json_dir_modern"))
  const dirResult = await loadCustomWorkflows([dir], baseDir)
  assert.deepEqual(dirResult.definitions.map((d) => d.id), ["json_dir_modern"])
  assert.match(dirResult.errors.join("\n"), /legacy\.json: JSON workflows were removed in v0\.6\.0/)

  const fileResult = await loadCustomWorkflows([path.join(baseDir, "json-removal-dir", "legacy.json")], baseDir)
  assert.deepEqual(fileResult.definitions, [])
  assert.match(fileResult.errors[0] ?? "", /JSON workflows were removed in v0\.6\.0/)
})
