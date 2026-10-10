/**
 * ProgressBoard —— server 侧运行看板（P2-8 TUI 进度树数据面）
 *
 * 职责：
 *   - 订阅核心事件总线的 run.progress（RunJournal 每次状态转换的全量快照）
 *   - 维护近期 run 快照（runId 去重、newest first、容量上限）
 *   - 每次更新转发为 RPC 事件（TUI 面板实时消费）；无 TUI 监听时成本可忽略
 *   - snapshot 方法返回当前板（面板打开时初始同步）
 *
 * 快照即真相：不做增量对账——单飞语义下（每进程同时至多一个 run），
 * 全量快照流天然有序；历史 run 以 store 种子补齐。
 *
 * 依赖全部注入（subscribe/emit/store），单测用 fake 即可覆盖。
 */

import type { Plugin } from "@opencode/plugin"

import {
  getEventBus,
  type EventBus,
  type RunProgressSnapshot,
  type WorkflowEvent,
} from "../observability/events.js"
import type { ExecutionStore } from "../state/store.js"
import { toProgressSnapshot, toRunDetail } from "../state/recorder.js"
import {
  ProgressRpc,
  parseRunDetailRequest,
  parseSessionReplayRequest,
  type SessionReplayMessage,
} from "./progress-rpc.js"

type RpcDomain = Plugin.Context["rpc"]

/** 回放消息的展示上限（防大对话刷爆面板/RPC 载荷） */
const REPLAY_MESSAGE_LIMIT = 50
/** 单条消息文本预览上限 */
const REPLAY_TEXT_LIMIT = 800

/** bind() 返回的注册句柄（按 ProgressRpc 定义收窄的最小结构） */
interface ProgressRegistration {
  events: {
    emit: (name: "progress", data: Record<string, unknown>) => Promise<void>
  }
}

export interface ProgressBoardOptions {
  /** 近期 run 保留上限（默认 20） */
  capacity?: number
  /** 顶层终态 run 保留条数（默认 3）：更旧的连同子树淘汰，防面板随会话
   *  历史无限堆积；运行中 run 及其 subflow 子树不受影响 */
  keepTerminal?: number
  /** 事件总线（默认全局 bus；测试注入） */
  bus?: EventBus
  /** 初始种子（bind 时由 store 读出） */
  seed?: readonly RunProgressSnapshot[]
}

export class ProgressBoard {
  private readonly runs = new Map<string, RunProgressSnapshot>()
  private readonly order: string[] = []
  private readonly capacity: number
  private readonly keepTerminal: number
  private unsubscribe: (() => void) | undefined

  constructor(
    private readonly emit: (run: RunProgressSnapshot) => void,
    options?: ProgressBoardOptions,
  ) {
    this.capacity = options?.capacity ?? 20
    this.keepTerminal = options?.keepTerminal ?? 3
    for (const run of options?.seed ?? []) {
      this.apply(run, { forward: false })
    }
    this.unsubscribe = (options?.bus ?? getEventBus()).subscribe((event) => {
      this.onEvent(event)
    })
  }

  /** 核心事件入口（仅消费 run.progress） */
  onEvent(event: WorkflowEvent): void {
    if (event.type !== "run.progress") return
    this.apply(event.run, { forward: true })
  }

  /**
   * 应用一个快照：runId 去重、维持 newest-first、容量淘汰。
   * forward=false 用于种子（不回发 RPC——面板尚未订阅，快照方法自会读到）。
   */
  apply(run: RunProgressSnapshot, options?: { forward?: boolean }): void {
    const forward = options?.forward ?? true
    if (!this.runs.has(run.runId)) {
      this.order.unshift(run.runId)
    }
    this.runs.set(run.runId, run)
    // 重新按开始时间排序（runId 重复应用时保持位置稳定即可）
    this.order.sort((a, b) => {
      const ra = this.runs.get(a)
      const rb = this.runs.get(b)
      const sa = ra?.startedAt ?? 0
      const sb = rb?.startedAt ?? 0
      return sb - sa
    })
    while (this.order.length > this.capacity) {
      const evicted = this.order.pop()
      if (evicted !== undefined) this.runs.delete(evicted)
    }
    this.trimTerminal()
    if (forward) {
      this.emit(run)
    }
  }

  /**
   * 终态瘦身（v0.8.5）：顶层终态 run 只保留最新 keepTerminal 条，更旧的
   * 连同其 subflow 子树一起淘汰——面板不随会话历史无限堆积。运行中 run
   * 及其子孙不受影响；孤儿（parentRunId 指向不在板上的 run）按顶层计。
   */
  private trimTerminal(): void {
    // 自旧向新收集顶层终态 run（order 为 newest first，自尾向头遍历）
    const terminalTop: string[] = []
    for (let i = this.order.length - 1; i >= 0; i--) {
      const id = this.order[i]!
      const run = this.runs.get(id)
      if (run === undefined) continue
      if (run.parentRunId !== undefined && this.runs.has(run.parentRunId)) continue
      if (run.status === "running") continue
      terminalTop.push(id)
    }
    const surplus = Math.max(0, terminalTop.length - this.keepTerminal)
    if (surplus === 0) return
    const doomed = new Set(terminalTop.slice(0, surplus))
    // 子树传染（防御：运行中的子孙不淘汰，宁可留成孤儿也不清跑态）
    let grew = true
    while (grew) {
      grew = false
      for (const [cid, crun] of this.runs) {
        if (doomed.has(cid) || crun.status === "running") continue
        if (crun.parentRunId !== undefined && doomed.has(crun.parentRunId)) {
          doomed.add(cid)
          grew = true
        }
      }
    }
    for (let i = this.order.length - 1; i >= 0; i--) {
      const id = this.order[i]!
      if (doomed.has(id)) {
        this.order.splice(i, 1)
        this.runs.delete(id)
      }
    }
  }

  /** 当前板（newest first；snapshot 方法与测试用） */
  list(): readonly RunProgressSnapshot[] {
    const out: RunProgressSnapshot[] = []
    for (const runId of this.order) {
      const run = this.runs.get(runId)
      if (run) out.push(run)
    }
    return out
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }
}

/**
 * 插件装配：注册 ProgressRpc（snapshot/detail/session 方法）+ 订阅事件总线
 * + store 种子。返回 board（持有者可 dispose；插件生命周期内常驻）。
 */
export async function bindProgressBoard(deps: {
  rpc: RpcDomain
  store?: ExecutionStore
  /**
   * Open Session 回放数据源：宿主会话消息拉取（ctx.session.context 映射）。
   * 缺席时 session 方法统一回 null（旧 server 行为，面板静默降级）。
   */
  fetchSessionMessages?: (sessionID: string) => Promise<SessionReplayMessage[]>
  options?: ProgressBoardOptions
}): Promise<ProgressBoard> {
  let board: ProgressBoard | undefined
  const registration: ProgressRegistration = await deps.rpc.register(ProgressRpc, {
    snapshot: async () => ({ runs: board ? board.list().slice() : [] }),
    // journal 单读（无 journalDir 配置 -> store 缺席 -> null；面板不渲染详情区）
    detail: async (input: unknown) => {
      const runId = parseRunDetailRequest(input)
      if (!deps.store || runId === undefined) return { run: null }
      const run = await deps.store.getRun(runId)
      return { run: run ? toRunDetail(run) : null }
    },
    // Open Session 回放：journal 定位步骤会话 -> 宿主拉取 -> 预览截断
    session: async (input: unknown) => {
      const request = parseSessionReplayRequest(input)
      if (!deps.store || !deps.fetchSessionMessages || request === undefined) {
        return { session: null }
      }
      const run = await deps.store.getRun(request.runId)
      const step = run?.steps.find(
        (s) => s.name === request.step && s.sessionIDs !== undefined && s.sessionIDs.length > 0,
      )
      const sessionIDs = step?.sessionIDs
      if (!sessionIDs) return { session: null }
      const sessionID =
        request.index !== undefined
          ? (sessionIDs[request.index] ?? sessionIDs[sessionIDs.length - 1]!)
          : sessionIDs[sessionIDs.length - 1]!
      const messages = await deps.fetchSessionMessages(sessionID)
      return {
        session: {
          sessionID,
          step: request.step,
          messages: messages
            .slice(0, REPLAY_MESSAGE_LIMIT)
            .map((message) => ({ ...message, text: message.text.slice(0, REPLAY_TEXT_LIMIT) })),
        },
      }
    },
  })
  // store 种子（v0.8.4）：只播种非终态 run——上次被中断的才值得在启动时
  // 浮现（可续跑）；终态 run 不再占版面（面板历史残留的治理）
  let seed: RunProgressSnapshot[] | undefined
  if (deps.store) {
    seed = await seedFromStore(deps.store, deps.options?.capacity ?? 20)
  }
  board = new ProgressBoard(
    (run) => {
      void registration.events.emit("progress", run as unknown as Record<string, unknown>).catch(
        (error) => {
          // 转发失败绝不影响 workflow（事件总线隔离原则的同款纪律）
          console.log(
            `[agentic-workflow] progress emit failed (runId=${run.runId}): ` +
              `${error instanceof Error ? error.message : String(error)}`,
          )
        },
      )
    },
    { ...deps.options, ...(seed ? { seed } : {}) },
  )
  return board
}

/** store 里的近期 run -> 快照种子（newest first，容量截断）
 *
 * v0.8.4 起只播种**非终态** run（进程退出时卡在 running 的被中断 run）：
 * 启动面板保持干净，只浮现「上次没跑完、值得处理」的；completed /
 * failed / aborted 不再上启动面板（failed 仍可用 resumeRunId 续跑，
 * 只是不占版面——见 recorder.reopen 的可续跑状态集）。
 */
export async function seedFromStore(
  store: ExecutionStore,
  capacity = 20,
): Promise<RunProgressSnapshot[]> {
  const runs = await store.listRuns()
  return runs
    .filter((run) => run.status === "running")
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, capacity)
    .map(toProgressSnapshot)
}
