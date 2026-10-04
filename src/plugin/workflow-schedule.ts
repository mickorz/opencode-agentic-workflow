/**
 * workflow_schedule 工具编排（P2-7）
 *
 * 定时任务 CRUD + runNow + 视图格式化。工具 execute 只做参数解析与
 * 本模块调用；执行细节（trigger 接线）在插件 index（依赖宿主侧
 * registry / journal store）。
 *
 * 纪律：Core 侧逻辑，禁止 import OpenCode API（架构不变量）。
 */

import type { SchedulerService } from "../scheduler/service.js"
import type { ScheduleRun, ScheduleView } from "../scheduler/types.js"

export type ScheduleAction = "create" | "list" | "get" | "delete" | "runNow" | "enable" | "disable"

export interface ScheduleToolInput {
  action?: unknown
  id?: unknown
  flow?: unknown
  cron?: unknown
  name?: unknown
  args?: unknown
  enabled?: unknown
}

function fmtRun(run: ScheduleRun): string {
  const parts = [
    `[${run.status}] ${run.trigger} slot=${run.slot}`,
    run.workflowRunId ? `run=${run.workflowRunId}` : undefined,
    run.note ? `note=${run.note}` : undefined,
  ].filter((p): p is string => p !== undefined)
  return `  - ${run.startedAt} ${parts.join(" ")}`
}

export function formatView(view: ScheduleView): string {
  const parts = [
    `${view.enabled ? "[on] " : "[off] "}${view.id} (${view.name ?? view.flow})`,
    `flow=${view.flow} cron="${view.cron}"`,
    `args=${JSON.stringify(view.args ?? {})}`,
    view.nextRunAt ? `next=${view.nextRunAt}` : "next=(disabled)",
    view.lastRunAt ? `last=${view.lastRunAt} (${view.lastRunStatus})` : "last=(never ran)",
  ]
  return parts.join("\n")
}

/** 工具主入口：永不抛（结果全部以 output 文本返回——22 轮事故纪律） */
export async function scheduleToolExecute(
  service: SchedulerService,
  input: ScheduleToolInput,
): Promise<string> {
  const action = typeof input.action === "string" ? input.action : ""
  const id = typeof input.id === "string" ? input.id : ""

  try {
    switch (action) {
      case "create": {
        if (typeof input.flow !== "string" || input.flow.length === 0) {
          return "[agentic-workflow] create requires: id, flow, cron"
        }
        if (typeof input.cron !== "string" || input.cron.length === 0) {
          return "[agentic-workflow] create requires: id, flow, cron"
        }
        if (id.length === 0) {
          return "[agentic-workflow] create requires: id, flow, cron"
        }
        const args =
          input.args !== undefined && typeof input.args === "object" && input.args !== null
            ? (input.args as Record<string, unknown>)
            : undefined
        const view = await service.create({
          id,
          flow: input.flow,
          cron: input.cron,
          ...(typeof input.name === "string" ? { name: input.name } : {}),
          ...(args !== undefined ? { args } : {}),
          ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
        })
        return `created schedule:\n${formatView(view)}\n(cursor baselined to now - slots before creation never fire; use action=runNow to fire immediately)`
      }
      case "list": {
        const views = await service.list()
        if (views.length === 0) return "no schedules (create with action=create)"
        return `${views.length} schedule(s):\n\n${views.map(formatView).join("\n\n")}`
      }
      case "get": {
        if (id.length === 0) return "[agentic-workflow] get requires: id"
        const detail = await service.detail(id)
        const runs = detail.runs.length > 0 ? detail.runs.map(fmtRun).join("\n") : "  (no runs yet)"
        return `${formatView(detail.view)}\nrecent runs (newest first):\n${runs}`
      }
      case "delete": {
        if (id.length === 0) return "[agentic-workflow] delete requires: id"
        await service.remove(id)
        return `deleted schedule ${id} (config, cursor, run history)`
      }
      case "runNow": {
        if (id.length === 0) return "[agentic-workflow] runNow requires: id"
        const record = await service.runNow(id)
        return `manual trigger recorded:\n${fmtRun(record)}\n(poll the workflow via workflow_control action=status runId=...)`
      }
      case "enable":
      case "disable": {
        if (id.length === 0) return `[agentic-workflow] ${action} requires: id`
        const view = await service.setEnabled(id, action === "enable")
        return formatView(view)
      }
      default:
        return `[agentic-workflow] unknown action "${action}" (supported: create, list, get, delete, runNow, enable, disable)`
    }
  } catch (error) {
    return `[agentic-workflow] schedule ${action || "(?)"} failed: ${error instanceof Error ? error.message : String(error)}`
  }
}
