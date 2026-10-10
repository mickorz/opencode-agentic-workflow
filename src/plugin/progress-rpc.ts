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
          attempt: { type: "number" },
          attemptsMax: { type: "number" },
          timeoutMs: { type: "number" },
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
          sessionIDs: { type: "array", items: { type: "string" } },
          attempt: { type: "number" },
          attemptsMax: { type: "number" },
          timeoutMs: { type: "number" },
        },
        required: ["index", "status"],
      },
    },
  },
  required: ["runId", "workflow", "status", "startedAt", "steps"],
} as const

/** 会话回放条目（session 方法输出；文本预览化，面板/工具侧消费） */
export interface SessionReplayMessage {
  /** 宿主消息类型（user / assistant …） */
  type: string
  /** 文本内容（多 text part 合并，预览截断） */
  text: string
}

export interface SessionReplay {
  /** 会话 ID（回放来源；null = 找不到会话） */
  sessionID: string
  /** 所属步骤名（journal 定位用） */
  step?: string
  /** 对话消息（时间顺序；条数与单条长度均截断） */
  messages: SessionReplayMessage[]
}

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
    /**
     * TUI -> server：Open Session 回放——按 runId + 步骤名取该步骤子会话的
     * 完整对话（文本预览）。index 选多会话步骤（pipeline）的第几个，缺省最后。
     */
    session: {
      input: {
        type: "object",
        properties: {
          runId: { type: "string" },
          step: { type: "string" },
          index: { type: "number" },
        },
        required: ["runId", "step"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          session: {
            oneOf: [
              {
                type: "object",
                properties: {
                  sessionID: { type: "string" },
                  step: { type: "string" },
                  messages: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        type: { type: "string" },
                        text: { type: "string" },
                      },
                      required: ["type", "text"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["sessionID", "messages"],
                additionalProperties: false,
              },
              { type: "null" },
            ],
          },
        },
        required: ["session"],
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

/** 收窄 session 方法入参；不合法返回 undefined */
export function parseSessionReplayRequest(
  data: unknown,
): { runId: string; step: string; index?: number } | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const req = data as { runId?: unknown; step?: unknown; index?: unknown }
  if (typeof req.runId !== "string" || typeof req.step !== "string") return undefined
  return {
    runId: req.runId,
    step: req.step,
    ...(typeof req.index === "number" ? { index: req.index } : {}),
  }
}

/** 收窄 session 方法输出；不合法返回 undefined */
export function parseSessionReplay(data: unknown): SessionReplay | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const out = data as { session?: unknown }
  if (typeof out.session !== "object" || out.session === null) return undefined
  const session = out.session as { sessionID?: unknown; step?: unknown; messages?: unknown }
  if (typeof session.sessionID !== "string" || !Array.isArray(session.messages)) return undefined
  const messages: SessionReplayMessage[] = []
  for (const message of session.messages) {
    if (typeof message !== "object" || message === null) return undefined
    const m = message as { type?: unknown; text?: unknown }
    if (typeof m.type !== "string" || typeof m.text !== "string") return undefined
    messages.push({ type: m.type, text: m.text })
  }
  return {
    sessionID: session.sessionID,
    ...(typeof session.step === "string" ? { step: session.step } : {}),
    messages,
  }
}
