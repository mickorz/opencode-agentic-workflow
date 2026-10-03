/**
 * WorkflowDefinition —— workflow 的元数据契约（P2.5）
 *
 * 一个 workflow = 一份声明式定义：
 *   { id, version, description, argsSchema, stepNames, run }
 *
 * - version 是第一公民：journal 记录 {id, version}，resume 经 registry
 *   解析到**精确版本**（绝不隐式取最新），步骤结构变更必须升版本。
 * - argsSchema 用项目既有的 JSON Schema 风格（最小依赖，不引入 Zod），
 *   服务于：tool schema 生成 / args 校验 / 未来 TUI 表单与 Hub 展示。
 * - run(args, ctx)：ctx 携带执行身份（runId / mode / journal / runSteps），
 *   definition 内部统一用 ctx.runSteps(...) 编排步骤——
 *   start 与 resume 的差异被 ctx 完全封装。
 */

import type { ArgsSchema } from "./schema.js"
import type { RunJournal } from "../state/recorder.js"

/** args 声明契约（JSON Schema 子集，见 schema.ts） */
export type { ArgsSchema }

/** 步骤函数（与 sequence 的 Step 兼容） */
export type StepFn<T> = (prev?: T) => Promise<T>

/**
 * 执行上下文：registry runner 构造并传给 definition.run。
 *
 * mode:
 *   - "start"  全新执行（runSteps = sequence + journal 记录）
 *   - "resume" 从 journal 恢复（runSteps = resumeSequence：跳过 completed
 *              前缀，从首个未完成步骤重跑）
 */
export interface WorkflowContext {
  runId: string
  mode: "start" | "resume"
  /** journal（配置了 ExecutionStore 时存在；definition 应传给 runSteps） */
  journal?: RunJournal
  /** 编排步骤的统一入口（自动处理 start/resume 与 journal 记录） */
  runSteps<T>(steps: Array<StepFn<T>>, options?: RunStepsOptions): Promise<T | undefined>
}

export interface RunStepsOptions {
  /** 失败模式，默认 fail-fast */
  onFailure?: "fail-fast" | "continue"
  /** 步骤名（错误定位与 journal 记录） */
  stepNames?: string[]
}

export interface WorkflowDefinition<TArgs = unknown, TResult = unknown> {
  /** 唯一标识（workflow tool 的 flow 参数值 / journal.workflow.id） */
  id: string
  /** 语义化版本：步骤结构或行为变更时必须升版（resume 依赖精确版本解析） */
  version: string
  /** 人读描述（进入工具描述，供主 agent 选择） */
  description?: string
  /** 入参契约（JSON Schema 子集）；undefined 表示无参 */
  argsSchema?: ArgsSchema
  /**
   * 步骤名（静态声明；同时决定 journal 的 stepCount/stepNames）。
   * resume 依赖步骤序号稳定——增删/重排步骤必须升 version。
   */
  stepNames?: string[]
  /** 入口：args（已经校验）+ ctx -> 结果（约定带 output 文本字段） */
  run(args: TArgs, context: WorkflowContext): Promise<TResult>
}

/** defineWorkflow：恒等函数，仅收紧类型（DX 糖） */
export function defineWorkflow<TArgs = unknown, TResult = unknown>(
  definition: WorkflowDefinition<TArgs, TResult>,
): WorkflowDefinition<TArgs, TResult> {
  return definition
}
