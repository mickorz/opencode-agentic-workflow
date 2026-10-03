/**
 * 当前 workspace 的进程内环境态（P2.7）
 *
 * 与 setExecutor / setCheckpointGate 同一模式（ambient 绑定）：
 * runner 在 def.run 期间设置，agent() 读取并下发给 executor 作为子会话 cwd。
 * workflow 原语不感知 runner 的存在。
 */

import type { WorkspaceHandle } from "./provider.js"

let current: WorkspaceHandle | undefined

/** 设置/清除当前 workspace（runner 在 run 生命周期内调用） */
export function setCurrentWorkspace(handle: WorkspaceHandle | undefined): void {
  current = handle
}

/** 当前 run 的 workspace（未启用隔离时为 undefined） */
export function currentWorkspace(): WorkspaceHandle | undefined {
  return current
}
