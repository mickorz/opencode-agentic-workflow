/**
 * Workflow Progress RPC 契约（P2-8，server 与 TUI 双形态共享）
 *
 * 流向：
 *   server RunJournal 状态转换 -> emitEvent("run.progress") -> ProgressBoard
 *     --events.emit--> rpc.agentic-workflow-progress.progress { run 快照 }
 *   TUI 面板：
 *     <--call-- rpc "snapshot" -> { runs: [...] }（面板打开时初始同步）
 *     --事件--> 实时更新（全量快照，无需增量对账）
 *
 * 快照小而可序列化（不含步骤 output——详情看 journal 文件）。
 */

import { Rpc } from "@opencode/plugin/rpc"

import type { RunProgressSnapshot } from "../observability/events.js"
import type { RunDetail } from "../state/recorder.js"

/** run 快照 JSON Schema（event 载荷与 snapshot 方法输出条目共用） */
const runSnapshotSchema = {
  type: "object",
  properties: {
    runId: { type: "string" },
    workflow: {
      type: "object",
      properties: {
        id: { type: "string" },
        version: { type: "string" },
      },
      required: ["id", "version"],
      additionalProperties: false,
    },
    status: { type: "string" },
    startedAt: { type: "number" },
    completedAt: { type: "number" },
    failure: { type: "string" },
    parentRunId: { type: "string" },
    depth: { type: "number" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          name: { type: "string" },
          status: { type: "string" },
          startedAt: { type: "number" },
          completedAt: { type: "number" },
        },
        required: ["index", "status"],
      },
    },
  },
  required: ["runId", "workflow", "status", "startedAt", "steps"],
} as const

/** run 详情 JSON Schema（detail 方法输出；步骤载荷为预览化字符串） */
const runDetailSchema = {
  type: "object",
  properties: {
    runId: { type: "string" },
    workflow: {
      type: "object",
      properties: {
        id: { type: "string" },
        version: { type: "string" },
      },
      required: ["id", "version"],
      additionalProperties: false,
    },
    status: { type: "string" },
    startedAt: { type: "number" },
    completedAt: { type: "number" },
    failure: { type: "string" },
    parentRunId: { type: "string" },
    depth: { type: "number" },
    args: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" },
          name: { type: "string" },
          status: { type: "string" },
          startedAt: { type: "number" },
          completedAt: { type: "number" },
          input: { type: "string" },
          output: { type: "string" },
          error: { type: "string" },
          usage: {
            type: "object",
            properties: {
              input: { type: "number" },
              output: { type: "number" },
              reasoning: { type: "number" },
            },
            required: ["input", "output", "reasoning"],
            additionalProperties: false,
          },
          model: { type: "string" },
        },
        required: ["index", "status"],
      },
    },
  },
  required: ["runId", "workflow", "status", "startedAt", "steps"],
} as const

export const ProgressRpc = Rpc.define({
  id: "agentic-workflow-progress",
  methods: {
    /** TUI -> server：拉取当前 board（面板打开时初始同步） */
    snapshot: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          runs: { type: "array", items: runSnapshotSchema },
        },
        required: ["runs"],
        additionalProperties: false,
      },
    },
    /** TUI -> server：单个 run 的节点详情（journal 单读，载荷为预览） */
    detail: {
      input: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          run: { oneOf: [runDetailSchema, { type: "null" }] },
        },
        required: ["run"],
        additionalProperties: false,
      },
    },
  },
  events: {
    /** server -> TUI：run 全量快照 */
    progress: { schema: runSnapshotSchema },
  },
})

/** TUI 订阅用事件名（字面量类型；与 ProgressRpc.id 的一致性由单测保证） */
export const PROGRESS_EVENT = "rpc.agentic-workflow-progress.progress" as const

/** 收窄事件/方法载荷为快照（事件 data 为 unknown 形状）；不合法返回 undefined */
export function parseRunSnapshot(data: unknown): RunProgressSnapshot | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const record = data as {
    runId?: unknown
    workflow?: unknown
    status?: unknown
    startedAt?: unknown
    steps?: unknown
  }
  if (typeof record.runId !== "string") return undefined
  if (typeof record.status !== "string") return undefined
  if (typeof record.startedAt !== "number") return undefined
  if (!Array.isArray(record.steps)) return undefined
  const workflow = record.workflow as { id?: unknown; version?: unknown } | undefined
  if (
    typeof workflow !== "object" ||
    workflow === null ||
    typeof workflow.id !== "string" ||
    typeof workflow.version !== "string"
  ) {
    return undefined
  }
  for (const step of record.steps) {
    if (typeof step !== "object" || step === null) return undefined
    const s = step as { index?: unknown; status?: unknown }
    if (typeof s.index !== "number" || typeof s.status !== "string") return undefined
  }
  return data as RunProgressSnapshot
}

/** 收窄 snapshot 方法输出为快照数组；不合法整体丢弃（面板回退到空态） */
export function parseRunSnapshotList(data: unknown): RunProgressSnapshot[] {
  if (typeof data !== "object" || data === null) return []
  const runs = (data as { runs?: unknown }).runs
  if (!Array.isArray(runs)) return []
  const parsed = runs.map(parseRunSnapshot).filter((s) => s !== undefined)
  return parsed.filter((s): s is RunProgressSnapshot => s !== undefined)
}

/** 收窄 detail 方法入参为 runId；不合法（缺/非串）返回 undefined */
export function parseRunDetailRequest(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const runId = (data as { runId?: unknown }).runId
  return typeof runId === "string" ? runId : undefined
}

/** 收窄 detail 方法输出为详情；null（run 不存在/无 journal）或不合法返回 undefined */
export function parseRunDetail(data: unknown): RunDetail | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const record = data as { run?: unknown }
  if (record.run === null) return undefined
  const run = record.run
  if (typeof run !== "object" || run === null) return undefined
  const detail = run as {
    runId?: unknown
    workflow?: unknown
    status?: unknown
    startedAt?: unknown
    steps?: unknown
  }
  if (typeof detail.runId !== "string") return undefined
  if (typeof detail.status !== "string") return undefined
  if (typeof detail.startedAt !== "number") return undefined
  if (!Array.isArray(detail.steps)) return undefined
  const workflow = detail.workflow as { id?: unknown; version?: unknown } | undefined
  if (
    typeof workflow !== "object" ||
    workflow === null ||
    typeof workflow.id !== "string" ||
    typeof workflow.version !== "string"
  ) {
    return undefined
  }
  for (const step of detail.steps) {
    if (typeof step !== "object" || step === null) return undefined
    const s = step as { index?: unknown; status?: unknown }
    if (typeof s.index !== "number" || typeof s.status !== "string") return undefined
  }
  return run as RunDetail
}
