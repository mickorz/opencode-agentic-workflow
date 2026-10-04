/**
 * Schedule 文件存储（P2-7）
 *
 * schedulesDir 布局：
 *   <id>.json          Schedule 配置（工具管理；点开头文件被忽略）
 *   .cursor.json       触发游标 { [id]: lastSlotEpochMs }（原子写）
 *   runs/<id>.json     该 id 的触发记录（新的在前，上限 50 条，原子写）
 *
 * 纪律：Core 侧模块，禁止 import OpenCode API（架构不变量）。
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Schedule, ScheduleRun } from "./types.js"

const RUNS_KEEP = 50

/** 原子写（tmp + rename；与 journal 同纪律——绝不写半截文件） */
async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  await writeFile(tmp, content, "utf8")
  await rename(tmp, file)
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return undefined // 不存在或坏 JSON：视为无（工具层对配置文件报错，游标自愈）
  }
}

/** 全部 Schedule（按 id 排序；点开头与 runs/ 不算配置） */
export async function listSchedules(dir: string): Promise<Schedule[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return [] // 目录不存在 = 无定时任务
  }
  const schedules: Schedule[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.startsWith(".")) continue
    const parsed = (await readJson(path.join(dir, entry))) as Schedule | undefined
    if (parsed && typeof parsed.id === "string" && typeof parsed.flow === "string") {
      schedules.push(parsed)
    }
  }
  return schedules.sort((a, b) => a.id.localeCompare(b.id))
}

export async function getSchedule(dir: string, id: string): Promise<Schedule | undefined> {
  const parsed = (await readJson(path.join(dir, `${id}.json`))) as Schedule | undefined
  return parsed && parsed.id === id ? parsed : undefined
}

export async function saveSchedule(dir: string, schedule: Schedule): Promise<void> {
  await atomicWrite(path.join(dir, `${schedule.id}.json`), JSON.stringify(schedule, null, 2) + "\n")
}

/** 删除配置 + 该 id 的游标与记录 */
export async function deleteSchedule(dir: string, id: string): Promise<void> {
  await rm(path.join(dir, `${id}.json`), { force: true })
  await rm(path.join(dir, "runs", `${id}.json`), { force: true })
  const cursor = (await readJson(path.join(dir, ".cursor.json"))) as Record<string, number> | undefined
  if (cursor && id in cursor) {
    delete cursor[id]
    await atomicWrite(path.join(dir, ".cursor.json"), JSON.stringify(cursor, null, 2) + "\n")
  }
}

/** 触发游标：id -> 已消费的 slot epoch ms */
export async function readCursor(dir: string): Promise<Record<string, number>> {
  return ((await readJson(path.join(dir, ".cursor.json"))) as Record<string, number>) ?? {}
}

export async function writeCursor(dir: string, cursor: Record<string, number>): Promise<void> {
  await atomicWrite(path.join(dir, ".cursor.json"), JSON.stringify(cursor, null, 2) + "\n")
}

/** 某 id 的触发记录（新的在前） */
export async function listRuns(dir: string, id: string): Promise<ScheduleRun[]> {
  return ((await readJson(path.join(dir, "runs", `${id}.json`))) as ScheduleRun[]) ?? []
}

/** 追加一条记录（新的在前，上限 50 条截断） */
export async function appendRun(dir: string, id: string, run: ScheduleRun): Promise<void> {
  const existing = await listRuns(dir, id)
  const next = [run, ...existing].slice(0, RUNS_KEEP)
  await atomicWrite(path.join(dir, "runs", `${id}.json`), JSON.stringify(next, null, 2) + "\n")
}

/** 按 slotEpoch + trigger 定位记录并更新（服务在 run 收口时改状态） */
export async function updateRun(
  dir: string,
  id: string,
  slotEpoch: number,
  trigger: "scheduled" | "manual",
  patch: Partial<ScheduleRun>,
): Promise<ScheduleRun | undefined> {
  const runs = await listRuns(dir, id)
  const index = runs.findIndex((r) => r.slotEpoch === slotEpoch && r.trigger === trigger)
  if (index === -1) return undefined
  const updated = { ...runs[index]!, ...patch }
  runs[index] = updated
  await atomicWrite(path.join(dir, "runs", `${id}.json`), JSON.stringify(runs, null, 2) + "\n")
  return updated
}
