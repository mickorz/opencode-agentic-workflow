/**
 * WorkflowRegistry（P2.5）—— 版本感知的 workflow 注册与发现
 *
 * - register：同 id 不同 version 允许共存（升级/回滚的关键）；
 *   同 id + 同 version 重复注册抛错（程序员错误，尽早暴露）。
 * - get(id)：取该 id 的**最新版本**（semver 最高；非 semver 按注册序最后者，
 *   排在所有 semver 之后）——用于「启动新 run」。
 * - get(id, version)：**精确版本**解析——用于 resume：
 *   journal 记录的 {id, version} 必须精确命中，绝不隐式取最新，
 *   否则步骤结构变更后旧 journal 恢复会错位（用户态安全约束）。
 *
 * 第一版仅支持代码注册；动态发现 / marketplace / 热加载明确不做（P2 范围外）。
 */

import type { WorkflowDefinition } from "./definition.js"
import { WorkflowNotFoundError, WorkflowRegistrationError } from "./errors.js"

/** 注册边界类型：注册表存异构定义，run 的 args 参数逆变，故边界用 any（仅此边界） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWorkflowDefinition = WorkflowDefinition<any>

/** 解析 semver "1.2.3" -> [1,2,3]；非 semver 返回 null */
function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareSemver(a: string, b: string): number {
  const sa = parseSemver(a)
  const sb = parseSemver(b)
  // 非 semver 一律低于 semver；两个非 semver 之间按注册序（外层处理）
  if (sa && !sb) return 1
  if (!sa && sb) return -1
  if (sa && sb) {
    for (let i = 0; i < 3; i++) {
      if (sa[i]! !== sb[i]!) return sa[i]! - sb[i]!
    }
    return 0
  }
  return 0
}

export class WorkflowRegistry {
  /** key = `${id}@${version}`，插入序保留注册顺序 */
  private readonly definitions = new Map<string, AnyWorkflowDefinition>()

  /** 注册 workflow；同 id + 同 version 重复抛错 */
  register(definition: AnyWorkflowDefinition): this {
    if (!definition.id || typeof definition.id !== "string") {
      throw new Error("[agentic-workflow] workflow definition requires a non-empty id")
    }
    if (!definition.version || typeof definition.version !== "string") {
      throw new Error(
        `[agentic-workflow] workflow definition ${definition.id} requires a non-empty version`,
      )
    }
    const key = `${definition.id}@${definition.version}`
    if (this.definitions.has(key)) {
      throw new WorkflowRegistrationError(definition.id, definition.version)
    }
    this.definitions.set(key, definition)
    return this
  }

  /** 同一 id 的全部已注册版本（注册序） */
  versions(id: string): AnyWorkflowDefinition[] {
    return this.list().filter((d) => d.id === id)
  }

  /** id 的最新版本（semver 最高；非 semver 按注册序最后，低于全部 semver） */
  latest(id: string): AnyWorkflowDefinition | undefined {
    const versions = this.versions(id)
    if (versions.length === 0) return undefined
    return versions.reduce((best, current) =>
      compareSemver(current.version, best.version) >= 0 ? current : best,
    )
  }

  /**
   * 解析 workflow：
   *   - get(id)          -> 最新版本（启动新 run 用）
   *   - get(id, version) -> 精确版本（resume 用；未命中抛 WorkflowNotFoundError）
   */
  get(id: string, version?: string): AnyWorkflowDefinition | undefined {
    if (version === undefined) return this.latest(id)
    const exact = this.definitions.get(`${id}@${version}`)
    return exact
  }

  /**
   * 解析（严格版）：未命中直接抛错并列出可用版本（resume 诊断友好）。
   * 工具层用它把「找不到」转成可读文本。
   */
  resolve(id: string, version?: string): AnyWorkflowDefinition {
    const found = this.get(id, version)
    if (!found) {
      const available = version === undefined ? this.ids() : this.versions(id).map((d) => d.version)
      throw new WorkflowNotFoundError(id, version, available)
    }
    return found
  }

  /** 全部定义（注册序，含同 id 多版本） */
  list(): AnyWorkflowDefinition[] {
    return [...this.definitions.values()]
  }

  /** 全部 id（去重，注册序） */
  ids(): string[] {
    const seen: string[] = []
    for (const definition of this.definitions.values()) {
      if (!seen.includes(definition.id)) seen.push(definition.id)
    }
    return seen
  }

  /** 每个 id 的最新版本各一条（工具枚举/描述用） */
  listLatest(): AnyWorkflowDefinition[] {
    return this.ids()
      .map((id) => this.latest(id))
      .filter((d): d is AnyWorkflowDefinition => d !== undefined)
  }

  /** 摘要（工具描述用）：`id@version: description` 每行一条（按最新版本） */
  summarize(): string {
    return this.listLatest()
      .map((d) => `- ${d.id}@${d.version}${d.description ? `: ${d.description}` : ""}`)
      .join("\n")
  }
}
