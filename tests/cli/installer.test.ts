/**
 * P2-10 Installer CLI 测试
 *
 * 覆盖两层：
 * 1. config 层纯函数（JSONC 合并/移除/条目匹配/空壳/检测/版本）
 * 2. 无头全链（flags 齐备 + --yes 零交互）：install --project → doctor →
 *    uninstall，断言配置、.bak、skills 拷贝与对称清理
 *
 * locked 模式含 npm install（网络副作用），不在单测覆盖——由仓库外的
 * 打包验收（npm pack → tarball 安装 → bin 可跑）兜底。
 */

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  DEFAULT_JOURNAL_DIR,
  PKG_NAME,
  PKG_IN_NODE_MODULES,
  PLUGIN_LOCAL_SPEC,
  SKILLS_LOCAL_SPEC,
  detectInstalled,
  isPluginEntry,
  isShellConfig,
  isSkillPathEntry,
  makePluginEntry,
  mergePluginEntry,
  mergeSkillsEntry,
  parseModelRef,
  projectOpenCodeJsonPath,
  projectPackageDir,
  readInstalledVersion,
  removePluginEntries,
  removeConfigWithBackup,
  skillTargetExists,
  skillTargets,
} from "../../src/cli/config.js"
import { runInstall } from "../../src/cli/install.js"
import { runUninstall } from "../../src/cli/uninstall.js"

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "agw-cli-"))
}

// ---------------------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------------------

test("parseModelRef：合法引用解析；非法返回 null", () => {
  assert.deepEqual(parseModelRef("glm/glm-5.3-flash"), { providerID: "glm", id: "glm-5.3-flash" })
  assert.deepEqual(parseModelRef(" openai/gpt-5.3 "), { providerID: "openai", id: "gpt-5.3" })
  assert.equal(parseModelRef("no-slash"), null)
  assert.equal(parseModelRef("a/b/c"), null)
  assert.equal(parseModelRef(""), null)
})

test("isPluginEntry：包名 / 本地路径 / 反斜杠变体匹配；无关对象不匹配", () => {
  assert.equal(isPluginEntry({ package: PKG_NAME }), true)
  assert.equal(isPluginEntry({ package: PLUGIN_LOCAL_SPEC }), true)
  assert.equal(isPluginEntry({ package: `C:\\proj\\${PKG_IN_NODE_MODULES}\\dist\\plugin` }), true)
  assert.equal(isPluginEntry({ package: "other/plugin" }), false)
  assert.equal(isPluginEntry({ package: 3 }), false)
  assert.equal(isPluginEntry("plain-string"), false)
  assert.equal(isPluginEntry(null), false)
})

test("isSkillPathEntry：零拷贝 skills 路径结尾匹配", () => {
  assert.equal(isSkillPathEntry(SKILLS_LOCAL_SPEC), true)
  assert.equal(isSkillPathEntry(`./${SKILLS_LOCAL_SPEC}`), true)
  assert.equal(isSkillPathEntry(`x\\${SKILLS_LOCAL_SPEC}`), true)
  assert.equal(isSkillPathEntry("node_modules/other/skills"), false)
  assert.equal(isSkillPathEntry(42), false)
})

test("makePluginEntry：locked 用本地路径；journalDir 可省；其余透传", () => {
  const opts = { model: { providerID: "glm", id: "glm-5.3-flash" }, agent: "build" }
  const global = makePluginEntry(opts, false)
  assert.equal(global.package, PKG_NAME)
  assert.deepEqual(global.options, { model: opts.model, agent: "build" })

  const journaled = makePluginEntry({ ...opts, journalDir: DEFAULT_JOURNAL_DIR }, true)
  assert.equal(journaled.package, PLUGIN_LOCAL_SPEC)
  assert.equal((journaled.options as Record<string, unknown>).journalDir, DEFAULT_JOURNAL_DIR)
})

test("mergePluginEntry：新建骨架 + 幂等 + 保留用户注释", () => {
  const dir = tmp()
  const file = path.join(dir, "opencode.json")

  // 新建：写入带 $schema 的骨架 + 条目
  const entry = makePluginEntry({ model: { providerID: "glm", id: "x" }, agent: "build" }, false)
  assert.equal(mergePluginEntry(file, entry), true)
  const afterFirst = readFileSync(file, "utf8")
  assert.match(afterFirst, /\$schema/)
  assert.match(afterFirst, new RegExp(PKG_NAME.replaceAll("/", "\\/")))
  assert.ok(existsSync(`${file}.bak`))

  // 幂等：同插件条目已存在 → 不改（.bak 不刷新）
  const bakMtime = statSync(`${file}.bak`).mtimeMs
  assert.equal(mergePluginEntry(file, entry), false)
  assert.equal(statSync(`${file}.bak`).mtimeMs, bakMtime)

  // 保留注释：带注释的用户配置合并后注释仍在
  const commented = path.join(dir, "commented.json")
  writeFileSync(commented, `{\n  // 我的注释\n  "plugins": []\n}\n`, "utf8")
  assert.equal(mergePluginEntry(commented, entry), true)
  assert.match(readFileSync(commented, "utf8"), /我的注释/)
})

test("mergeSkillsEntry：零拷贝路径写入 + 幂等", () => {
  const dir = tmp()
  const file = path.join(dir, "opencode.json")
  writeFileSync(file, `{\n  "skills": ["my-own-skill"]\n}\n`, "utf8")

  assert.equal(mergeSkillsEntry(file, SKILLS_LOCAL_SPEC), true)
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { skills: string[] }
  assert.deepEqual(parsed.skills, ["my-own-skill", SKILLS_LOCAL_SPEC])
  assert.equal(mergeSkillsEntry(file, SKILLS_LOCAL_SPEC), false)
})

test("removePluginEntries：条目与零拷贝 skills 移除；清空数组连键删", () => {
  const dir = tmp()
  const file = path.join(dir, "opencode.json")
  const entry = makePluginEntry({ model: { providerID: "a", id: "b" }, agent: "build" }, true)
  mergePluginEntry(file, entry)
  mergeSkillsEntry(file, SKILLS_LOCAL_SPEC)

  assert.equal(removePluginEntries(file), true)
  const after = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  assert.equal("plugins" in after, false) // 空数组连键删
  assert.equal("skills" in after, false)
  // 幂等
  assert.equal(removePluginEntries(file), false)
})

test("isShellConfig：只剩 $schema 判空壳；有其他内容不判", () => {
  const dir = tmp()
  const shell = path.join(dir, "shell.json")
  writeFileSync(shell, `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`, "utf8")
  assert.equal(isShellConfig(shell), true)

  const real = path.join(dir, "real.json")
  writeFileSync(real, `{\n  "$schema": "x",\n  "theme": "dark"\n}\n`, "utf8")
  assert.equal(isShellConfig(real), false)
})

test("detectInstalled：global / project / locked 判别（注入 globalDir）", () => {
  const cwd = tmp()
  const globalDir = tmp()
  mkdirSync(globalDir, { recursive: true })
  const globalJson = path.join(globalDir, "opencode.json")
  const projectJson = projectOpenCodeJsonPath(cwd)

  // 初始：什么都没有
  assert.deepEqual(detectInstalled(cwd, globalDir), [])

  // 全局条目 → global
  mergePluginEntry(globalJson, makePluginEntry({ model: { providerID: "a", id: "b" }, agent: "build" }, false))
  assert.deepEqual(detectInstalled(cwd, globalDir).map((d) => d.kind), ["global"])

  // 项目条目（包名形式）→ project；locked 路径形式 → locked
  mergePluginEntry(projectJson, makePluginEntry({ model: { providerID: "a", id: "b" }, agent: "build" }, false))
  assert.deepEqual(detectInstalled(cwd, globalDir).map((d) => d.kind), ["global", "project"])

  removePluginEntries(projectJson)
  removeConfigWithBackup(projectJson)
  mergePluginEntry(projectJson, makePluginEntry({ model: { providerID: "a", id: "b" }, agent: "build" }, true))
  assert.deepEqual(detectInstalled(cwd, globalDir).map((d) => d.kind), ["global", "locked"])

  // node_modules 存在也算 locked 证据
  removePluginEntries(projectJson)
  removeConfigWithBackup(projectJson)
  mkdirSync(projectPackageDir(cwd), { recursive: true })
  assert.deepEqual(detectInstalled(cwd, globalDir).map((d) => d.kind), ["global", "locked"])
})

test("readInstalledVersion：项目 node_modules 的 package.json 优先", () => {
  const cwd = tmp()
  assert.equal(readInstalledVersion(cwd), null)
  const pkgDir = projectPackageDir(cwd)
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version: "9.9.9" }), "utf8")
  assert.equal(readInstalledVersion(cwd), "9.9.9")
})

// ---------------------------------------------------------------------------
// 无头全链：install --project → uninstall（零交互，flags 齐备）
// ---------------------------------------------------------------------------

test("无头 install/uninstall 全链（project 模式）", async () => {
  const cwd = tmp()
  const prevCwd = process.cwd()
  process.chdir(cwd)
  try {
    const configPath = projectOpenCodeJsonPath(cwd)

    // 安装（无头：flags 齐备 + --yes，零交互）
    await runInstall({ mode: "project", model: "glm/glm-5.3-flash", yes: true })

    // 配置断言：条目 + options（model/agent/journalDir）
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      plugins?: Array<{ package: string; options: Record<string, unknown> }>
    }
    const entry = cfg.plugins?.find((e) => e.package === PKG_NAME)
    assert.ok(entry, "plugins 条目缺失")
    assert.deepEqual(entry!.options.model, { providerID: "glm", id: "glm-5.3-flash" })
    assert.equal(entry!.options.agent, "build")
    assert.equal(entry!.options.journalDir, DEFAULT_JOURNAL_DIR)
    // 骨架备份在
    assert.ok(existsSync(`${configPath}.bak`))
    // skills 拷贝到 .opencode/skills（原生扫描目录）
    for (const target of skillTargets(cwd, "project")) {
      assert.ok(skillTargetExists(target), `skill 未拷贝：${target.destDir}`)
    }

    // 幂等重装：无配置变化（.bak 不刷新）
    const bakBefore = statSync(`${configPath}.bak`).mtimeMs
    await runInstall({ mode: "project", model: "glm/glm-5.3-flash", yes: true })
    assert.equal(statSync(`${configPath}.bak`).mtimeMs, bakBefore)

    // 卸载（无头：kinds + --yes）
    await runUninstall({ kinds: ["project"], yes: true })

    // 对称清理：配置是安装器从零建的 → 空壳 → 整文件删除（含 .bak）
    assert.equal(existsSync(configPath), false)
    assert.equal(existsSync(`${configPath}.bak`), false)
    // 拷贝的 skill 目录含用户数据：无头不自动删（留在手动清理清单）
    for (const target of skillTargets(cwd, "project")) {
      assert.ok(skillTargetExists(target), "无头卸载不应自动删 skill 目录")
    }
    // 重复卸载：无痕可卸，正常收场
    await runUninstall({ kinds: ["project"], yes: true })
  } finally {
    process.chdir(prevCwd)
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("无头 install 缺必答项：报错列出缺项（不挂起）", async () => {
  const cwd = tmp()
  const prevCwd = process.cwd()
  process.chdir(cwd)
  try {
    await assert.rejects(
      runInstall({ yes: true }), // 无 mode 无 model
      /缺少必答项/,
    )
    await assert.rejects(
      runInstall({ mode: "project", yes: true }), // 缺 model
      /--model/,
    )
  } finally {
    process.chdir(prevCwd)
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("无头 uninstall 未安装：正常收场不报错", async () => {
  const cwd = tmp()
  const prevCwd = process.cwd()
  process.chdir(cwd)
  try {
    await runUninstall({ kinds: ["project"], yes: true })
  } finally {
    process.chdir(prevCwd)
    rmSync(cwd, { recursive: true, force: true })
  }
})
