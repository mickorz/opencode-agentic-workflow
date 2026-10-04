/**
 * Workflow 事件总线（P2.4 observability 地基）
 *
 * phase() 从 metadata 升级为事件源：所有核心原语（agent/check/verify/checkpoint/
 * sequence/workflow）在关键节点派发结构化事件，后续 TUI、metrics、debug、
 * trace 文件全部消费这一套事件流。
 *
 * 设计原则：
 *   - 事件小而可序列化（JSON-safe），便于落盘与跨进程传输
 *   - 派发同步、fan-out；handler 抛错被隔离（监听器绝不能破坏 workflow 本身）
 *   - 全局默认 bus 可替换（setEventBus），测试/宿主可注入自己的 bus
 */

import type { TokenUsage } from "../runtime/executor.js"

export interface WorkflowEventBase {
  /** epoch ms */
  time: number
}

export type WorkflowEvent = WorkflowEventBase &
  (
    | { type: "workflow.started"; workflowId: string; args?: Record<string, unknown> }
    | { type: "workflow.completed"; workflowId: string; durationMs: number }
    | { type: "workflow.failed"; workflowId: string; error: string }
    | { type: "phase.started"; name: string }
    | {
        type: "agent.started"
        promptPreview: string
        /** 发出调用的 run（P2-8b 步骤元数据；run 作用域外省略） */
        runId?: string
      }
    | {
        type: "agent.completed"
        durationMs: number
        outputLength: number
        /** token 用量（宿主能提供时；metrics 消费） */
        usage?: TokenUsage
        /** 美元成本（宿主直接给出时） */
        costUSD?: number
        /** 实际使用的模型 "providerID/id" */
        model?: string
        /** 完成调用的 run（journal 侧聚合到 currentStep） */
        runId?: string
      }
    | {
        type: "agent.failed"
        durationMs: number
        error: string
        /** 失败调用的 run（trace 按 run 过滤用） */
        runId?: string
      }
    | { type: "check.completed"; label: string; ok: boolean }
    | {
        type: "verify.completed"
        label: string
        passed: boolean
        passedCount: number
        totalCount: number
        /** P2-11：投票阈值 < 1 时携带（默认全票不附） */
        threshold?: number
      }
    | {
        /** v0.3.1 坑 3：reviewer 协议失败（解析重试耗尽）——非语义否决 */
        type: "verify.protocol_failed"
        label: string
        reviewer: number
        attempts: number
        lastRaw: string
      }
    | { type: "checkpoint.waiting"; label: string; message: string }
    | { type: "checkpoint.completed"; label: string; approved: boolean }
    | { type: "step.started"; index: number }
    | { type: "step.completed"; index: number; durationMs: number }
    | { type: "step.failed"; index: number; error: string }
    /**
     * P2-8 进度树数据源：journal 每次状态转换发射完整 run 快照
     * （步级 started/completed/failed + run 级 complete/fail/abort + 创建时）。
     * 消费方（进度 board / TUI 面板）无需增量对账——单飞语义下顺序天然一致。
     */
    | { type: "run.progress"; run: RunProgressSnapshot }
  )

/** run 进度快照（RPC 传输形状；不含步骤 output——详情看 journal） */
export interface RunProgressSnapshot {
  runId: string
  workflow: { id: string; version: string }
  status: string
  startedAt: number
  completedAt?: number
  /** run 级失败摘要（截断 200 字符） */
  failure?: string
  /** P2-9 lineage：subflow 子 run 指回父 run；顶层 run 无 */
  parentRunId?: string
  /** P2-9 嵌套深度：顶层 0，subflow 子 run = 父 + 1 */
  depth?: number
  steps: Array<{
    index: number
    name?: string
    status: string
    startedAt?: number
    completedAt?: number
  }>
}

/** 派发用入参（无需填 time，emitEvent 自动补） */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type EventInput = DistributiveOmit<WorkflowEvent, "time">

export type EventHandler = (event: WorkflowEvent) => void

export interface EventBus {
  dispatch(event: WorkflowEvent): void
  /** 返回取消订阅函数 */
  subscribe(handler: EventHandler): () => void
}

/** 进程内同步 fan-out 事件总线（默认实现） */
export function createEventBus(): EventBus {
  const handlers = new Set<EventHandler>()
  return {
    dispatch(event: WorkflowEvent) {
      for (const handler of handlers) {
        try {
          handler(event)
        } catch (error) {
          // 监听器异常隔离：只记录，绝不影响 workflow
          console.log(
            `[agentic-workflow] event handler failed on ${event.type}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    },
    subscribe(handler: EventHandler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
  }
}

let currentBus: EventBus = createEventBus()

/** 替换全局 bus（测试/宿主注入） */
export function setEventBus(bus: EventBus): void {
  currentBus = bus
}

/** 当前全局 bus */
export function getEventBus(): EventBus {
  return currentBus
}

/** 派发事件（自动补 time） */
export function emitEvent(event: EventInput): void {
  currentBus.dispatch({ ...event, time: Date.now() } as WorkflowEvent)
}

/** prompt 摘要（事件保持小而可序列化） */
export function preview(text: string, max = 80): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`
}
