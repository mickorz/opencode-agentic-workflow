/**
 * InPlaceWorkspaceProvider 单测（P3 Blocker 修复：无隔离 workspaceRoot 兜底）
 * 覆盖：create 解析项目目录、dispose 永不删项目文件、attach 复用/缺失抛错/异构拒绝
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { InPlaceWorkspaceProvider } from "../../src/workspace/in-place.js"

test("in-place: create 解析到项目目录，身份记录 provider/path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-inplace-"))
  try {
    const provider = new InPlaceWorkspaceProvider({ startDir: dir })
    const handle = await provider.create("run_x")
    assert.equal(handle.root, path.resolve(dir))
    assert.equal(handle.identity.provider, "in-place")
    assert.equal(handle.identity.path, path.resolve(dir))
    assert.equal(handle.identity.branch, undefined)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("in-place: dispose 是 no-op——force 清理后项目文件必须原样保留", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-inplace-"))
  try {
    const sentinel = path.join(dir, "important.txt")
    await fs.writeFile(sentinel, "user data")
    const provider = new InPlaceWorkspaceProvider({ startDir: dir })
    const handle = await provider.create()
    await handle.dispose({ force: true })
    await handle.dispose({ force: true }) // 幂等
    assert.equal(await fs.readFile(sentinel, "utf8"), "user data")
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("in-place: attach 回到原目录；目录消失必须抛错（绝不静默重建）", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-inplace-"))
  const provider = new InPlaceWorkspaceProvider({ startDir: dir })
  const handle = await provider.create()
  const attached = await provider.attach(handle.identity)
  assert.equal(attached.root, handle.root)

  await fs.rm(dir, { recursive: true, force: true })
  await assert.rejects(() => provider.attach(handle.identity), /no longer exists/)
})

test("in-place: attach 拒绝异构 provider 身份", async () => {
  const provider = new InPlaceWorkspaceProvider({ startDir: process.cwd() })
  await assert.rejects(
    () => provider.attach({ provider: "git-worktree", path: "/tmp" }),
    /cannot attach/,
  )
})
