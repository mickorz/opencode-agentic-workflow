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
import type { CheckpointGate } from "../quality/checkpoint.js"
import { runWith, currentRunContext } from "../runtime/run-context.js"
import {
  type CleanupPolicy,
  type WorkspaceHandle,
  type WorkspaceOptions,
  type WorkspaceProvider,
} from "../workspace/index.js"
import {
  resumeSequence,
  sequence,
  type SequenceOptions,
} from "../workflow/sequence.js"
import type { WorkflowContext } from "./definition.js"
import type { WorkflowRegistry } from "./registry.js"
import { WorkflowArgsError, WorkflowExecutionError } from "./errors.js"
import { validateArgs } from "./schema.js"
import { RunAbortedError, clearLive, markLive, throwIfCancelled } from "./run-control.js"

/** subflow 嵌套深度上限（顶层 depth=0；防御失控递归，对齐 v1 事故教训） */
export const MAX_SUBFLOW_DEPTH = 3

/** 启动选项（start / detached / resume 共用） */
export interface RunLaunchOptions {
  workspace?: WorkspaceBinding
  /**
   * P2-9 本 run 的 checkpoint gate（scheduler 无人值守 / 调用级覆盖用）。
   * 缺省继承当前 run 上下文（subflow）或回落全局绑定。
   */
  gate?: CheckpointGate
}

export interface WorkflowRunResult {
  runId: string
  workflow: WorkflowIdentity
  output: string
  /**
   * 子流程返回值本体（内存直传，保真）。output 是 toOutput 抽平后的
   * 显示用字符串——`{output:"text"}` 形状会被抽平成纯文本，结构不可
   * 逆；需要原始结构的消费方（legacy workflow()）读这个字段。
   * 仅 start/resume 内存链路携带；跨进程/旧 journal 重建时缺省。
   */
  result?: unknown
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
  registry?: WorkflowRegistry
  workspaceRoot?: string
}): WorkflowContext {
  return {
    runId: input.runId,
    mode: input.mode,
    // resume 模式的 journal 由 resumeSequence 内部管理（attach/reopen/收口），
    // ctx 不直接暴露，避免双写
    journal: input.mode === "start" ? input.journal : undefined,
    // P2.7：隔离工作区根目录（未启用隔离时为 undefined）
    workspaceRoot: input.workspaceRoot,
    // P2-9 subflow：需要 registry + store（未配置 journalDir 的 run 不提供）
    ...(input.registry !== undefined && input.store !== undefined
      ? {
          subflow: async <TArgs>(
            id: string,
            args?: TArgs,
            options?: { version?: string },
          ) => {
            const parent = currentRunContext()
            const depth = (parent?.depth ?? 0) + 1
            if (depth > MAX_SUBFLOW_DEPTH) {
              throw new Error(
                `[agentic-workflow] subflow nesting too deep: depth ${depth} > ` +
                  `${MAX_SUBFLOW_DEPTH} (parent run ${input.runId} -> ${id}); ` +
                  "flatten the workflow composition",
              )
            }
            const registry = input.registry as WorkflowRegistry
            const store = input.store as ExecutionStore
            // gate/workspace 经 ALS 继承父作用域；lineage 由 runToCompletion 推导
            const result = await startWorkflow(registry, store, id, args ?? {}, {
              ...(options?.version !== undefined ? { version: options.version } : {}),
            })
            // result 字段内存直传子流程返回值本体（legacy workflow() 保真用）
            return { runId: result.runId, output: result.output, result: result.result }
          },
        }
      : {}),
    runSteps(steps, options) {
      // P1-3 协作式取消：每个步骤执行前检查 stop 标记（正在执行的
      // LLM 调用不打断，下一个边界生效并收口 aborted）
      const guarded = (steps as Array<(prev?: unknown) => Promise<unknown>>).map(
        (step) => async (prev?: unknown) => {
          throwIfCancelled(input.runId)
          return step(prev)
        },
      )
      if (input.mode === "resume" && input.store) {
        return resumeSequence(
          input.store,
          input.runId,
          guarded as never,
          options as SequenceOptions,
        )
      }
      return sequence(guarded as never, {
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

/** 隔离绑定：provider + 创建参数 + 清理策略（start/resume 均可传） */
export interface WorkspaceBinding {
  provider: WorkspaceProvider
  options?: WorkspaceOptions
  /** 缺省 "on-success"（成功清理；失败保留现场便于 debug/resume） */
  cleanup?: CleanupPolicy
}

/**
 * 按策略清理 workspace；清理后清除 journal 中的 workspace 身份
 * （否则已清理的 run 在幂等 resume 时会 attach 一个已删除的目录）。
 * 清理失败只记录——观测/基础设施不能成为主链路故障源。
 */
async function cleanupWorkspace(
  store: ExecutionStore,
  runId: string,
  handle: WorkspaceHandle | undefined,
  policy: CleanupPolicy,
  success: boolean,
): Promise<void> {
  if (!handle) return
  if (policy === "never") return
  if (policy === "on-success" && !success) return
  try {
    await handle.dispose({ force: true })
    const journal = await RunJournal.attach(store, runId)
    await journal?.clearWorkspace()
  } catch (error) {
    console.log(
      `[agentic-workflow] workspace cleanup failed for ${runId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** begin 阶段产物：runId 已定、journal 已落盘，执行尚未开始 */
interface BegunRun {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  definition: any
  identity: WorkflowIdentity
  journal: RunJournal
  runId: string
  store: ExecutionStore
  registry: WorkflowRegistry
  cleanupPolicy: CleanupPolicy
}

/** begin：resolve -> args 校验 -> journal 落盘（到此即有 runId；验证错误同步抛出） */
async function beginRun(
  registry: WorkflowRegistry,
  store: ExecutionStore,
  id: string,
  args: unknown,
  options?: { version?: string; workspace?: WorkspaceBinding },
): Promise<BegunRun> {
  const definition = registry.resolve(id, options?.version)
  const problems = validateArgs(definition.argsSchema, args)
  if (problems.length > 0) {
    throw new WorkflowArgsError(definition.id, problems)
  }
  const identity: WorkflowIdentity = { id: definition.id, version: definition.version }
  // P2-9 lineage：subflow 在父 run 作用域内发起时自动指回父 run；
  // 深度同式推导（与 runToCompletion 的 ALS 深度一致）
  const parent = currentRunContext()
  const journal = await RunJournal.start(store, {
    workflow: identity,
    args,
    stepNames: definition.stepNames,
    stepCount: definition.stepNames?.length ?? 0,
    ...(parent !== undefined ? { parentRunId: parent.runId } : {}),
    ...(parent !== undefined ? { depth: parent.depth + 1 } : {}),
  })
  return {
    definition,
    identity,
    journal,
    runId: journal.run.runId,
    store,
    registry,
    cleanupPolicy: options?.workspace?.cleanup ?? "on-success",
  }
}

/** execute：workspace 创建 -> definition.run -> 收口 -> 清理（含取消/失败分支） */
async function runToCompletion(
  begun: BegunRun,
  args: unknown,
  options?: RunLaunchOptions,
): Promise<WorkflowRunResult> {
  const { definition, identity, journal, runId, store, cleanupPolicy } = begun
  markLive(runId)
  // P2-9：发起时刻的 run 上下文（subflow 子 run = 父作用域；顶层/scheduled = 空）
  const parent = currentRunContext()
  let workspace: WorkspaceHandle | undefined
  try {
    // P2.7：创建隔离工作区并把身份落 journal（resume attach 依据）
    if (options?.workspace) {
      workspace = await options.workspace.provider.create(runId, options.workspace.options)
      await journal.setWorkspace(workspace.identity)
    }
    // P2-9 run 级上下文：gate 按选项 > 父作用域继承 > 全局绑定回落（读取方实现）；
    // workspace 本 run 创建的优先，否则继承父作用域（subflow 子 agent cwd =
    // 父 run 工作区）；depth/lineage 由父作用域推导
    const result = await runWith(
      {
        runId,
        workflow: identity,
        ...(options?.gate !== undefined
          ? { gate: options.gate }
          : parent?.gate !== undefined
            ? { gate: parent.gate }
            : {}),
        ...(workspace !== undefined
          ? { workspace }
          : parent?.workspace !== undefined
            ? { workspace: parent.workspace }
            : {}),
        // 顶层 run depth=0；subflow 子 run = 父 depth + 1
        depth: parent !== undefined ? parent.depth + 1 : 0,
        ...(parent !== undefined ? { parentRunId: parent.runId } : {}),
      },
      () =>
        definition.run(
          args as never,
          createContext({
            runId,
            mode: "start",
            journal,
            store,
            registry: begun.registry,
            workspaceRoot: (workspace ?? parent?.workspace)?.root,
          }),
        ),
    )
    // 顺序纪律：先收口 journal 再清理 workspace——cleanupWorkspace 会经
    // attach 重读持久化状态并清除 workspace 字段，若 complete() 在其后，
    // 内存 journal 会把已删除的 worktree 身份复活写回（幂等 resume 即坏）
    if (journal.run.status === "running") {
      await journal.complete()
    }
    await cleanupWorkspace(store, runId, workspace, cleanupPolicy, true)
    return { runId, workflow: identity, output: toOutput(result), result }
  } catch (error) {
    // P1-3：用户协作式停止 -> aborted（与失败可区分：主动停 ≠ 出错）；
    // 其余失败 -> failed。两者都清理失败现场并统一抛 WorkflowExecutionError
    if (journal.run.status === "running") {
      if (error instanceof RunAbortedError) {
        await journal.abort(error)
      } else {
        await journal.fail(error)
      }
    }
    await cleanupWorkspace(store, runId, workspace, cleanupPolicy, false)
    throw new WorkflowExecutionError({ runId, ...identity }, error)
  } finally {
    clearLive(runId)
  }
}

/** 启动新 run（默认最新版本；可用 options.version 精确指定）。阻塞至完成 */
export async function startWorkflow(
  registry: WorkflowRegistry,
  store: ExecutionStore,
  id: string,
  args: unknown,
  options?: { version?: string } & RunLaunchOptions,
): Promise<WorkflowRunResult> {
  const begun = await beginRun(registry, store, id, args, options)
  return runToCompletion(begun, args, options)
}

export interface DetachedWorkflowRun {
  runId: string
  workflow: WorkflowIdentity
  /** 完成时 resolve；失败/中止 reject（journal 已收口，错误仅留痕） */
  completion: Promise<WorkflowRunResult>
}

/**
 * P1-3 后台启动：begin（同步可抛验证错误）后立即返回 runId，
 * 执行在后台继续。结果不自动回传会话——用 workflow_control status 轮询
 * （journal 是唯一事实源）。
 */
export async function startWorkflowDetached(
  registry: WorkflowRegistry,
  store: ExecutionStore,
  id: string,
  args: unknown,
  options?: { version?: string } & RunLaunchOptions,
): Promise<DetachedWorkflowRun> {
  const begun = await beginRun(registry, store, id, args, options)
  return {
    runId: begun.runId,
    workflow: begun.identity,
    completion: runToCompletion(begun, args, options),
  }
}

/**
 * 从 journal 恢复 run：
 *   - workflow {id, version} 来自 journal，registry 精确版本解析（找不到即报错并列版本）
 *   - args 取 journal 记录（无需调用方重新提供）
 *   - journal 记录了 workspace 身份时，**重新附着原工作区**（绝不重建——
 *     durable resume = journal 状态 + 文件系统状态同时恢复；缺失即报错）
 *   - 已完成的 run 幂等重放（不执行任何步骤，仅重建最终报告）
 */
export async function resumeWorkflow(
  registry: WorkflowRegistry,
  store: ExecutionStore,
  runId: string,
  options?: RunLaunchOptions,
): Promise<WorkflowRunResult> {
  const run = await store.getRun(runId)
  if (!run) {
    throw new Error(`[agentic-workflow] cannot resume: run not found: ${runId}`)
  }
  const identity = run.workflow
  const definition = registry.resolve(identity.id, identity.version)
  const cleanupPolicy = options?.workspace?.cleanup ?? "on-success"

  let workspace: WorkspaceHandle | undefined
  markLive(runId)
  try {
    if (options?.workspace && run.workspace) {
      workspace = await options.workspace.provider.attach(run.workspace)
    }
    // P2-9：resume 独立成 run（深度重置 0；lineage 已在 journal 里，
    // 不因 resume 重建）。gate 同 start：选项优先，回落全局绑定。
    const result = await runWith(
      {
        runId,
        workflow: identity,
        ...(options?.gate !== undefined ? { gate: options.gate } : {}),
        ...(workspace !== undefined ? { workspace } : {}),
        depth: 0,
      },
      () =>
        definition.run(
          run.args as never,
          createContext({
            runId,
            mode: "resume",
            store,
            registry,
            workspaceRoot: workspace?.root,
          }),
        ),
    )
    // 同 start：先收口 journal（settle），再清理 workspace（clearWorkspace
    // 允许在收口后执行——幂等 resume 依赖清理后字段被清掉）
    await settleAfterSuccess(store, runId)
    await cleanupWorkspace(store, runId, workspace, cleanupPolicy, true)
    return { runId, workflow: identity, output: toOutput(result), result }
  } catch (error) {
    // P1-3：resume 途中被 stop -> aborted（其余失败维持 failed 语义）
    if (error instanceof RunAbortedError) {
      const journal = await RunJournal.attach(store, runId)
      if (journal && journal.run.status === "running") {
        await journal.abort(error)
      }
    } else {
      await settleAfterFailure(store, runId, error)
    }
    await cleanupWorkspace(store, runId, workspace, cleanupPolicy, false)
    throw new WorkflowExecutionError({ runId, ...identity }, error)
  } finally {
    clearLive(runId)
  }
}
