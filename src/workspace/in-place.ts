/**
 * InPlaceWorkspaceProvider —— 无隔离模式的默认工作区（P3 Blocker 修复）
 *
 * 背景：workspaceRoot 之前只在配置 git-worktree 隔离时才存在；无隔离时
 * 流程落到 process.cwd()——在 OpenCode 托管进程里 cwd **不是**项目目录
 * （长驻 server 场景实测为 HOME），导致 artifact/reliable 等以
 * 「workspace 根」为前提的流程假失败（文件写对位置、check 查错位置）。
 *
 * 语义：
 *   - create()：root = 项目目录（原地，不创建任何东西）
 *   - dispose()：必须 no-op——原地工作区就是用户的项目目录，绝不能删
 *   - attach()：resume 时回到 journal 记录的原目录；目录消失必须抛错
 *     （绝不静默重建，与 worktree 纪律一致）
 */

import { existsSync } from "node:fs"
import path from "node:path"
import type {
  WorkspaceHandle,
  WorkspaceIdentity,
  WorkspaceProvider,
} from "./provider.js"

export interface InPlaceWorkspaceProviderOptions {
  /** 项目目录（workspaceRoot 解析到这里） */
  startDir: string
}

export class InPlaceWorkspaceProvider implements WorkspaceProvider {
  readonly kind = "in-place"

  private readonly startDir: string

  constructor(options: InPlaceWorkspaceProviderOptions) {
    this.startDir = options.startDir
  }

  async create(): Promise<WorkspaceHandle> {
    const root = path.resolve(this.startDir)
    return {
      root,
      identity: { provider: this.kind, path: root },
      dispose: async () => {
        // 原地工作区 = 用户项目目录本身：清理永远是 no-op
      },
    }
  }

  async attach(identity: WorkspaceIdentity): Promise<WorkspaceHandle> {
    if (identity.provider !== this.kind) {
      throw new Error(
        `in-place provider cannot attach a "${identity.provider}" workspace`,
      )
    }
    if (!existsSync(identity.path)) {
      throw new Error(
        `in-place workspace no longer exists: ${identity.path} ` +
          "(resume requires the original project directory)",
      )
    }
    return {
      root: identity.path,
      identity,
      dispose: async () => {},
    }
  }
}
