/**
 * 内建确定性谓词库 —— check/assert 的常用积木（P1.1）
 *
 * 全部基于可注入的 CommandRunner / Node fs，不触碰 OpenCode API。
 */

import { stat } from "node:fs/promises"

import { getCommandRunner, type CommandOptions } from "../runtime/command.js"

/**
 * 运行 shell 命令，退出码为 0 视为成功。
 * 命令一律带超时（默认 120s，可用 options.timeoutMs 覆盖）。
 */
export async function commandSuccess(
  command: string,
  options?: CommandOptions,
): Promise<boolean> {
  const result = await getCommandRunner().run(command, options)
  return result.code === 0 && !result.timedOut
}

/** 路径存在（文件或目录均为 true） */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 路径存在且是文件 */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** 路径存在且是目录 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
