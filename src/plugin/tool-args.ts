/**
 * workflow 工具入参 -> flow args（v1-parity P0-1：args 工具层透传）
 *
 * 背景：引擎 startWorkflow(registry, store, id, args) 早已接受任意 args 并按
 * definition.argsSchema 校验（required/类型/枚举），但工具层此前只硬编码转发
 * topic——P4 自定义流程声明的 args 与 feature-development 的
 * checkCommand/reviewers/keepLockfileChanges 经工具一律不可达。
 *
 * 合并语义：
 * - topic 恒为顶层显式参数（向后兼容所有内置流程）
 * - 顶层 topic 优先于 args.topic（显式字段是 canonical 来源）
 * - args 非对象（数组/字符串等）→ 抛错，由工具层既有 catch 通道转成结果文本
 *   ——fail-loud，不静默吞掉（静默降级是本仓库明确淘汰的设计）
 */

export function buildWorkflowArgs(topic: unknown, args: unknown): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  if (args !== undefined && args !== null) {
    if (typeof args !== "object" || Array.isArray(args)) {
      throw new Error(
        `[agentic-workflow] workflow tool "args" must be an object of flow parameters (got ${Array.isArray(args) ? "array" : typeof args})`,
      )
    }
    Object.assign(payload, args as Record<string, unknown>)
  }
  if (topic !== undefined && topic !== null) {
    payload.topic = topic
  }
  return payload
}
