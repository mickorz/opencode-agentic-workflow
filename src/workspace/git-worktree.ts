/**
 * GitWorktreeProvider（P2.7）—— WorkspaceProvider 的 git worktree 实现
 *
 *   git -C <repo> worktree add -b agw/<runId> <dir>/<runId> [<baseRef>]
 *
 * - worktree 目录默认放在仓库**同级**目录（<项目名>-worktrees/<runId>），
 *   不污染仓库本身（无需 .gitignore）；
 * - dispose 只移除 worktree（+prune），**不删分支**——分支是廉价 ref，
 *   删除是破坏性操作，留给用户（git branch --list 'agw/*' 可批量清理）；
 * - attach 严格校验存在性，缺失即抛错（durable resume 纪律）。
 */

import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

import type {
  WorkspaceHandle,
  WorkspaceIdentity,
  WorkspaceOptions,
  WorkspaceProvider,
} from "./provider.js"

const exec = promisify(execFile)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd })
  return stdout.trim()
}

export interface GitWorktreeProviderOptions {
  /** 起点目录（自动解析到 git 仓库根；通常是项目目录） */
  startDir: string
  /** worktree 父目录；缺省 <repo 同级>/<项目名>-worktrees */
  dir?: string
}

export class GitWorktreeProvider implements WorkspaceProvider {
  readonly kind = "git-worktree"
  private readonly startDir: string
  private readonly dirOverride?: string
  private cache?: { repoRoot: string; dir: string }

  constructor(options: GitWorktreeProviderOptions) {
    this.startDir = options.startDir
    this.dirOverride = options.dir
  }

  private async resolvePaths(): Promise<{ repoRoot: string; dir: string }> {
    if (this.cache) return this.cache
    const repoRoot = await git(["rev-parse", "--show-toplevel"], this.startDir)
    const dir =
      this.dirOverride ??
      path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-worktrees`)
    this.cache = { repoRoot, dir }
    return this.cache
  }

  async create(runId: string, options: WorkspaceOptions = {}): Promise<WorkspaceHandle> {
    const { repoRoot, dir } = await this.resolvePaths()
    const branch = options.branch ?? `agw/${runId}`
    const root = options.path ?? path.join(dir, runId)
    await fs.mkdir(path.dirname(root), { recursive: true })
    const args = ["worktree", "add", "-b", branch, root]
    if (options.baseRef) args.push(options.baseRef)
    await git(args, repoRoot)
    const identity: WorkspaceIdentity = {
      provider: this.kind,
      path: root,
      branch,
      baseRef: options.baseRef,
    }
    return {
      root,
      identity,
      dispose: (disposeOptions) => this.removeWorktree(root, disposeOptions),
    }
  }

  async attach(identity: WorkspaceIdentity): Promise<WorkspaceHandle> {
    if (identity.provider !== this.kind) {
      throw new Error(
        `[agentic-workflow] workspace provider mismatch: ${identity.provider} != ${this.kind}`,
      )
    }
    const stat = await fs.stat(identity.path).catch(() => undefined)
    if (!stat?.isDirectory()) {
      throw new Error(
        `[agentic-workflow] workspace missing: ${identity.path} ` +
          `(durable resume requires the original worktree; it may have been cleaned up — ` +
          `re-run from scratch if the work product is recoverable)`,
      )
    }
    const inside = await git(["rev-parse", "--is-inside-work-tree"], identity.path)
    if (inside !== "true") {
      throw new Error(`[agentic-workflow] not a git worktree: ${identity.path}`)
    }
    return {
      root: identity.path,
      identity,
      dispose: (disposeOptions) => this.removeWorktree(identity.path, disposeOptions),
    }
  }

  private async removeWorktree(
    root: string,
    options?: { force?: boolean },
  ): Promise<void> {
    // 从 worktree 自身解析主仓库根：跨目录/跨服务 resume 时，provider 的
    // startDir 可能已不是该 worktree 所属仓库（journal 里的 path 才是事实源）
    let repoRoot: string
    try {
      const commonDir = await git(["rev-parse", "--git-common-dir"], root)
      repoRoot = path.dirname(path.resolve(root, commonDir))
    } catch {
      // worktree 目录已不存在：视为已清理（幂等）
      return
    }
    const args = ["worktree", "remove"]
    if (options?.force) args.push("--force")
    args.push(root)
    try {
      await git(args, repoRoot)
    } catch (error) {
      // 幂等：目录已不存在视为成功
      const gone = !(await fs.stat(root).catch(() => undefined))
      if (!gone) throw error
    } finally {
      await git(["worktree", "prune"], repoRoot).catch(() => {})
    }
  }
}
