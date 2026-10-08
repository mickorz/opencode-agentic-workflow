/**
 * 代码流程 API（P2-14：自定义 JS 逻辑的对外导出面）
 *
 * 面向在 flows 目录放 .js/.mjs/.cjs 模块的用户代码流程：
 *
 *   import { defineWorkflow, agent, sequence } from "<pkg>/core"
 *
 *   export default defineWorkflow({
 *     id: "my-flow", version: "1.0.0",
 *     stepNames: ["a", "b"],
 *     async run(args, ctx) {
 *       const slug = slugify(args.topic)            // ← 自定义变量/方法回归
 *       return ctx.runSteps([...])
 *     },
 *   })
 *
 * 与声明式 JSON 流程在 registry 眼里完全同权（id@version 资产）：
 * journal / resume / 版本解析 / metrics / 面板详情回放全部一致。
 *
 * 纪律：本 barrel 及其依赖禁止 import OpenCode API（架构不变量，
 * 与 define-workflow.ts 同款约束）——保持可在任意 Node 进程复用。
 */

export {
  defineWorkflow,
  type ArgsSchema,
  type StepFn,
  type WorkflowContext,
  type RunStepsOptions,
  type WorkflowDefinition,
} from "../registry/definition.js"

export {
  agent,
  type AgentCallOptions,
} from "../workflow/agent.js"
export type { AgentResult, TokenUsage } from "../runtime/executor.js"

export { sequence, resumeSequence } from "../workflow/sequence.js"
export { parallel } from "../workflow/parallel.js"
export { pipeline } from "../workflow/pipeline.js"
export { race } from "../workflow/race.js"
export { fallback } from "../workflow/fallback.js"
export { retry } from "../workflow/retry.js"
export { phase } from "../workflow/phase.js"

export { assert } from "../quality/check.js"
export { checkpoint } from "../quality/checkpoint.js"
export { verify, assertVerify } from "../quality/verify.js"
export type { ReviewVerdict } from "../quality/verify.js"
export { commandSuccess, fileExists, isFile, isDirectory } from "../quality/predicates.js"

export { withConcurrencyLimit } from "../runtime/semaphore.js"
export { getCommandRunner } from "../runtime/command.js"
