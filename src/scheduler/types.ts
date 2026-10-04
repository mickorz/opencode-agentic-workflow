/**
 * Schedule 领域类型（P2-7）
 *
 * 对象关系（对齐 v1 的职责分离）：
 *   Schedule   = 用户配置（schedulesDir/<id>.json，工具管理，纯配置）
 *   .cursor    = 触发游标（schedulesDir/.cursor.json：id -> 已消费的 slot epoch ms）
 *   ScheduleRun = 一次触发的记录（schedulesDir/runs/<id>.json，上限保留 50 条）
 *
 * 纪律：Core 侧模块，禁止 import OpenCode API（架构不变量）。
 */

/** 定时任务配置（纯配置；enabled/args 可由工具改写） */
export interface Schedule {
  /** kebab-case；工具操作与记录文件的寻址键 */
  id: string
  /** 展示名；缺省用 flow */
  name?: string
  /** workflow id（内置或 workflow_define 定义的自定义流程） */
  flow: string
  /** 四模式 cron 子集（本地时区；见 cron.ts） */
  cron: string
  enabled: boolean
  /** 透传给 workflow 的 args（含 topic） */
  args?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/** 一次触发的记录（scheduled 到点 / manual 手动 runNow） */
export type ScheduleRunStatus =
  | "running" // 已触发、workflow 执行中
  | "success" // workflow completed
  | "failed" // 启动失败或 workflow failed
  | "aborted" // workflow 被协作式停止
  | "skipped" // 未启动（单飞冲突等），slot 已消费

export interface ScheduleRun {
  scheduleId: string
  flow: string
  /** workflow runId（journal 对齐；skipped 时无） */
  workflowRunId?: string
  /** 触发来源：scheduled（到点）/ manual（runNow） */
  trigger: "scheduled" | "manual"
  /** 触发的时间槽 ISO（manual = 实际触发时刻） */
  slot: string
  /** slot epoch 毫秒（排序/去重键） */
  slotEpoch: number
  status: ScheduleRunStatus
  startedAt: string
  finishedAt?: string
  /** skipped 原因 / failed 错误摘要 */
  note?: string
}

/** list/get 聚合视图 */
export interface ScheduleView extends Schedule {
  /** 最近一次记录（各状态含 skipped） */
  lastRunAt?: string
  lastRunStatus?: ScheduleRunStatus
  /** 下一个未来 slot（本地时区 ISO；disabled 不算） */
  nextRunAt?: string
}
