/**
 * GitWorktreeProvider 集成测试（P2.7）—— 真实 git（临时仓库，无网络）
 * 覆盖：create（默认路径/分支/身份、baseRef）、dispose（含脏 worktree force、幂等、保留分支）、
 *       attach（复用、缺失抛错、provider 不匹配）
 */

import assert from "node:assert/strict"
import { execFile as execFileCb } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { test } from "node:test"

import { GitWorktreeProvider } from "../../src/workspace/git-worktree.js"

const exec = promisify(execFileCb)

/** 独立提交（不依赖全局 git config） */
async function commit(repoRoot: string, message: string): Promise<void> {
  await exec(
    "git",
    ["-c", "user.email=agw@test", "-c", "user.name=agw", "commit", "--allow-empty", "-m", message],
    { cwd: repoRoot },
  )
}

async function gitOut(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd })
  return stdout.trim()
}

let baseDir: string

test.before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-worktree-"))
})

/** 每个 case 一个独立仓库（含初始提交——worktree add 依赖 HEAD）+ 显式 worktree 父目录 */
async function makeRepo(name: string): Promise<{ repoRoot: string; dir: string }> {
  const repoRoot = await fs.mkdtemp(path.join(baseDir, `${name}-repo-`))
  await exec("git", ["init", "-b", "main"], { cwd: repoRoot })
  await commit(repoRoot, "init")
  const dir = await fs.mkdtemp(path.join(baseDir, `${name}-wt-`))
  return { repoRoot, dir }
}

test("create：默认分支 agw/<runId>，目录在仓库同级 <项目名>-worktrees 下，身份完整", async () => {
  const { repoRoot } = await makeRepo("default")
  const provider = new GitWorktreeProvider({ startDir: repoRoot })

  const handle = await provider.create("run-x")
  assert.equal(handle.root, handle.identity.path)
  assert.equal(handle.identity.provider, "git-worktree")
  assert.equal(handle.identity.branch, "agw/run-x")

  // 默认目录：<repo 同级>/<项目名>-worktrees/<runId>（macOS 需按真实路径比较）
  const resolvedRepo = await fs.realpath(repoRoot)
  const expected = path.join(
    path.dirname(resolvedRepo),
    `${path.basename(resolvedRepo)}-worktrees`,
    "run-x",
  )
  assert.equal(handle.identity.path, expected)

  // 是 git work tree + 分支存在
  assert.equal(await gitOut(["rev-parse", "--is-inside-work-tree"], handle.root), "true")
  assert.equal(await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], handle.root), "agw/run-x")
  const branches = await gitOut(["branch", "--list", "agw/run-x"], repoRoot)
  assert.match(branches, /agw\/run-x/)
})

test("create：baseRef 生效（worktree 检出指定 ref 而非 HEAD）", async () => {
  const { repoRoot, dir } = await makeRepo("baseref")
  const firstSha = await gitOut(["rev-parse", "HEAD"], repoRoot)
  await commit(repoRoot, "second")

  const provider = new GitWorktreeProvider({ startDir: repoRoot, dir })
  const handle = await provider.create("run-ref", { baseRef: firstSha })

  assert.equal(await gitOut(["rev-parse", "HEAD"], handle.root), firstSha)
  assert.equal(handle.identity.baseRef, firstSha)
})

test("create：dir 覆盖 + 自定义 branch/path", async () => {
  const { repoRoot, dir } = await makeRepo("custom")
  const provider = new GitWorktreeProvider({ startDir: repoRoot, dir })
  const custom = path.join(dir, "custom-root")
  const handle = await provider.create("run-c", { branch: "feature/x", path: custom })

  assert.equal(handle.identity.path, custom)
  assert.equal(handle.identity.branch, "feature/x")
  assert.equal(await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], custom), "feature/x")
})

test("dispose：移除 worktree（幂等）；分支保留（不删 ref）", async () => {
  const { repoRoot, dir } = await makeRepo("dispose")
  const provider = new GitWorktreeProvider({ startDir: repoRoot, dir })
  const handle = await provider.create("run-d")

  await handle.dispose()
  await assert.rejects(fs.stat(handle.root))
  // 分支仍在（删除分支是破坏性操作，v1 明确不删）
  assert.match(await gitOut(["branch", "--list", "agw/run-d"], repoRoot), /agw\/run-d/)

  // 幂等：再次 dispose 不抛错
  await handle.dispose()
})

test("dispose：脏 worktree 普通移除被拒，force 成功", async () => {
  const { repoRoot, dir } = await makeRepo("dirty")
  const provider = new GitWorktreeProvider({ startDir: repoRoot, dir })
  const handle = await provider.create("run-dirty")
  await fs.writeFile(path.join(handle.root, "uncommitted.txt"), "dirty")

  // 普通 remove：git 拒绝含未提交变更的 worktree
  await assert.rejects(handle.dispose())
  await fs.stat(handle.root) // 仍在

  // force：丢弃未提交变更并移除
  await handle.dispose({ force: true })
  await assert.rejects(fs.stat(handle.root))
})

test("attach：复用已有 worktree（root/identity 不变）", async () => {
  const { repoRoot, dir } = await makeRepo("attach")
  const provider = new GitWorktreeProvider({ startDir: repoRoot, dir })
  const created = await provider.create("run-att")
  await fs.writeFile(path.join(created.root, "evidence.txt"), "kept")

  const reattached = await provider.attach(created.identity)
  assert.equal(reattached.root, created.identity.path)
  assert.deepEqual(reattached.identity, created.identity)
  // 文件系统状态原样保留（durable resume 的前提）
  assert.equal(await fs.readFile(path.join(reattached.root, "evidence.txt"), "utf8"), "kept")
})

test("attach：workspace 缺失必须抛错——绝不静默重建", async () => {
  const { repoRoot, dir } = await makeRepo("missing")
  const provider = new GitWorktreeProvider({ startDir: repoRoot, dir })

  await assert.rejects(
    () =>
      provider.attach({
        provider: "git-worktree",
        path: path.join(dir, "never-created"),
        branch: "agw/never",
      }),
    /workspace missing/,
  )
})

test("attach：provider 不匹配抛错", async () => {
  const { repoRoot, dir } = await makeRepo("mismatch")
  const provider = new GitWorktreeProvider({ startDir: repoRoot, dir })
  const created = await provider.create("run-mm")

  await assert.rejects(
    () => provider.attach({ ...created.identity, provider: "docker" }),
    /provider mismatch/,
  )
})

test("dispose：跨仓库上下文仍可移除（resume 场景：startDir 是另一个仓库）", async () => {
  const repoA = await makeRepo("xrepo-a")
  const repoB = await makeRepo("xrepo-b")
  const providerA = new GitWorktreeProvider({ startDir: repoA.repoRoot, dir: repoA.dir })
  const handle = await providerA.create("run-x")

  // H2 场景：另一个 startDir（不同仓库）构造的 provider 负责清理
  const providerB = new GitWorktreeProvider({ startDir: repoB.repoRoot, dir: repoB.dir })
  const attached = await providerB.attach(handle.identity)
  await attached.dispose({ force: true })
  await assert.rejects(fs.stat(handle.root))
})

test("startDir 在仓库子目录时：自动解析到仓库根", async () => {
  const { repoRoot, dir } = await makeRepo("subdir")
  const sub = path.join(repoRoot, "nested", "deep")
  await fs.mkdir(sub, { recursive: true })

  const provider = new GitWorktreeProvider({ startDir: sub, dir })
  const handle = await provider.create("run-sub")
  assert.equal(await gitOut(["rev-parse", "--is-inside-work-tree"], handle.root), "true")
})
