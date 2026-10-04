/**
 * sequence() —— 顺序执行步骤，上一步结果作为下一步入参
 * （P1.3 失败语义 / P2.2 journal 记录与恢复）
 *
 * onFailure 两种模式：
 *   "fail-fast"（默认）：第一个失败步骤抛 WorkflowSequenceError，剩余步骤不再执行。
 *   "continue"        ：失败步骤被记录，后续步骤仍执行（prev = 最后一次成功值），
 *                       全部执行完后若存在失败，仍抛 WorkflowSequenceError（累积全部错误）。
 *
 * journal（可选）：传入 RunJournal 后每次状态变更落盘，
 *   配合 resumeSequence() 可在 run 中断后从 completed 前缀恢复续跑。
 *
 * resumeSequence()（P2.2）：从 journal 恢复——
 *   Step1 ✅ Step2 ✅ Step3 ❌ Step4 -
 *     -> restart -> 跳过 1/2（prev 取 journal 输出），从 Step3 重跑
 *   注意：重跑意味着 Step3 的副作用会再次发生（非幂等步骤需自行保证安全）。
 *   仅支持 sequence 的恢复；parallel/nested 的恢复不在 P2.2 范围。
 */

import { WorkflowSequenceError, WorkflowStepError } from "../runtime/errors.js"
import { emitEvent } from "../observability/events.js"
import { RunJournal } from "../state/recorder.js"
import type { ExecutionStore } from "../state/store.js"
import { RunAbortedError } from "../registry/run-control.js"

export interface SequenceOptions {
  /** 失败模式，默认 "fail-fast" */
  onFailure?: "fail-fast" | "continue"
  /** 步骤名（用于错误定位），可选 */
  stepNames?: string[]
  /** 可选 journal：记录本次执行（持久化；配合 resumeSequence 可恢复） */
  journal?: RunJournal
}

type Step<T> = (prev?: T) => Promise<T>

/** 可注入的步骤编排入口（registry ctx.runSteps 的结构类型；缺省 = sequence 直跑） */
export type RunStepsFn = <T>(
  steps: Array<Step<T>>,
  options?: SequenceOptions,
) => Promise<T | undefined>

function assertStepCount(journal: RunJournal | undefined, steps: number): void {
  if (journal && journal.run.steps.length !== steps) {
    throw new Error(
      `[agentic-workflow] journal step count mismatch: journal ` +
        `${journal.run.steps.length} vs steps ${steps} (run ${journal.run.runId})`,
    )
  }
}

async function runLoop<T>(
  steps: Array<Step<T>>,
  options: SequenceOptions | undefined,
  journal: RunJournal | undefined,
  fromIndex: number,
  initialPrev: T | undefined,
): Promise<T | undefined> {
  const onFailure = options?.onFailure ?? "fail-fast"
  const errors: WorkflowStepError[] = []
  let result = initialPrev

  for (let i = fromIndex; i < steps.length; i++) {
    const step = steps[i]
    if (!step) continue
    const stepStartedAt = Date.now()
    try {
      emitEvent({ type: "step.started", index: i })
      await journal?.stepStarted(i, result)
      result = await step(result)
      await journal?.stepCompleted(i, result)
      emitEvent({ type: "step.completed", index: i, durationMs: Date.now() - stepStartedAt })
    } catch (cause) {
      // P1-3 协作式停止：RunAbortedError 直接穿透——不收集、不标 step failed、
      // 不把 run 收口为 failed（由 runner 统一收口为 aborted：主动停 ≠ 出错）
      if (cause instanceof RunAbortedError) {
        throw cause
      }
      const stepError = new WorkflowStepError(i, cause, options?.stepNames?.[i])
      await journal?.stepFailed(i, cause)
      emitEvent({
        type: "step.failed",
        index: i,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      if (onFailure === "fail-fast") {
        const sequenceError = new WorkflowSequenceError([stepError], result)
        await journal?.fail(sequenceError)
        throw sequenceError
      }
      errors.push(stepError)
      // continue 模式：result 保持为最后一次成功值
    }
  }

  if (errors.length > 0) {
    const sequenceError = new WorkflowSequenceError(errors, result)
    await journal?.fail(sequenceError)
    throw sequenceError
  }

  await journal?.complete()
  return result
}

export async function sequence<T>(
  steps: Array<Step<T>>,
  options?: SequenceOptions,
): Promise<T | undefined> {
  assertStepCount(options?.journal, steps.length)
  return runLoop(steps, options, options?.journal, 0, undefined)
}

/**
 * 从 journal 恢复执行 sequence：
 *   - run 已 completed：直接返回最后一步的 journal 输出（幂等，不执行任何步骤）
 *   - 否则：跳过 completed 前缀（prev 取 journal 输出），从第一个未完成步骤重跑
 *   - steps 必须与原 run 步骤数一致（同一 workflow 定义重新声明）
 */
export async function resumeSequence<T>(
  store: ExecutionStore,
  runId: string,
  steps: Array<Step<T>>,
  options?: SequenceOptions,
): Promise<T | undefined> {
  const journal = await RunJournal.attach(store, runId)
  if (!journal) {
    throw new Error(`[agentic-workflow] cannot resume: run not found: ${runId}`)
  }
  assertStepCount(journal, steps.length)

  const run = journal.run

  if (run.status === "completed") {
    const last = run.steps[run.steps.length - 1]
    return last?.output as T | undefined
  }

  await journal.reopen()

  // 恢复 completed 前缀的 prev 链，从第一个未完成步骤重跑
  let fromIndex = 0
  let prev: T | undefined = undefined
  while (fromIndex < run.steps.length && run.steps[fromIndex]?.status === "completed") {
    prev = run.steps[fromIndex]?.output as T | undefined
    fromIndex += 1
  }

  return runLoop(steps, options, journal, fromIndex, prev)
}
