/**
 * CommandRunner —— 命令执行抽象（Workflow Core 内的宿主无关原语）
 *
 * 注意：这不是 OpenCode 依赖。Core 只依赖 Node 内建能力（child_process），
 * 默认实现 NodeCommandRunner 可直接在单测/本地使用；plugin 层如需
 * 经由 OpenCode shell 域执行，可用 setCommandRunner() 注入替代实现。
 *
 * 纪律（来自经验沉淀 opencode-run-hang-watchdog.md）：
 *   命令一律带超时，禁止无限等待。默认 120s。
 */

import { spawn } from "node:child_process"

export interface CommandOptions {
  /** 工作目录 */
  cwd?: string
  /** 超时毫秒数，默认 120000；超时后进程被终止并返回 timedOut: true */
  timeoutMs?: number
  /** 附加环境变量（在 process.env 之上合并） */
  env?: Record<string, string>
}

export interface CommandResult {
  command: string
  /** 退出码；进程被信号杀死或启动失败时为 null */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface CommandRunner {
  run(command: string, options?: CommandOptions): Promise<CommandResult>
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

/** 基于 node:child_process 的默认实现 */
export class NodeCommandRunner implements CommandRunner {
  async run(command: string, options?: CommandOptions): Promise<CommandResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS

    return new Promise<CommandResult>((resolve) => {
      const child = spawn(command, {
        shell: true,
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : process.env,
      })

      let stdout = ""
      let stderr = ""
      let timedOut = false
      let settled = false

      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, timeoutMs)

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ command, code, stdout, stderr, timedOut })
      }

      child.on("error", (error: Error) => {
        stderr += String(error.message)
        finish(null)
      })
      child.on("close", (code) => finish(code))
    })
  }
}

let runner: CommandRunner = new NodeCommandRunner()

/** 注入自定义 CommandRunner（测试替身 / plugin 层替代实现） */
export function setCommandRunner(value: CommandRunner): void {
  runner = value
}

/** 获取当前 CommandRunner */
export function getCommandRunner(): CommandRunner {
  return runner
}
