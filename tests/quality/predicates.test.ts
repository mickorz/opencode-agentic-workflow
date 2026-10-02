/**
 * 内建谓词单元测试 —— 真实命令执行 + 超时 + 可注入 CommandRunner
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  NodeCommandRunner,
  setCommandRunner,
  type CommandResult,
} from "../../src/runtime/command.js"
import {
  commandSuccess,
  fileExists,
  isDirectory,
  isFile,
} from "../../src/quality/predicates.js"

test.afterEach(() => {
  setCommandRunner(new NodeCommandRunner())
})

test("commandSuccess: exit 0 -> true, exit 1 -> false", async () => {
  assert.equal(await commandSuccess("true"), true)
  assert.equal(await commandSuccess("exit 1"), false)
})

test("commandSuccess: unknown command -> false (no throw)", async () => {
  assert.equal(await commandSuccess("definitely-not-a-command-xyz --version"), false)
})

test("commandSuccess: timeout kills process and returns false", async () => {
  // 3 秒的 sleep，150ms 超时：必须被击杀且判定失败（经验：禁止无限等待）
  const ok = await commandSuccess("sleep 3", { timeoutMs: 150 })
  assert.equal(ok, false)
})

test("NodeCommandRunner: result carries code/stdout/timedOut", async () => {
  const runner = new NodeCommandRunner()
  const okResult = await runner.run("echo hello")
  assert.equal(okResult.code, 0)
  assert.match(okResult.stdout, /hello/)
  assert.equal(okResult.timedOut, false)

  const timeoutResult = await runner.run("sleep 3", { timeoutMs: 120 })
  assert.equal(timeoutResult.timedOut, true)
})

test("commandSuccess: uses injected CommandRunner (test double)", async () => {
  const recorded: string[] = []
  setCommandRunner({
    async run(command): Promise<CommandResult> {
      recorded.push(command)
      return { command, code: 0, stdout: "", stderr: "", timedOut: false }
    },
  })
  assert.equal(await commandSuccess("anything"), true)
  assert.deepEqual(recorded, ["anything"])
})

test("fileExists / isFile / isDirectory", async () => {
  assert.equal(await fileExists("package.json"), true)
  assert.equal(await fileExists("no-such-file.xyz"), false)
  assert.equal(await isFile("package.json"), true)
  assert.equal(await isFile("src"), false)
  assert.equal(await isDirectory("src"), true)
  assert.equal(await isDirectory("package.json"), false)
})
