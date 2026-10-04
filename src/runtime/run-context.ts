/**
 * RunContext —— run 级环境态（P2-9 per-run 化）
 *
 * 背景：executor / checkpoint gate / workspace 原本是三个模块级 ambient 单例。
 * 嵌套工作流（subflow）与并发 run 场景下会互相踩踏：
 *   - 子 run 收口时 setCurrentWorkspace(undefined) 会清掉父 run 的工作区
 *   - scheduler / 调用级 checkpoint 覆盖只能「换全局门 + 事后恢复」，
 *     两个交叠 run 各持不同覆盖值时存在恢复交叠竞态（实测记录在案）
 *
 * 方案：AsyncLocalStorage 承载 run 级状态。runner 在 runToCompletion /
 * resume 执行体外套一层 runWith(...)；原语（checkpoint()/agent()）经
 * 环境读取函数拿「本 run 的」gate/workspace——ALS 里没有时回落模块级
 * 全局（向后兼容：单 run 语义与旧行为完全一致）。
 *
 * executor 刻意保持全局：它由插件 init 一次性注入、从不按 run 换绑，
 * 无踩踏面。
 *
 * 嵌套语义：subflow 子 run 建立新的 ALS 作用域（自己的 runId/journal），
 * 未显式覆盖的字段（gate/workspace）继承父作用域——子 run 的 checkpoint
 * 走父 run 的门，子 agent 的 cwd 落在父 run 的工作区。
 */

import { AsyncLocalStorage } from "node:async_hooks"

import type { CheckpointGate } from "../quality/checkpoint.js"
import type { WorkspaceHandle } from "../workspace/provider.js"

export interface RunContextState {
  /** 本 run 的 runId（journal 主键） */
  runId: string
  /** workflow 标识（registry 解析后已知） */
  workflow?: { id: string; version: string }
  /** 本 run 的 checkpoint gate（缺省回落全局绑定） */
  gate?: CheckpointGate
  /** 本 run 的 workspace（缺省回落全局绑定/无） */
  workspace?: WorkspaceHandle
  /** 嵌套深度：顶层 run = 0，subflow 子 run = 父 depth + 1 */
  depth: number
  /** 父 run 的 runId（lineage；顶层 run 无） */
  parentRunId?: string
}

const runStorage = new AsyncLocalStorage<RunContextState>()

/** 在指定 run 上下文里执行 fn（runner 的 per-run 包装点） */
export function runWith<T>(state: RunContextState, fn: () => Promise<T>): Promise<T> {
  return runStorage.run(state, fn)
}

/** 当前异步链的 run 上下文（不在任何 run 内时 undefined） */
export function currentRunContext(): RunContextState | undefined {
  return runStorage.getStore()
}
