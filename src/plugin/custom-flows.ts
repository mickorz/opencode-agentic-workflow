/**
 * 自定义流程装载注册（v0.6.1）
 *
 * 两个入口共用：
 *   - 插件 init：全量装载基线
 *   - workflow 工具运行期：未知 flow id 时增量重扫一次——刚写好的
 *     flows/*.mjs 无需重启即可运行（v1「定义即注册」体验的代码形态对位）
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
