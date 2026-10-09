/**
 * 装载索引 —— flow 文件绝对路径 ↔ 注册 id（legacy workflow() 路径形解析用）
 *
 * v1 的 workflow() 全局接受三种引用形态：
 *   - 注册名：workflow('schedule_test')
 *   - 脚本路径：workflow('./scripts/native/1_spec.js')（相对项目根/cwd）
 *   - 对象形：workflow({ scriptPath, label }, args)
 *
 * v2 registry 只认 id。装载器把每个成功装载的文件路径记入本索引；
 * legacy 适配层用「多基准解析」把路径形还原成 id——脚本一字不改。
 *
 * 解析基准（按序尝试）：cwd → 调用脚本自身目录 → 各装载根目录 → 各根的
 * 父目录（v1 sample-project 的 './scripts/native/x.js' 相对工程根，根的
 * 父目录正是该工程根）。全部落空 → fail-loud 列出已试基准。
 *
 * 纪律：禁止 import OpenCode API（架构不变量）。
 */

import path from "node:path"

const fileToId = new Map<string, string>()
const registeredIds = new Set<string>()
const roots: string[] = []

/** 装载器注册：文件绝对路径 → flow id */
export function registerFlowFile(absFile: string, id: string): void {
  fileToId.set(absFile, id)
  registeredIds.add(id)
}

/** 装载器注册：流程根目录（文件或目录入口的绝对路径） */
export function registerFlowRoot(absPath: string): void {
  const resolved = path.resolve(absPath)
  if (!roots.includes(resolved)) roots.push(resolved)
}

/** 已注册 id 集合（直接引用判定） */
export function isRegisteredFlowId(id: string): boolean {
  return registeredIds.has(id)
}

const PATH_LIKE = /^(\.|\/)/

/** 解析基准全集：cwd → extraBases → 装载根 → 装载根的父目录 */
function resolutionBases(extraBases: string[]): string[] {
  const bases = [process.cwd(), ...extraBases]
  for (const root of roots) {
    bases.push(root, path.dirname(root))
  }
  return [...new Set(bases)]
}

/**
 * 把 v1 的流程引用（id / 路径 / 对象）解析为注册 id。
 * ok=false 时 error 列出引用与已试基准（fail-loud）。
 */
export function resolveFlowRef(
  ref: unknown,
  extraBases: string[] = [],
): { ok: true; id: string; label?: string } | { ok: false; error: string } {
  if (typeof ref === "string") {
    // id 形（非路径样式）透传：注册与否由 registry 运行时判定
    // （其 not-found 错误自带可用 flow 列表，比装载期拦截更诚实）
    if (!PATH_LIKE.test(ref) && !ref.endsWith(".js")) {
      return { ok: true, id: ref }
    }
    const bases = resolutionBases(extraBases)
    for (const base of bases) {
      const id = fileToId.get(path.resolve(base, ref))
      if (id !== undefined) return { ok: true, id }
    }
    return {
      ok: false,
      error:
        `workflow("${ref}") 找不到对应 flow（已试基准：${bases.join("、")}）。` +
        `检查脚本路径或把目标脚本放进 flows 目录`,
    }
  }
  if (typeof ref === "object" && ref !== null && "scriptPath" in ref) {
    const record = ref as { scriptPath?: unknown; label?: unknown }
    const inner = resolveFlowRef(record.scriptPath, extraBases)
    if (!inner.ok) return inner
    const label = typeof record.label === "string" ? record.label : undefined
    return { ok: true, id: inner.id, label }
  }
  return {
    ok: false,
    error: "workflow(ref, args?) 的 ref 需是 flow id、脚本路径或 { scriptPath, label }",
  }
}
