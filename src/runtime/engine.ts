/**
 * WorkflowEngine —— 绑定 executor 并执行 workflow 函数
 *
 * P0 语义：
 *   engine.run(workflowFn)
 *     -> 绑定当前 executor（模块级）
 *     -> 执行 workflowFn（内部调用 agent()/parallel()/sequence()/phase()）
 *     -> 恢复原 executor，返回 workflowFn 的返回值
 *
 * P0 不做：retry / timeout / verify / checkpoint / journal。
 */

import type { AgentExecutor } from "./executor.js"

/** 当前绑定的 executor（模块级；P0 不处理并发嵌套引擎） */
let currentExecutor: AgentExecutor | undefined

/** 显式设置全局 executor（供 plugin 初始化时注入 OpenCodeV2Executor） */
export function setExecutor(executor: AgentExecutor): void {
  currentExecutor = executor
}

/** 获取当前 executor；未绑定时抛错（workflow 必须在 engine.run 内执行） */
export function requireExecutor(): AgentExecutor {
  if (!currentExecutor) {
    throw new Error(
      "[agentic-workflow] no executor bound: run workflows inside engine.run() or call setExecutor() first",
    )
  }
  return currentExecutor
}

export async function runWorkflow<T>(workflow: () => Promise<T>): Promise<T> {
  if (!currentExecutor) {
    throw new Error("[agentic-workflow] engine has no executor: call setExecutor() before runWorkflow()")
  }
  return workflow()
}
