/**
 * 自定义流程增量装载注册测试（v0.6.1）
 * 覆盖：init 全量注册、幂等重扫（已注册跳过）、新文件增量拾取、
 * 同 id 升 version 注册新版本（latest 切换）、坏文件/保留 id 错误收集
 * 不阻断、空入口 no-op
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { WorkflowRegistry } from "../../src/registry/registry.js"
import { refreshCustomWorkflows, formatUnknownFlowMessage } from "../../src/plugin/custom-flows.js"

let baseDir: string
let flowsDir: string
let registry: WorkflowRegistry

test.before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-refresh-"))
  flowsDir = path.join(baseDir, "flows")
  await fs.mkdir(flowsDir, { recursive: true })
})

test.beforeEach(async () => {
  registry = new WorkflowRegistry()
  // 每测独立场景：清空共享 flows 目录（registry 也已重置）
  await fs.rm(flowsDir, { recursive: true, force: true })
  await fs.mkdir(flowsDir, { recursive: true })
})

async function writeFlow(name: string, id: string, version = "1.0.0"): Promise<void> {
  await fs.writeFile(
    path.join(flowsDir, name),
    `export default { id: "${id}", version: "${version}", stepNames: ["a"], run: async () => ({ output: "ok" }) }`,
  )
}

function refresh() {
  return refreshCustomWorkflows({
    registry,
    entries: ["flows"],
    baseDir,
    reservedIds: ["smoke", "reliable", "artifact", "feature-development"],
  })
}

test("init 全量：新文件注册，registry 可解析", async () => {
  await writeFlow("alpha.mjs", "alpha")
  const result = await refresh()
  assert.deepEqual(result.registered.map((r) => `${r.id}@${r.version}`), ["alpha@1.0.0"])
  assert.deepEqual(result.errors, [])
  assert.equal(registry.get("alpha")?.version, "1.0.0")
})

test("幂等：再次重扫已注册的同 id@version 跳过（非错误）", async () => {
  await writeFlow("alpha.mjs", "alpha")
  await refresh()
  const again = await refresh()
  assert.deepEqual(again.registered, [])
  assert.deepEqual(again.errors, [])
})

test("增量：重扫拾取新写的文件（不重启场景）", async () => {
  await writeFlow("alpha.mjs", "alpha")
  await refresh()
  await writeFlow("beta.mjs", "beta")
  const result = await refresh()
  assert.deepEqual(result.registered.map((r) => r.id), ["beta"])
  assert.equal(registry.get("beta")?.id, "beta")
  assert.equal(registry.get("alpha")?.id, "alpha")
})

test("升 version：新文件同 id 高版本注册，latest 切换（旧版本共存）", async () => {
  await writeFlow("alpha.mjs", "alpha", "1.0.0")
  await refresh()
  await writeFlow("alpha-v2.mjs", "alpha", "2.0.0")
  const result = await refresh()
  assert.deepEqual(result.registered.map((r) => `${r.id}@${r.version}`), ["alpha@2.0.0"])
  assert.equal(registry.get("alpha")?.version, "2.0.0")
  assert.equal(registry.get("alpha", "1.0.0")?.version, "1.0.0")
})

test("错误收集不阻断：坏文件 + 保留 id 各自报错，好文件照常注册", async () => {
  await fs.writeFile(path.join(flowsDir, "broken.mjs"), `export default { id: "broken" `)
  await writeFlow("reserved.mjs", "smoke")
  await writeFlow("good.mjs", "good")
  const result = await refresh()
  assert.deepEqual(result.registered.map((r) => r.id), ["good"])
  const joined = result.errors.join("\n")
  assert.match(joined, /broken\.mjs: failed to import/)
  assert.match(joined, /reserved\.mjs: id "smoke" is reserved/)
})

test("空入口：no-op 返回空结果", async () => {
  const result = await refreshCustomWorkflows({
    registry,
    entries: [],
    baseDir,
    reservedIds: [],
  })
  assert.deepEqual(result.registered, [])
  assert.deepEqual(result.errors, [])
})

test("未知 id 报错文案：带插件版本 + 进程冻结重启提示（v0.6.4）", () => {
  const message = formatUnknownFlowMessage({
    workflowId: "wordfreq-mnemonic",
    availableIds: ["smoke", "calc"],
    pluginVersion: "0.6.3",
  })
  assert.match(message, /workflow not found: wordfreq-mnemonic/)
  assert.match(message, /available: smoke, calc/)
  assert.match(message, /plugin v0\.6\.3/)
  assert.match(message, /a new chat does not reload plugins/)
  // 无错误时不出现 load errors 段
  assert.doesNotMatch(message, /flows load errors/)
})

test("未知 id 报错文案：装载错误只附前 3 条", () => {
  const message = formatUnknownFlowMessage({
    workflowId: "x",
    availableIds: ["smoke"],
    errors: ["e1", "e2", "e3", "e4", "e5"],
    pluginVersion: "unknown",
  })
  assert.match(message, /- e1\n- e2\n- e3/)
  assert.doesNotMatch(message, /- e4/)
  assert.match(message, /plugin vunknown/)
})
