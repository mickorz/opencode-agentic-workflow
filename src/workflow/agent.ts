/**
 * agent() —— 提交单个子 agent 任务
 *
 * 不感知 ctx / OpenCode：只经由 requireExecutor() 拿到当前绑定的
 * AgentExecutor 并执行。P0 不做 permissions / retry / timeout /
 * verify / token metrics / context isolation。
 */

import type { AgentResult } from "../runtime/executor.js"
import { requireExecutor } from "../runtime/engine.js"

export async function agent(prompt: string): Promise<AgentResult> {
  return requireExecutor().execute({ prompt })
}
