/**
 * 自定义流程装载注册（v0.6.1）
 *
 * 两个入口共用：
 *   - 插件 init：全量装载基线
 *   - workflow 工具运行期：未知 flow id 时增量重扫一次——刚写好的
 *     flows/*.js 无需重启即可运行（v1「定义即注册」体验的代码形态对位）
 *
 * 语义边界（如实）：
 *   - 只会「新增」注册：已注册同 id@version 跳过（增量重扫的常态）
 *   - 新文件可靠拾取（新路径 = 新 ESM 模块）；**改动已装载文件的内容
 *     需要重启**（Node ESM 缓存按 URL，重导返回旧模块）——升 version
 *     的编辑走重启
 *   - 文件级错误收集返回（调用方 warn），不阻断其他文件
 *
 * 纪律：不 import OpenCode API（架构不变量）。
 */

import { loadCustomWorkflows } from "../workflows/loader.js"
import type { WorkflowRegistry } from "../registry/registry.js"

export interface RefreshedFlow {
  id: string
  version: string
  stepNames: readonly string[]
}

export interface RefreshResult {
  /** 本次新注册的流程（增量：已注册的同 id@version 不在其中） */
  registered: RefreshedFlow[]
  /** 文件级错误（装载校验 + 注册拒绝） */
  errors: string[]
}

/**
 * workflow 工具「未知 flow id」的报错文案（v0.6.4）。
 *
 * 三段信息：
 *  1. 可用 id 清单（live registry）
 *  2. flows 装载错误前 3 条（文件写了但没注册上的自诊断）
 *  3. 插件版本 + 重启提示——**进程冻结的显式信号**：插件随 opencode
 *     进程加载一次，新开聊天不重载（skill 却会重读磁盘，极易误判已
 *     升级）。报错里的 v 与安装版本不符 = 宿主进程是老的，完全重启
 *     opencode 才会换血。
 */
export function formatUnknownFlowMessage(params: {
  workflowId: string
  availableIds: readonly string[]
  errors?: readonly string[]
  pluginVersion: string
}): string {
  const { workflowId, availableIds, errors = [], pluginVersion } = params
  const errorHint =
    errors.length > 0
      ? "\nflows load errors (first 3):\n" +
        errors
          .slice(0, 3)
          .map((error) => `- ${error}`)
          .join("\n")
      : ""
  return (
    `[agentic-workflow] workflow failed: workflow not found: ${workflowId}. ` +
    `available: ${availableIds.join(", ")}${errorHint}` +
    `\n[plugin v${pluginVersion}; plugins load once per opencode process - ` +
    `if the flow file was added after this process started or v looks outdated, ` +
    `fully restart opencode (a new chat does not reload plugins)]`
  )
}

export async function refreshCustomWorkflows(params: {
  registry: WorkflowRegistry
  /** flows 入口（文件或目录；相对 baseDir） */
  entries: readonly string[]
  baseDir: string
  /** 内置保留 id（防遮蔽） */
  reservedIds: readonly string[]
}): Promise<RefreshResult> {
  const { registry, entries, baseDir, reservedIds } = params
  const result: RefreshResult = { registered: [], errors: [] }
  if (entries.length === 0) return result

  const loaded = await loadCustomWorkflows([...entries], baseDir, [...reservedIds])
  result.errors.push(...loaded.errors)
  for (const definition of loaded.definitions) {
    // 增量语义：同 id@version 已注册 = 跳过（重扫常态，不是错误）
    if (registry.get(definition.id, definition.version) !== undefined) {
      continue
    }
    try {
      registry.register(definition)
      result.registered.push({
        id: definition.id,
        version: definition.version,
        stepNames: definition.stepNames ?? [],
      })
    } catch (error) {
      result.errors.push(
        `${definition.id}@${definition.version}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return result
}
