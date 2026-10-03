/**
 * Workspace 抽象（P2.7）—— Workflow 的文件系统隔离边界
 *
 * Core 不知道 Git、也不知道 OpenCode：只依赖本抽象。
 * GitWorktreeProvider 是其中一个实现（经 child_process 执行 git，
 * 同样零 OpenCode 依赖）；未来可有 DockerWorkspaceProvider 等。
 *
 * 关键纪律：
 *   - worktree 属于 runtime infrastructure，不是业务 workflow 原语——
 *     workflow 定义只看到 ctx.workspaceRoot，绝不自己执行 git 命令。
 *   - resume 必须重新附着 journal 记录的**原** workspace（绝不静默重建）：
 *     durable resume = journal 状态 + 文件系统状态 同时恢复。
 */

/** 持久化到 journal 的 workspace 身份（resume attach 的依据） */
export interface WorkspaceIdentity {
  /** 提供者类型（如 "git-worktree"） */
  provider: string
  /** 工作区根目录（绝对路径） */
  path: string
  /** 分支名（git-worktree） */
  branch?: string
  /** 创建时的基准 ref */
  baseRef?: string
}

export interface WorkspaceOptions {
  /** 基准 ref（缺省 = 仓库当前 HEAD） */
  baseRef?: string
  /** 分支名（缺省 agw/<runId>） */
  branch?: string
  /** 工作区路径（缺省由 provider 决定） */
  path?: string
}

export interface WorkspaceHandle {
  /** 工作区根目录（子 agent 的 cwd） */
  root: string
  identity: WorkspaceIdentity
  /**
   * 清理工作区。force 时丢弃未提交变更；
   * 已被移除视为成功（幂等）。
   */
  dispose(options?: { force?: boolean }): Promise<void>
}

export interface WorkspaceProvider {
  readonly kind: string
  /** 为新 run 创建工作区 */
  create(runId: string, options?: WorkspaceOptions): Promise<WorkspaceHandle>
  /**
   * 重新附着已有工作区（resume）。
   * 不存在时必须抛错——绝不静默重建（文件系统状态丢失 = 假恢复）。
   */
  attach(identity: WorkspaceIdentity): Promise<WorkspaceHandle>
}

/**
 * 清理策略：
 *   - "always"     无论成败都清理
 *   - "on-success" 仅成功清理；失败保留现场（debug/resume 取证，默认）
 *   - "never"      永不清理
 */
export type CleanupPolicy = "always" | "on-success" | "never"
