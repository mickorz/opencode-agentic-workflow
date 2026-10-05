/**
 * Run 会话登记（并发 run 时代的递归防护）
 *
 * 背景：workflow 工具的递归防护原先用「任一 run 在飞即拒绝一切调用」的
 * 计数器——它同时挡掉了合法的顶层并发（P2-9 已消除 gate/workspace 全局
 * 单例，架构上并发安全）。现在改为**按调用来源判别**：
 *   - executor 为每个 agent 任务创建的子会话在此登记（任务结束注销）
 *   - workflow 工具凭调用会话自身/祖先链是否命中登记，识别「来自 run
 *     内部的调用」（run 的 agent 或其再派子 agent 再调 workflow =
 *     信号量自饿死，拒绝）
 *   - 顶层用户会话不在任何 run 树内 → 允许并发（受 maxConcurrentRuns 上限）
 *
 * 祖先链查询注入（session.get 的 parentID），本模块保持纯逻辑可单测。
 */

const runSessions = new Set<string>()

/** executor 子会话开始（任务执行期内）登记 */
export function trackRunSession(sessionID: string): void {
  runSessions.add(sessionID)
}

/** executor 子会话结束注销（execute 的 finally） */
export function untrackRunSession(sessionID: string): void {
  runSessions.delete(sessionID)
}

/** 会话是否为某活 run 的直接 agent 会话 */
export function isRunSession(sessionID: string): boolean {
  return runSessions.has(sessionID)
}

/** 登记数（测试/诊断用） */
export function trackedRunSessionCount(): number {
  return runSessions.size
}

/**
 * 调用会话是否位于任一活 run 的 agent 树内：
 * 自身被登记，或某级祖先被登记（run 的 agent 派生的子 agent 场景）。
 * 祖先查询注入；跳数封顶防御环/脏数据。
 */
export async function isInsideRunSession(
  sessionID: string,
  getParentID: (id: string) => Promise<string | undefined>,
  maxHops = 8,
): Promise<boolean> {
  let current: string | undefined = sessionID
  for (let hop = 0; hop < maxHops && current !== undefined; hop++) {
    if (isRunSession(current)) return true
    current = await getParentID(current)
  }
  return false
}
