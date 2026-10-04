/**
 * 当前 workspace 的进程内环境态（P2.7；P2-9 起 run 级化）
 *
 * 读取顺序：run 上下文（AsyncLocalStorage）优先，回落模块级绑定。
 * runner 经 runWith 把 workspace 放进 run 上下文；subflow 子 run 未显式
 * 覆盖时继承父作用域——子 agent 的 cwd 落在父 run 的工作区。
 * agent() 读取并下发给 executor 作为子会话 cwd；
 * workflow 原语不感知 runner 的存在。
 */

import type { WorkspaceHandle } from "./provider.js"
import { currentRunContext } from "../runtime/run-context.js"

let current: WorkspaceHandle | undefined

/** 设置/清除模块级 workspace（兼容路径；runner 现在走 run 上下文） */
export function setCurrentWorkspace(handle: WorkspaceHandle | undefined): void {
  current = handle
}

/** 当前 run 的 workspace（未启用隔离时为 undefined） */
export function currentWorkspace(): WorkspaceHandle | undefined {
  const ctx = currentRunContext()
  if (ctx) return ctx.workspace
  return current
}
