/**
 * SchedulerService（P2-7）：定时任务的核心编排（宿主无关）
 *
 * 职责：何时触发（cron slot + 游标去重）与记录生命周期；
 * 怎么执行（workflow 启动方式）经 TriggerFn 注入（插件侧接线
 * startWorkflowDetached + 单飞检查）。
 *
 * 触发语义（如实告知，全部写进工具描述）：
 *   - 游标基线 = 创建时刻的最近过去 slot：创建前的 slot 不补跑
 *     （要立刻跑用 runNow）
 *   - 宿主停机错过的 slot，重启后**合并为最近一个** slot 补跑一次
 *     （绝不按停机时长逐个补）
 *   - 单飞冲突（本进程已有 live run）：该 slot 记录 skipped 并消费——
 *     是跳过不是延迟
 *   - 调度器随宿主进程存活（timer unref，不阻止退出）
 *
 * 纪律：Core 侧模块，禁止 import OpenCode API（架构不变量）。
 */

import { latestSlot, nextRun, parseCron, type CronSpec } from "./cron.js"
import {
  appendRun,
  deleteSchedule as deleteScheduleFiles,
  getSchedule,
  listRuns,
  listSchedules,
  readCursor,
  saveSchedule,
  updateRun,
  writeCursor,
} from "./store.js"
import type { Schedule, ScheduleRun, ScheduleView } from "./types.js"

const ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** 触发器以此异常表示「本次跳过」（如单飞冲突）；其他异常 = failed */
export class ScheduleSkipError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "ScheduleSkipError"
  }
}

export interface TriggerResult {
  runId: string
  /** workflow 终态映射（completed→success / failed→failed / aborted→aborted） */
  completion: Promise<"success" | "failed" | "aborted">
}

/** 执行器注入：如何启动一次 workflow run（返回 runId + 终态 promise） */
export type TriggerFn = (schedule: Schedule, trigger: "scheduled" | "manual") => Promise<TriggerResult>

export interface SchedulerDeps {
  /** schedulesDir（绝对路径） */
  dir: string
  /** 时钟注入（测试用）；缺省真实时间 */
  now?: () => Date
  /** create 时校验 flow 存在（registry 查询） */
  flowExists: (flow: string) => boolean
  /** 已知 flow 清单（报错提示用） */
  knownFlows?: () => string[]
  /** 执行注入（插件侧接线 startWorkflowDetached） */
  trigger: TriggerFn
  /** tick 间隔 ms，默认 15000 */
  tickMs?: number
}

export interface CreateScheduleInput {
  id: string
  flow: string
  cron: string
  name?: string
  args?: Record<string, unknown>
  /** 缺省 true */
  enabled?: boolean
}

export class SchedulerService {
  private readonly deps: SchedulerDeps
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(deps: SchedulerDeps) {
    this.deps = deps
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }

  // ── 生命周期 ─────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return
    const tickMs = this.deps.tickMs ?? 15_000
    this.timer = setInterval(() => {
      // 目录被外部清理等场景下 tick 可能失败：接住并降级为单行日志，
      // 绝不让 rejection 逃逸成宿主侧 unhandled rejection 刷屏（坑I 实测）
      this.tick().catch((error) => {
        console.log(
          `[agentic-workflow] scheduler tick failed (dir ${this.deps.dir}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }, tickMs)
    // 不阻止宿主进程退出（调度器随宿主存活，进程退出即停）
    if (typeof this.timer.unref === "function") this.timer.unref()
    console.log(`[agentic-workflow] scheduler started (tick ${tickMs}ms, dir ${this.deps.dir})`)
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  // ── CRUD ─────────────────────────────────────────────────────────────

  async create(input: CreateScheduleInput): Promise<ScheduleView> {
    const { id, flow, cron } = input
    if (!ID_PATTERN.test(id)) {
      throw new Error(`schedule id 必须是 kebab-case（小写字母开头，含小写字母/数字/-），收到 "${id}"`)
    }
    const cronError = ((spec) => (typeof spec === "string" ? spec : null))(parseCron(cron))
    if (cronError) throw new Error(`INVALID_CRON：${cronError}`)
    if (!this.deps.flowExists(flow)) {
      const known = this.deps.knownFlows?.().join(", ") ?? "（无）"
      throw new Error(`FLOW_NOT_FOUND：未找到 flow "${flow}"（已知：${known}）`)
    }
    if (await getSchedule(this.deps.dir, id)) {
      throw new Error(`DUPLICATE：schedule "${id}" 已存在（改配置请先 delete 再 create，或用 enable/disable）`)
    }

    const nowIso = this.now().toISOString()
    const schedule: Schedule = {
      id,
      name: input.name,
      flow,
      cron,
      enabled: input.enabled ?? true,
      ...(input.args !== undefined ? { args: input.args } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    }
    await saveSchedule(this.deps.dir, schedule)

    // 游标基线 = 创建时刻的最近过去 slot：创建前的 slot 不补跑
    const spec = parseCron(cron) as CronSpec
    const cursor = await readCursor(this.deps.dir)
    cursor[id] = latestSlot(spec, this.now()).getTime()
    await writeCursor(this.deps.dir, cursor)

    return this.view(schedule)
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduleView> {
    const schedule = await this.require(id)
    schedule.enabled = enabled
    schedule.updatedAt = this.now().toISOString()
    await saveSchedule(this.deps.dir, schedule)
    return this.view(schedule)
  }

  async remove(id: string): Promise<void> {
    await this.require(id)
    await deleteScheduleFiles(this.deps.dir, id)
  }

  async list(): Promise<ScheduleView[]> {
    const schedules = await listSchedules(this.deps.dir)
    return Promise.all(schedules.map((s) => this.view(s)))
  }

  /** 详情：视图 + 最近触发记录（默认 10 条） */
  async detail(id: string, runLimit = 10): Promise<{ view: ScheduleView; runs: ScheduleRun[] }> {
    const schedule = await this.require(id)
    const runs = (await listRuns(this.deps.dir, id)).slice(0, runLimit)
    return { view: await this.view(schedule), runs }
  }

  private async require(id: string): Promise<Schedule> {
    const schedule = await getSchedule(this.deps.dir, id)
    if (!schedule) throw new Error(`NOT_FOUND：未找到 schedule "${id}"`)
    return schedule
  }

  private async view(schedule: Schedule): Promise<ScheduleView> {
    const spec = parseCron(schedule.cron)
    const runs = await listRuns(this.deps.dir, schedule.id)
    const last = runs[0]
    return {
      ...schedule,
      ...(last ? { lastRunAt: last.startedAt, lastRunStatus: last.status } : {}),
      ...(schedule.enabled && typeof spec === "object"
        ? { nextRunAt: nextRun(spec, this.now()).toISOString() }
        : {}),
    }
  }

  // ── 触发 ─────────────────────────────────────────────────────────────

  /** 手动立即触发（manual；不消费 cron 游标；单飞冲突照常 skip） */
  async runNow(id: string): Promise<ScheduleRun> {
    const schedule = await this.require(id)
    const now = this.now()
    return this.fire(schedule, "manual", now.getTime())
  }

  /** 一个 tick：消费到点 slot。返回本轮触发的 schedule id（可测/日志） */
  async tick(): Promise<string[]> {
    const now = this.now()
    const schedules = await listSchedules(this.deps.dir)
    const cursor = await readCursor(this.deps.dir)
    const fired: string[] = []

    for (const schedule of schedules) {
      if (!schedule.enabled) continue
      const spec = parseCron(schedule.cron)
      if (typeof spec === "string") {
        console.log(`[agentic-workflow] scheduler: schedule ${schedule.id} cron invalid, skipped: ${spec.split("\n")[0]}`)
        continue
      }
      const slot = latestSlot(spec, now).getTime()
      const consumed = cursor[schedule.id] ?? 0
      if (slot <= consumed) continue // 已消费（或基线之内）
      // 消费游标（含停机补跑合并：直接跳到最近 slot）后触发
      cursor[schedule.id] = slot
      await writeCursor(this.deps.dir, cursor)
      console.log(
        `[agentic-workflow] scheduler: ${schedule.id} due (slot ${new Date(slot).toISOString()})`,
      )
      await this.fire(schedule, "scheduled", slot)
      fired.push(schedule.id)
    }
    return fired
  }

  /** 触发一次：记录 running → 执行注入 → 终态回写。fire 不抛（异常进记录） */
  private async fire(
    schedule: Schedule,
    trigger: "scheduled" | "manual",
    slotEpoch: number,
  ): Promise<ScheduleRun> {
    const startedAt = new Date().toISOString()
    const record: ScheduleRun = {
      scheduleId: schedule.id,
      flow: schedule.flow,
      trigger,
      slot: new Date(slotEpoch).toISOString(),
      slotEpoch,
      status: "running",
      startedAt,
    }
    await appendRun(this.deps.dir, schedule.id, record)

    try {
      const started = await this.deps.trigger(schedule, trigger)
      record.workflowRunId = started.runId
      await updateRun(this.deps.dir, schedule.id, slotEpoch, trigger, { workflowRunId: started.runId })
      // 终态回写（detached completion；fire 自身不等待终态）
      void started.completion.then(
        (status) => {
          void updateRun(this.deps.dir, schedule.id, slotEpoch, trigger, {
            status,
            finishedAt: new Date().toISOString(),
          })
        },
        (error: unknown) => {
          void updateRun(this.deps.dir, schedule.id, slotEpoch, trigger, {
            status: "failed",
            finishedAt: new Date().toISOString(),
            note: error instanceof Error ? error.message : String(error),
          })
        },
      )
      return record
    } catch (error) {
      const skipped = error instanceof ScheduleSkipError
      const status = skipped ? "skipped" : "failed"
      const patch = {
        status,
        finishedAt: new Date().toISOString(),
        note: error instanceof Error ? error.message : String(error),
      } as const
      await updateRun(this.deps.dir, schedule.id, slotEpoch, trigger, patch)
      return { ...record, ...patch }
    }
  }
}
