/**
 * FileExecutionStore —— 基于 JSON 文件的执行记录存储（P2.1）
 *
 * 布局：<baseDir>/<runId>.json（每 run 一个文件，全量快照）
 * 原子性：先写同目录临时文件再 rename（POSIX 同文件系统 rename 原子），
 *          读者永远不会读到半截 JSON。
 * 安全：runId 白名单校验（防路径穿越）。
 * 序列化：safeSerialize 兜底处理函数/BigInt/symbol/Error/循环引用，
 *          保证任何 in-memory run 都能落盘（占位描述代替不可 JSON 化的值）。
 */

import { promises as fs } from "node:fs"
import path from "node:path"

import { isValidRunId, type WorkflowRun } from "./journal.js"
import type { ExecutionStore } from "./store.js"

/** 不可 JSON 化的值 -> 占位描述 */
function toPlaceholder(value: unknown): unknown {
  if (typeof value === "function") return "[Function]"
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "symbol") return String(value)
  if (value instanceof Error) return { name: value.name, message: value.message }
  return value
}

/**
 * 安全序列化：
 *   1) 常规路径：基础替换器（重复引用保持原语义，完整复制两份）
 *   2) 循环引用退路：WeakSet 标记（可能把重复引用误标为 [Circular]，可接受——
 *      只有出现真正循环时才会走到这条路）
 */
function safeSerialize(run: WorkflowRun): string {
  try {
    return JSON.stringify(run, (_key: string, value: unknown) => toPlaceholder(value), 2) + "\n"
  } catch {
    const seen = new WeakSet<object>()
    return (
      JSON.stringify(
        run,
        (_key: string, value: unknown) => {
          if (typeof value === "object" && value !== null) {
            if (seen.has(value)) return "[Circular]"
            seen.add(value)
          }
          return toPlaceholder(value)
        },
        2,
      ) + "\n"
    )
  }
}

export class FileExecutionStore implements ExecutionStore {
  private readonly baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  private filePath(runId: string): string {
    if (!isValidRunId(runId)) {
      throw new Error(`[agentic-workflow] invalid runId: ${JSON.stringify(runId)}`)
    }
    return path.join(this.baseDir, `${runId}.json`)
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true })
  }

  private async exists(file: string): Promise<boolean> {
    try {
      await fs.access(file)
      return true
    } catch {
      return false
    }
  }

  /** 原子写：同目录 tmp -> rename（隐藏名，避免被 listRuns 扫到） */
  private async writeFileAtomic(file: string, content: string): Promise<void> {
    const tmp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
    )
    await fs.writeFile(tmp, content, "utf8")
    await fs.rename(tmp, file)
  }

  async createRun(run: WorkflowRun): Promise<void> {
    const file = this.filePath(run.runId)
    await this.ensureDir()
    if (await this.exists(file)) {
      throw new Error(`[agentic-workflow] run already exists: ${run.runId}`)
    }
    await this.writeFileAtomic(file, safeSerialize(run))
  }

  async saveRun(run: WorkflowRun): Promise<void> {
    const file = this.filePath(run.runId)
    await this.ensureDir()
    await this.writeFileAtomic(file, safeSerialize(run))
  }

  async getRun(runId: string): Promise<WorkflowRun | undefined> {
    const file = this.filePath(runId)
    let raw: string
    try {
      raw = await fs.readFile(file, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    try {
      return JSON.parse(raw) as WorkflowRun
    } catch (error) {
      throw new Error(
        `[agentic-workflow] corrupt run file ${file}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async listRuns(workflowId?: string): Promise<WorkflowRun[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.baseDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }

    const runs: WorkflowRun[] = []
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const file = path.join(this.baseDir, entry)
      try {
        const run = JSON.parse(await fs.readFile(file, "utf8")) as WorkflowRun
        if (workflowId && run.workflowId !== workflowId) continue
        runs.push(run)
      } catch {
        console.log(`[agentic-workflow] skipping corrupt run file: ${file}`)
      }
    }

    runs.sort((a, b) => b.startedAt - a.startedAt)
    return runs
  }
}
