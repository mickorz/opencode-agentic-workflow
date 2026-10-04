// cron 子集校验与 slot 计算（P2-7，v1-parity；零依赖实现）
//
// 支持的四模式（与 v1 同子集——覆盖定时场景的第一版全部需求）：
//   每分钟 / 每 n 分钟    `* * * * *` / 分钟字段 星杠n（n 1-59）
//   每小时 m 分           `m * * * *`
//   每天 h 点 m 分        `m h * * *`
//   每周 W 的 h 点 m 分   `m h * * W`（W = 0-6 单值或逗号列表，0=周日）
//
// slot 计算：本地时区闭式数学（v1 用 cron-parser；v2 零依赖手写）。
// DST 切换日的 slot 可能与墙钟偏差 1 小时（诚实边界，对分钟级/小时级
// 场景无实质影响）。同一表达式各次计算确定一致。
//
// 纪律：Core 侧模块，禁止 import OpenCode API（架构不变量）。

export type CronSpec =
  | { kind: "minutes"; step: number }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; minute: number; hour: number }
  | { kind: "weekly"; minute: number; hour: number; days: number[] }

const EVERY_MINUTES = /^(\*\/(\d{1,2})|\*) \* \* \* \*$/
const HOURLY = /^(\d{1,2}) \* \* \* \*$/
const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/
const WEEKLY = /^(\d{1,2}) (\d{1,2}) \* \* (\d(?:,\d)*)$/

const FORMAT_HELP = [
  '不支持的 cron 表达式 "${expr}"。仅支持四种模式：',
  "  * * * * *    每分钟；*/n * * * * 每 n 分钟（n 1-59，如 */5 每 5 分钟）",
  "  m * * * *   每小时 m 分（如 30 * * * * 每小时半点）",
  "  m h * * *   每天 h 点 m 分（如 0 9 * * * 每天 9 点）",
  "  m h * * W   每周 W 的 h 点 m 分（W 0-6，0=周日；如 0 10 * * 1 每周一 10 点）",
].join("\n")

/**
 * 校验并解析 cron 表达式。
 * 合法返回 CronSpec；非法返回错误信息（含格式说明，可直接展示）。
 */
export function parseCron(expr: string): CronSpec | string {
  const text = expr.trim()
  if (text.length === 0) {
    return 'cron 表达式为空（支持格式见下）\n' + FORMAT_HELP.replace("${expr}", expr)
  }

  let m = EVERY_MINUTES.exec(text)
  if (m) {
    const step = m[2] === undefined ? 1 : Number(m[2]) // 裸 "*" 等价 */1
    if (step < 1 || step > 59) return `每分钟模式的步长需在 1-59 之间，收到 ${step}`
    return { kind: "minutes", step }
  }
  m = HOURLY.exec(text)
  if (m) {
    const minute = Number(m[1])
    if (minute > 59) return `分钟需在 0-59 之间，收到 ${minute}`
    return { kind: "hourly", minute }
  }
  m = DAILY.exec(text)
  if (m) {
    const minute = Number(m[1])
    const hour = Number(m[2])
    if (minute > 59) return `分钟需在 0-59 之间，收到 ${minute}`
    if (hour > 23) return `小时需在 0-23 之间，收到 ${hour}`
    return { kind: "daily", minute, hour }
  }
  m = WEEKLY.exec(text)
  if (m) {
    const minute = Number(m[1])
    const hour = Number(m[2])
    if (minute > 59) return `分钟需在 0-59 之间，收到 ${minute}`
    if (hour > 23) return `小时需在 0-23 之间，收到 ${hour}`
    const days = m[3]!.split(",").map(Number)
    for (const day of days) {
      if (day > 6) return `星期需在 0-6 之间（0=周日），收到 ${day}`
    }
    return { kind: "weekly", minute, hour, days }
  }

  return FORMAT_HELP.replace("${expr}", expr)
}

export function validateCron(expr: string): string | null {
  const parsed = parseCron(expr)
  return typeof parsed === "string" ? parsed : null
}

/** 把时间截到分钟（秒/毫秒归零） */
function zeroToMinute(date: Date): Date {
  const d = new Date(date.getTime())
  d.setSeconds(0, 0)
  return d
}

/** 严格晚于 after 的第一个候选（分钟对齐）；先保证 > after 再按谓词推进 */
function firstCandidate(after: Date): Date {
  let t = zeroToMinute(new Date(after.getTime() + 1))
  while (t.getTime() <= after.getTime()) {
    t = new Date(t.getTime() + 60_000)
  }
  return t
}

/**
 * after 之后的下一个未来 slot（严格晚于 after）。
 * 已通过校验的 spec 才可调用（parseCron 返回 CronSpec）。
 */
export function nextRun(spec: CronSpec, after: Date): Date {
  let t = firstCandidate(after)
  switch (spec.kind) {
    case "minutes": {
      // 分钟 0 恒满足（0 % n === 0），60 分钟内必命中
      for (let i = 0; i < 60 && t.getMinutes() % spec.step !== 0; i++) {
        t = new Date(t.getTime() + 60_000)
      }
      return t
    }
    case "hourly": {
      t.setMinutes(spec.minute)
      if (t.getTime() <= after.getTime()) t = new Date(t.getTime() + 3_600_000)
      t.setMinutes(spec.minute) // 跨小时后再对齐分钟（+1h 保持分钟不变，此行防御 DST 偏移）
      return t
    }
    case "daily": {
      t.setHours(spec.hour, spec.minute, 0, 0)
      if (t.getTime() <= after.getTime()) t = new Date(t.getTime() + 86_400_000)
      t.setHours(spec.hour, spec.minute, 0, 0)
      return t
    }
    case "weekly": {
      t.setHours(spec.hour, spec.minute, 0, 0)
      if (t.getTime() <= after.getTime()) t = new Date(t.getTime() + 86_400_000)
      t.setHours(spec.hour, spec.minute, 0, 0)
      for (let i = 0; i < 7 && !spec.days.includes(t.getDay()); i++) {
        t = new Date(t.getTime() + 86_400_000)
        t.setHours(spec.hour, spec.minute, 0, 0)
      }
      return t
    }
  }
}

/** now 之前（含恰好等于）最近的一个过去 slot */
export function latestSlot(spec: CronSpec, now: Date): Date {
  let t = zeroToMinute(now)
  switch (spec.kind) {
    case "minutes": {
      for (let i = 0; i < 60 && t.getMinutes() % spec.step !== 0; i++) {
        t = new Date(t.getTime() - 60_000)
      }
      return t
    }
    case "hourly": {
      t.setMinutes(spec.minute)
      if (t.getTime() > now.getTime()) t = new Date(t.getTime() - 3_600_000)
      t.setMinutes(spec.minute)
      return t
    }
    case "daily": {
      t.setHours(spec.hour, spec.minute, 0, 0)
      if (t.getTime() > now.getTime()) t = new Date(t.getTime() - 86_400_000)
      t.setHours(spec.hour, spec.minute, 0, 0)
      return t
    }
    case "weekly": {
      t.setHours(spec.hour, spec.minute, 0, 0)
      if (t.getTime() > now.getTime()) t = new Date(t.getTime() - 86_400_000)
      t.setHours(spec.hour, spec.minute, 0, 0)
      for (let i = 0; i < 7 && !spec.days.includes(t.getDay()); i++) {
        t = new Date(t.getTime() - 86_400_000)
        t.setHours(spec.hour, spec.minute, 0, 0)
      }
      return t
    }
  }
}
