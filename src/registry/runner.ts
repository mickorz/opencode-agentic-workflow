/**
 * Registry Runner（P2.5 journal 集成）
 *
 * 把 Definition / Registry / Journal / Resume 正式串起来：
 *
 *   startWorkflow:  registry.resolve(id)[@version] -> args 校验 -> journal 落盘
 *                   -> definition.run(args, ctx{mode:"start"})
 *                   -> ctx.runSteps = sequence + journal 记录
 *
 *   resumeWorkflow: store.getRun(runId) -> workflow {id, version}
 *                   -> registry.resolve(id, version)  ← 精确版本，绝不取最新
 *                   -> definition.run(journal.args, ctx{mode:"resume"})
 *                   -> ctx.runSteps = resumeSequence（跳过 completed 前缀）
 *
 * definition 只感知 ctx.runSteps——start/resume 差异被完全封装；
 * 失败统一抛 WorkflowExecutionError（携带 runId，供工具层提示恢复入口）。
 */

import type { WorkflowIdentity } from "../state/journal.js"
import { RunJournal } from "../state/recorder.js"
import type { ExecutionStore } from "../state/store.js"
import {
  resumeSequence,
  sequence,
  type SequenceOptions,
} from "../workflow/sequence.js"
import type { WorkflowContext } from "./definition.js"
import type { WorkflowRegistry } from "./registry.js"
import { WorkflowArgsError, WorkflowExecutionError } from "./errors.js"
import { validateArgs } from "./schema.js"

export interface WorkflowRunResult {
  runId: string
  workflow: WorkflowIdentity
  output: string
}

function toOutput(result: unknown): string {
  if (typeof result === "string") return result
  if (
    result &&
    typeof result === "object" &&
    typeof (result as { output?: unknown }).output === "string"
  ) {
    return (result as { output: string }).output
  }
  return JSON.stringify(result) ?? ""
}

function createContext(input: {
  runId: string
  mode: "start" | "resume"
  journal?: RunJournal
  store?: ExecutionStore
}): WorkflowContext {
  return {
    runId: input.runId,
    mode: input.mode,
    // resume 模式的 journal 由 resumeSequence 内部管理（attach/reopen/收口），
    // ctx 不直接暴露，避免双写
    journal: input.mode === "start" ? input.journal : undefined,
    runSteps(steps, options) {
      if (input.mode === "resume" && input.store) {
        return resumeSequence(input.store, input.runId, steps, options as SequenceOptions)
      }
      return sequence(steps, {
        ...(options as SequenceOptions),
        journal: input.journal,
      })
    },
  }
}

/**
 * 无持久化直跑（插件未配置 journalDir 时的兼容路径）：
 * 经注册表解析 + args 校验，但不落 journal、不可恢复。
 */
export async function runWorkflowInline(
  registry: WorkflowRegistry,
  id: string,
  args: unknown,
): Promise<{ output: string }> {
  const definition = registry.resolve(id)
  const problems = validateArgs(definition.argsSchema, args)
  if (problems.length > 0) {
    throw new WorkflowArgsError(definition.id, problems)
  }
  const result = await definition.run(args as never, {
    runId: `inline_${Date.now()}`,
    mode: "start",
    runSteps: (steps, options) => sequence(steps, options),
  })
  return { output: toOutput(result) }
}

/** 收口辅助：成功路径把仍为 running 的 journal 置 completed（step-less 工作流兜底） */
async function settleAfterSuccess(store: ExecutionStore, runId: string): Promise<void> {
  const journal = await RunJournal.attach(store, runId)
  if (!journal) return
  if (journal.run.status === "running") {
    await journal.complete()
  } else if (journal.run.status === "failed") {
    // resume 成功但 definition 未走 runSteps（step-less）：failed -> completed
    await journal.reopen()
    await journal.complete()
  }
}

async function settleAfterFailure(
  store: ExecutionStore,
  runId: string,
  error: unknown,
): Promise<void> {
  const journal = await RunJournal.attach(store, runId)
  if (journal && journal.run.status === "running") {
    await journal.fail(error)
  }
}

/** 启动新 run（默认最新版本；可用 options.version 精确指定） */
export async function startWorkflow(
  registry: WorkflowRegistry,
  store: ExecutionStore,
  id: string,
  args: unknown,
  options?: { version?: string },
): Promise<WorkflowRunResult> {
  const definition = registry.resolve(id, options?.version)
  const problems = validateArgs(definition.argsSchema, args)
  if (problems.length > 0) {
    throw new WorkflowArgsError(definition.id, problems)
  }

  const identity: WorkflowIdentity = { id: definition.id, version: definition.version }
  const journal = await RunJournal.start(store, {
    workflow: identity,
    args,
    stepNames: definition.stepNames,
    stepCount: definition.stepNames?.length ?? 0,
  })
  const runId = journal.run.runId

  try {
    const result = await definition.run(
      args as never,
      createContext({ runId, mode: "start", journal }),
    )
    if (journal.run.status === "running") {
      await journal.complete()
    }
    return { runId, workflow: identity, output: toOutput(result) }
  } catch (error) {
    if (journal.run.status === "running") {
      await journal.fail(error)
    }
    throw new WorkflowExecutionError({ runId, ...identity }, error)
  }
}

/**
 * 从 journal 恢复 run：
 *   - workflow {id, version} 来自 journal，registry 精确版本解析（找不到即报错并列版本）
 *   - args 取 journal 记录（无需调用方重新提供）
 *   - 已完成的 run 幂等重放（不执行任何步骤，仅重建最终报告）
 */
export async function resumeWorkflow(
  registry: WorkflowRegistry,
  store: ExecutionStore,
  runId: string,
): Promise<WorkflowRunResult> {
  const run = await store.getRun(runId)
  if (!run) {
    throw new Error(`[agentic-workflow] cannot resume: run not found: ${runId}`)
  }
  const identity = run.workflow
  const definition = registry.resolve(identity.id, identity.version)

  try {
    const result = await definition.run(
      run.args as never,
      createContext({ runId, mode: "resume", store }),
    )
    await settleAfterSuccess(store, runId)
    return { runId, workflow: identity, output: toOutput(result) }
  } catch (error) {
    await settleAfterFailure(store, runId, error)
    throw new WorkflowExecutionError({ runId, ...identity }, error)
  }
}
