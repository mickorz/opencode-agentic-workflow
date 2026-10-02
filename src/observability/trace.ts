/**
 * Execution Trace（P2.4）
 *
 * - createTraceCollector: 订阅 bus，收集事件流为内存数组（debug/断言/测试）
 * - createFileTraceSink: 订阅 bus，逐事件追加 JSONL 文件（持久化观测）
 *
 * 事件已保证 JSON-safe（见 events.ts），可直接序列化。
 */

import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"

import { getEventBus, type EventBus, type WorkflowEvent } from "./events.js"

export interface TraceCollector {
  /** 收集到的事件快照（只读） */
  readonly events: readonly WorkflowEvent[]
  /** 停止收集 */
  stop(): void
}

/** 内存 trace 收集器（测试/调试用） */
export function createTraceCollector(bus?: EventBus): TraceCollector {
  const events: WorkflowEvent[] = []
  const off = (bus ?? getEventBus()).subscribe((event) => {
    events.push(event)
  })
  return {
    get events() {
      return events
    },
    stop: off,
  }
}

export interface TraceSink {
  /** 停止订阅并落盘收尾 */
  stop(): void
}

/**
 * JSONL 文件 trace sink：每事件一行追加写入。
 * 写失败只记录（观测链路绝不影响 workflow 主链路）。
 */
export function createFileTraceSink(file: string, bus?: EventBus): TraceSink {
  const target = bus ?? getEventBus()
  let directory = path.dirname(file)
  let pending: Promise<void> = Promise.resolve()

  const off = target.subscribe((event) => {
    // 串行化追加，避免行交错
    pending = pending
      .then(async () => {
        await mkdir(directory, { recursive: true })
        await appendFile(file, JSON.stringify(event) + "\n", "utf8")
      })
      .catch((error: unknown) => {
        console.log(
          `[agentic-workflow] trace sink write failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
      })
  })

  return {
    stop() {
      off()
      directory = directory // no-op，保持引用形状稳定
    },
  }
}
