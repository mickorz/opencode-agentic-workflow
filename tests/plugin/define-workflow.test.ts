/**
 * workflow_define 核心单测（v1-parity P0-2：自然语言 → 声明式 JSON 生成链路）
 * 覆盖：校验失败精确指名 / 保留 id 拒绝 / 成功（注册+落盘+读回）/
 *       幂等重定义 / 同版不同内容拒绝（版本契约）/ 版本升级共存取最新 /
 *       无目录配置指引 / 显式 dir 覆盖
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { WorkflowRegistry } from "../../src/registry/registry.js"
import { defineWorkflow } from "../../src/plugin/define-workflow.js"

const RESERVED = ["smoke", "reliable", "artifact", "feature-development"]

/** 最小合法声明（两步：agent + fileExists） */
const valid = {
  id: "compare",
  version: "1.0.0",
  description: "对比分析",
  steps: [
    { name: "draft", agent: "针对 {{topic}} 写对比，禁止调用 workflow / workflow_metrics 工具" },
    { name: "file", fileExists: "compare.md" },
  ],
}

let baseDir: string

test.before(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "agw-define-"))
})

function freshRegistry() {
  return new WorkflowRegistry()
}

test("校验失败：步骤双键被精确指名（复用装载器同一套规则）", async () => {
  const registry = freshRegistry()
  const bad = { ...valid, steps: [{ name: "s", agent: "x", checkpoint: "y" }] }
  const out = await defineWorkflow({ registry, reservedIds: RESERVED, raw: bad, flowsDirs: [baseDir] })
  assert.equal(out.ok, false)
  assert.match(out.message, /must have exactly one of agent\/checkpoint\/verify\/fileExists/)
  // 注册与落盘都不发生（resolve 未命中抛 WorkflowNotFoundError）
  assert.throws(() => registry.resolve("compare"), /not found/)
})

test("保留 id 拒绝：内置流程不可遮蔽", async () => {
  const registry = freshRegistry()
  const out = await defineWorkflow({
    registry, reservedIds: RESERVED, raw: { ...valid, id: "smoke" }, flowsDirs: [baseDir],
  })
  assert.equal(out.ok, false)
  assert.match(out.message, /reserved by a built-in/)
})

test("成功：注册 + 落盘 + 读回一致（含缺省 version 补齐）", async () => {
  const registry = freshRegistry()
  const dir = path.join(baseDir, "flows-a")
  const raw = { ...valid }
  delete (raw as { version?: string }).version
  const out = await defineWorkflow({ registry, reservedIds: RESERVED, raw, flowsDirs: [dir] })
  assert.equal(out.ok, true)
  assert.match(out.message, /defined compare@1\.0\.0 \(draft -> file\)/)
  // 注册可解析
  const def = registry.get("compare")
  assert.deepEqual(def.stepNames, ["draft", "file"])
  // 落盘读回：version 显式化为 1.0.0
  const onDisk = JSON.parse(await readFile(path.join(dir, "compare.json"), "utf8"))
  assert.equal(onDisk.version, "1.0.0")
  assert.deepEqual(onDisk.steps.map((s: { name: string }) => s.name), ["draft", "file"])
})

test("幂等：内容相同的重复 define 成功且不重写文件", async () => {
  const registry = freshRegistry()
  const dir = path.join(baseDir, "flows-b")
  await defineWorkflow({ registry, reservedIds: RESERVED, raw: valid, flowsDirs: [dir] })
  const file = path.join(dir, "compare.json")
  const before = await readFile(file, "utf8")
  const out = await defineWorkflow({ registry, reservedIds: RESERVED, raw: valid, flowsDirs: [dir] })
  assert.equal(out.ok, true)
  assert.match(out.message, /already defined \(identical\)/)
  assert.equal(await readFile(file, "utf8"), before)
})

test("版本契约：同 id@version 不同内容拒绝，提示升 version；升级后共存取最新", async () => {
  const registry = freshRegistry()
  const dir = path.join(baseDir, "flows-c")
  await defineWorkflow({ registry, reservedIds: RESERVED, raw: valid, flowsDirs: [dir] })
  const changed = {
    ...valid,
    steps: [...valid.steps, { name: "gate", checkpoint: "批准 {{topic}}？" }],
  }
  const rejected = await defineWorkflow({
    registry, reservedIds: RESERVED, raw: changed, flowsDirs: [dir],
  })
  assert.equal(rejected.ok, false)
  assert.match(rejected.message, /already registered with DIFFERENT content.*bump "version"/s)
  // 文件未被改写（仍是两步版本）
  const onDisk = JSON.parse(await readFile(path.join(dir, "compare.json"), "utf8"))
  assert.equal(onDisk.steps.length, 2)

  // 升级 1.1.0 → 注册成功，get 取最新
  const upgraded = await defineWorkflow({
    registry, reservedIds: RESERVED, raw: { ...changed, version: "1.1.0" }, flowsDirs: [dir],
  })
  assert.equal(upgraded.ok, true)
  assert.equal(registry.get("compare").version, "1.1.0")
  // 精确版本仍可解析旧版（resume 语义）
  assert.equal(registry.resolve("compare", "1.0.0").version, "1.0.0")
})

test("无目录：flowsDirs 空且未传 dir → 配置指引", async () => {
  const registry = freshRegistry()
  const out = await defineWorkflow({ registry, reservedIds: RESERVED, raw: valid, flowsDirs: [] })
  assert.equal(out.ok, false)
  assert.match(out.message, /no flows directory configured.*workflows/s)
})

test("显式 dir 覆盖 + 目录自动创建（深层路径）", async () => {
  const registry = freshRegistry()
  const dir = path.join(baseDir, "custom", "deep", "flows")
  const out = await defineWorkflow({
    registry, reservedIds: RESERVED, raw: valid, flowsDirs: [], dir,
  })
  assert.equal(out.ok, true)
  const onDisk = JSON.parse(await readFile(path.join(dir, "compare.json"), "utf8"))
  assert.equal(onDisk.id, "compare")
})

test("落盘失败 fail-loud：写目标被同名目录占位 → 明确后果与修法", async () => {
  const registry = freshRegistry()
  const dir = path.join(baseDir, "blocked-flows")
  // 占位：<dir>/occupied.json 本身是目录 → writeFile 报 EISDIR
  await mkdir(path.join(dir, "occupied.json"), { recursive: true })
  const out = await defineWorkflow({
    registry, reservedIds: RESERVED, raw: { ...valid, id: "occupied" }, flowsDirs: [dir],
  })
  assert.equal(out.ok, false)
  assert.match(out.message, /registered.*THIS session.*persisting.*failed/s)
  assert.match(out.message, /fix the directory.*bumped version/s)
  // 会话内确实已注册（fail 消息如实陈述了这一点）
  assert.equal(registry.get("occupied").stepNames.length, 2)
})
