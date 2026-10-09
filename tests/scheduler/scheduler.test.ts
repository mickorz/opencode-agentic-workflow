/**
 * P2-7 定时任务子系统 单测
 * 覆盖：cron 四模式校验与 slot 数学（严格晚于边界）/ store CRUD+游标+记录上限 /
 *       service 创建基线、到点触发一次、停机合并补跑、单飞 skip、runNow、
 *       disable 停触、delete 清理 / anyLive
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  latestSlot,
  nextRun,
  parseCron,
  validateCron,
  type CronSpec,
} from "../../src/scheduler/cron.js"
import {
  appendRun,
  deleteSchedule,
  getSchedule,
  listRuns,
  listSchedules,
  readCursor,
  saveSchedule,
  updateRun,
} from "../../src/scheduler/store.js"
import { SchedulerService, ScheduleSkipError } from "../../src/scheduler/service.js"
import { anyLive, markLive, clearLive } from "../../src/registry/run-control.js"

function spec(cron: string): CronSpec {
  const parsed = parseCron(cron)
  assert.ok(typeof parsed === "object", `cron "${cron}" 应合法`)
  return parsed
}

// ── cron ───────────────────────────────────────────────────────────────

test("cron 校验：四模式合法", () => {
  for (const expr of ["* * * * *", "*/5 * * * *", "30 * * * *", "0 9 * * *", "0 10 * * 1", "15 8 * * 0,3,5"]) {
    assert.equal(validateCron(expr), null, expr)
  }
})

test("cron 校验：非法表达式逐一指名（步长/范围/不支持的形状）", () => {
  assert.match(validateCron("*/60 * * * *")!, /步长需在 1-59/)
  assert.match(validateCron("60 * * * *")!, /分钟需在 0-59/)
  assert.match(validateCron("0 24 * * *")!, /小时需在 0-23/)
  assert.match(validateCron("0 9 * * 7")!, /星期需在 0-6/)
  assert.match(validateCron("0 9 1 * *")!, /不支持的 cron 表达式/)
  assert.match(validateCron("junk")!, /不支持的 cron 表达式/)
  assert.match(validateCron("")!, /为空/)
})

test("cron nextRun：严格晚于 after；每 n 分钟模式对齐", () => {
  // 每 5 分钟：10:33 -> 10:35；恰在 slot 上（10:30:00）-> 下一个是 10:35（严格晚于）
  const s = spec("*/5 * * * *")
  assert.equal(
    nextRun(s, new Date(2026, 5, 15, 10, 33, 12)).toISOString(),
    new Date(2026, 5, 15, 10, 35).toISOString(),
  )
  assert.equal(
    nextRun(s, new Date(2026, 5, 15, 10, 30, 0)).toISOString(),
    new Date(2026, 5, 15, 10, 35).toISOString(),
  )
})

test("cron nextRun/latestSlot：每小时 / 每天 / 每周模式", () => {
  const now = new Date(2026, 5, 15, 10, 33, 0) // 2026-06-15 周一 10:33
  const hourly = spec("30 * * * *")
  assert.equal(nextRun(hourly, now).getHours(), 11) // 10:30 已过 -> 11:30
  assert.equal(latestSlot(hourly, now).getHours(), 10)

  const daily = spec("0 9 * * *")
  assert.equal(nextRun(daily, now).getDate(), 16) // 今天 9 点已过 -> 明天
  assert.equal(latestSlot(daily, now).getDate(), 15)

  const weeklyExpr = "0 10 * * 1"
  const w = spec(weeklyExpr) // 每周一 10:00
  assert.equal(nextRun(w, now).getDate(), 22) // 本周一 10 点已过 -> 下周一
  assert.equal(latestSlot(w, now).getDate(), 15) // 最近过去 slot = 今天 10:00
})

test("cron latestSlot：每 n 分钟的最近对齐点", () => {
  const s = spec("*/15 * * * *")
  const now = new Date(2026, 5, 15, 10, 37, 0)
  const slot = latestSlot(s, now)
  assert.equal(`${slot.getHours()}:${slot.getMinutes()}`, "10:30")
})

// ── store ──────────────────────────────────────────────────────────────

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "agw-sched-"))
}

function scheduleFixture(id: string, overrides: Partial<{ flow: string; cron: string; enabled: boolean }> = {}) {
  return {
    id,
    flow: overrides.flow ?? "smoke",
    cron: overrides.cron ?? "*/5 * * * *",
    enabled: overrides.enabled ?? true,
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...overrides,
  }
}

test("store：save/list/get/delete + 游标 + 记录追加上限", async () => {
  const dir = await tempDir()
  await saveSchedule(dir, scheduleFixture("alpha"))
  await saveSchedule(dir, scheduleFixture("beta"))
  assert.deepEqual((await listSchedules(dir)).map((s) => s.id), ["alpha", "beta"])
  assert.equal((await getSchedule(dir, "alpha"))?.flow, "smoke")
  assert.equal(await getSchedule(dir, "nope"), undefined)

  await updateRun(dir, "alpha", 1000, "scheduled", { status: "skipped", note: "busy" })
  const runs0 = await listRuns(dir, "alpha")
  // updateRun 只改已有记录；没有 append 过则不改（返回 undefined）
  assert.equal(runs0.length, 0)

  for (let i = 0; i < 55; i++) {
    await appendRun(dir, "alpha", {
      scheduleId: "alpha",
      flow: "smoke",
      trigger: "scheduled",
      slot: new Date(i * 60000).toISOString(),
      slotEpoch: i * 60000,
      status: "success",
      startedAt: new Date(i * 60000).toISOString(),
    })
  }
  const runs = await listRuns(dir, "alpha")
  assert.equal(runs.length, 50) // 上限截断
  assert.equal(runs[0]?.slotEpoch, 54 * 60000) // 新的在前
  assert.equal(runs[49]?.slotEpoch, 5 * 60000)

  await deleteSchedule(dir, "alpha")
  assert.equal(await getSchedule(dir, "alpha"), undefined)
  assert.deepEqual(await listRuns(dir, "alpha"), [])
})

// ── service ────────────────────────────────────────────────────────────

interface Fired {
  scheduleId: string
  trigger: "scheduled" | "manual"
  resolve: (status: "success" | "failed" | "aborted") => void
}

/** 受控 trigger：记录调用并可手动落定终态 */
function makeHarness(dir: string, startAt: Date) {
  const fired: Fired[] = []
  let clock = new Date(startAt.getTime())
  const service = new SchedulerService({
    dir,
    now: () => new Date(clock.getTime()),
    flowExists: (flow) => ["smoke", "digest"].includes(flow),
    knownFlows: () => ["smoke", "digest"],
    trigger: async (schedule, trigger) => {
      let resolve!: (status: "success" | "failed" | "aborted") => void
      const completion = new Promise<"success" | "failed" | "aborted">((r) => {
        resolve = r
      })
      fired.push({ scheduleId: schedule.id, trigger, resolve })
      return { runId: `run-${fired.length}`, completion }
    },
  })
  return {
    service,
    fired,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
    now: () => new Date(clock.getTime()),
  }
}

test("service create：游标基线 = 最近过去 slot（创建前不补跑）", async () => {
  const dir = await tempDir()
  const h = makeHarness(dir, new Date(2026, 5, 15, 10, 33, 0))
  const view = await h.service.create({ id: "a", flow: "smoke", cron: "*/5 * * * *", args: { topic: "T" } })
  assert.equal(view.enabled, true)
  assert.equal(view.nextRunAt, new Date(2026, 5, 15, 10, 35).toISOString())

  // 10:35 前后 tick：10:35 恰好为最近 slot（含等于）-> 触发
  assert.deepEqual(await h.service.tick(), []) // 10:33 无到期
  h.advance(2 * 60_000) // 10:35
  assert.deepEqual(await h.service.tick(), ["a"])
  assert.equal(h.fired.length, 1)
  // 同一 slot 不重复触发
  assert.deepEqual(await h.service.tick(), [])
  h.advance(60_000) // 10:36（下一个 slot 10:40）
  assert.deepEqual(await h.service.tick(), [])
})

test("service create：校验 cron / flow / id / 重复", async () => {
  const dir = await tempDir()
  const h = makeHarness(dir, new Date(2026, 5, 15, 10, 33, 0))
  await assert.rejects(h.service.create({ id: "Bad_ID", flow: "smoke", cron: "* * * * *" }), /kebab-case/)
  await assert.rejects(h.service.create({ id: "a", flow: "smoke", cron: "junk" }), /INVALID_CRON/)
  await assert.rejects(h.service.create({ id: "a", flow: "ghost", cron: "* * * * *" }), /FLOW_NOT_FOUND/)
  await h.service.create({ id: "a", flow: "smoke", cron: "* * * * *" })
  await assert.rejects(h.service.create({ id: "a", flow: "smoke", cron: "* * * * *" }), /DUPLICATE/)
})

test("service tick：停机合并补跑（跨多个 slot 只触发最近一个）", async () => {
  const dir = await tempDir()
  const h = makeHarness(dir, new Date(2026, 5, 15, 10, 33, 0))
  await h.service.create({ id: "a", flow: "smoke", cron: "*/5 * * * *" })
  // 「停机」37 分钟：10:33 -> 11:10，中间 10:35..11:10 共 8 个 slot
  h.advance(37 * 60_000)
  assert.deepEqual(await h.service.tick(), ["a"])
  assert.equal(h.fired.length, 1) // 只补跑一次
  const runs = await listRuns(dir, "a")
  assert.equal(runs.length, 1)
  assert.equal(runs[0]?.slot, new Date(2026, 5, 15, 11, 10).toISOString()) // 最近 slot
  assert.equal(runs[0]?.workflowRunId, "run-1")
})

test("service tick：单飞冲突 -> skipped 记录且 slot 已消费（tick 路径）", async () => {
  const busyDir = await tempDir()
  let busy = true
  const clock0 = new Date(2026, 5, 15, 10, 31, 0)
  const busyService = new SchedulerService({
    dir: busyDir,
    now: () => new Date(clock0.getTime()),
    flowExists: (f) => f === "smoke",
    trigger: async () => {
      if (busy) throw new ScheduleSkipError("another run live (single-flight)")
      return { runId: "r1", completion: Promise.resolve("success" as const) }
    },
  })
  await busyService.create({ id: "a", flow: "smoke", cron: "*/5 * * * *" }) // 基线 10:30
  clock0.setTime(clock0.getTime() + 5 * 60_000) // 10:36 -> slot 10:35 到期
  const fired = await busyService.tick()
  assert.deepEqual(fired, ["a"]) // 触发动作发生了（记录 skipped）
  const runs = await listRuns(busyDir, "a")
  assert.equal(runs[0]?.status, "skipped")
  assert.match(runs[0]?.note ?? "", /single-flight/)
  // slot 已消费：busy 解除后再 tick 同一 slot 不再触发
  busy = false
  assert.deepEqual(await busyService.tick(), [])
})

test("service runNow：单飞冲突 -> skipped 记录（manual 路径）", async () => {
  const dir = await tempDir()
  const clock = new Date(2026, 5, 15, 10, 41, 0)
  let busy = false
  const service = new SchedulerService({
    dir,
    now: () => new Date(clock.getTime()),
    flowExists: (flow) => flow === "smoke",
    trigger: async () => {
      if (busy) throw new ScheduleSkipError("another run live (single-flight)")
      return { runId: "r1", completion: Promise.resolve("success" as const) }
    },
  })
  await service.create({ id: "a", flow: "smoke", cron: "*/5 * * * *" })
  busy = true
  const record = await service.runNow("a")
  assert.equal(record.status, "skipped")
  assert.match(record.note!, /single-flight/)
  const runs = await listRuns(dir, "a")
  assert.equal(runs[0]?.status, "skipped")
})

test("service runNow：manual 触发不消费游标；终态回写", async () => {
  const dir = await tempDir()
  const h = makeHarness(dir, new Date(2026, 5, 15, 10, 33, 0))
  await h.service.create({ id: "a", flow: "smoke", cron: "0 9 * * *" })
  const record = await h.service.runNow("a")
  assert.equal(record.trigger, "manual")
  assert.equal(record.status, "running")
  assert.equal(record.workflowRunId, "run-1")
  // 落定 success -> 记录回写（轮询等待终态：CI 慢机上固定 5ms 睡眠是
  // 竞态，曾两度炸掉 0.8.1/0.8.2 发布流水线——'running' vs 'success'）
  h.fired[0]!.resolve("success")
  const deadline = Date.now() + 2_000
  for (;;) {
    const rows = await listRuns(dir, "a")
    if (rows[0]?.status === "success") break
    if (Date.now() > deadline) {
      assert.fail(`runNow 终态回写超时：status=${rows[0]?.status ?? "无记录"}`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  const runs = await listRuns(dir, "a")
  assert.equal(runs[0]?.status, "success")
  assert.ok(runs[0]?.finishedAt)
  // manual 未动游标：下一个 9 点 slot 仍会触发
  h.advance(22 * 3_600_000 + 27 * 60_000) // 次日 09:00
  assert.deepEqual(await h.service.tick(), ["a"])
})

test("service disable/enable/delete", async () => {
  const dir = await tempDir()
  const h = makeHarness(dir, new Date(2026, 5, 15, 10, 33, 0))
  await h.service.create({ id: "a", flow: "smoke", cron: "*/5 * * * *" })
  const off = await h.service.setEnabled("a", false)
  assert.equal(off.enabled, false)
  assert.equal(off.nextRunAt, undefined) // disabled 不算 next
  h.advance(30 * 60_000)
  assert.deepEqual(await h.service.tick(), []) // 停用不触发
  const on = await h.service.setEnabled("a", true)
  assert.ok(on.nextRunAt)
  await h.service.remove("a")
  assert.deepEqual(await h.service.tick(), [])
  assert.equal(await readFile(dir + "/.cursor.json", "utf8").then(() => true).catch(() => false), true)
  const cursor = await readCursor(dir)
  assert.equal("a" in cursor, false) // delete 清游标
})

test("anyLive：登记/清除", () => {
  assert.equal(anyLive(), false)
  markLive("run-x")
  assert.equal(anyLive(), true)
  clearLive("run-x")
  assert.equal(anyLive(), false)
})

// ── 手写 schedule 文件容错 ─────────────────────────────────────────────

test("store：手写/损坏的配置文件被忽略（列表不炸）", async () => {
  const dir = await tempDir()
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "broken.json"), "{ not json", "utf8")
  await writeFile(path.join(dir, ".hidden.json"), JSON.stringify({ id: "x", flow: "smoke" }), "utf8")
  await saveSchedule(dir, scheduleFixture("good"))
  assert.deepEqual((await listSchedules(dir)).map((s) => s.id), ["good"])
})
