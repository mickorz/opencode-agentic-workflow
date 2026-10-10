/**
 * 代码 workflow 装载器 —— v1 js 脚本唯一形态（v0.9.0 起单一形态化）
 *
 * v0.6.0 产品决策：声明式 JSON 流程面下线（git 历史与 dev-docs/design 留档）。
 * v0.9.0 产品决策（breaking）：defineWorkflow ESM 模块形态与 .mjs/.cjs 装载
 * 路径移除——流程唯一形态 = v1 js 脚本（`export const meta = {...}` + 魔法全局
 * `phase/agent/parallel/...` + 顶层 return）。放进 flows 的 .mjs/.cjs、
 * defineWorkflow 模块、.json 全部 fail-loud 并给出改写指引。
 *
 * 装载契约：
 *   - 入口：.js 文件路径或目录（扫一层，忽略点开头文件）；相对 baseDir
 *   - v1 脚本形态：源码含 `export const meta` 且不含 `defineWorkflow`
 *     （见 legacy-script.ts）——剥离 meta 包裹装载，不改写、不迁移
 *   - 错误语义：装载期文件级 skip+warn（不阻断其他文件与内置流程）
 *
 * 纪律：本文件属于 Core 侧资产装载，禁止 import OpenCode API
 * （架构不变量）；路径解析基准由调用方（plugin）传入。
 */

import { createHash } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import type { WorkflowDefinition } from "../registry/definition.js"
import type { AnyWorkflowDefinition } from "../registry/registry.js"
import { registerFlowFile, registerFlowRoot } from "./flow-index.js"
import {
  buildLegacyDefinition,
  detectLegacyScript,
  splitLegacyMeta,
  validateLegacyMeta,
  wrapLegacyModule,
} from "./legacy-script.js"

/** 代码流程文件扩展名（唯一） */
const CODE_EXTENSIONS = [".js"] as const

const JSON_REMOVED_HINT =
  'JSON workflows were removed in v0.6.0 - rewrite as a v1 js script (see README "代码流程")'

const EXT_REMOVED_HINT =
  ".mjs/.cjs workflow files were removed in v0.9.0 (only .js loads) - rename to .js and use the v1 script form (`export const meta = {...}` + 魔法全局 phase/agent/... + 顶层 return; see README \"代码流程\")"

const MODULE_FORM_REMOVED_HINT =
  'defineWorkflow ESM module workflows were removed in v0.9.0 - the only form is a v1 js script: `export const meta = { id, version, description }` + 魔法全局 (phase/agent/parallel/...) + 顶层 return (see README "代码流程")'

const NOT_A_SCRIPT_HINT =
  'missing `export const meta = {...}` - since v0.9.0 the only loaded form is a v1 js script (`export const meta` + 魔法全局 + 顶层 return; see README "代码流程")'

/**
 * 解析入口路径列表为流程文件列表（目录 = 一层扫描，忽略点开头文件；
 * 不存在的入口报错；.json / .mjs / .cjs 给迁移提示不装载——fail-loud）。
 */
async function expandEntries(entries: string[], baseDir: string): Promise<{ files: string[]; errors: string[] }> {
  const files: string[] = []
  const errors: string[] = []
  const isCodeFile = (name: string) => !name.startsWith(".") && CODE_EXTENSIONS.some((ext) => name.endsWith(ext))
  for (const entry of entries) {
    const resolved = path.isAbsolute(entry) ? entry : path.join(baseDir, entry)
    if (!existsSync(resolved)) {
      errors.push(`${entry}: no such file or directory (${resolved})`)
      continue
    }
    const stat = statSync(resolved)
    if (stat.isDirectory()) {
      const names = (await readdir(resolved)).sort()
      const codeNames = names.filter(isCodeFile)
      for (const name of names) {
        if (name.startsWith(".")) continue
        if (name.endsWith(".json")) {
          errors.push(`${path.join(entry, name)}: ${JSON_REMOVED_HINT}`)
        } else if (name.endsWith(".mjs") || name.endsWith(".cjs")) {
          errors.push(`${path.join(entry, name)}: ${EXT_REMOVED_HINT}`)
        }
      }
      if (codeNames.length === 0) {
        errors.push(`${entry}: directory has no workflow files (.js)`)
        continue
      }
      files.push(...codeNames.map((n) => path.join(resolved, n)))
    } else if (entry.endsWith(".json")) {
      errors.push(`${entry}: ${JSON_REMOVED_HINT}`)
    } else if (entry.endsWith(".mjs") || entry.endsWith(".cjs")) {
      errors.push(`${entry}: ${EXT_REMOVED_HINT}`)
    } else if (!entry.endsWith(".js")) {
      errors.push(`${entry}: not a workflow file (only .js loads since v0.9.0)`)
    } else {
      files.push(resolved)
    }
  }
  return { files, errors }
}

/**
 * 在用户目录旁导入包裹后的 legacy 脚本源（v1 脚本零 import，全局由包裹
 * 注入；临时文件仅为获得与用户目录一致的解析基准）：
 * 同目录隐藏临时 .mjs → import → 清理；目录不可写时回退 data: URL。
 */
async function importRewrittenSource(file: string, source: string): Promise<unknown> {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${createHash("sha256").update(file).digest("hex").slice(0, 8)}.aw.mjs`,
  )
  try {
    await writeFile(temp, source, "utf8")
    try {
      return await import(pathToFileURL(temp).href)
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
    }
  } catch {
    // 目录不可写等：回退 data: URL（此形态下文件内其余相对导入不可用，核心 API 可用）
    return import("data:text/javascript;base64," + Buffer.from(source, "utf8").toString("base64"))
  }
}

/**
 * 装载 v1 脚本形态（v0.8.0）：剥离 meta → 包裹为全局形参 async 函数模块 →
 * 同目录临时文件 import → 校验 meta → 构造 WorkflowDefinition。
 * v1 全局由 definition.run 在每次执行时绑定（见 legacy-script.ts）。
 */
async function loadLegacyScriptModule(
  file: string,
  source: string,
): Promise<{ ok: true; definition: WorkflowDefinition } | { ok: false; error: string }> {
  const at = (msg: string) => `${path.basename(file)}: ${msg}`
  const split = splitLegacyMeta(source)
  if (!split.ok) return { ok: false, error: at(split.error) }
  const wrapped = wrapLegacyModule(split.metaStatement, split.rest)
  if (!wrapped.ok) return { ok: false, error: at(wrapped.error) }

  let mod: unknown
  try {
    mod = await importRewrittenSource(file, wrapped.wrapped)
  } catch (error) {
    return {
      ok: false,
      error: at(`failed to import legacy script (${error instanceof Error ? error.message : String(error)})`),
    }
  }
  if (typeof mod !== "object" || mod === null) {
    return { ok: false, error: at("legacy script module import returned nothing") }
  }
  const record = mod as { meta?: unknown; default?: unknown }
  const meta = validateLegacyMeta(record.meta)
  if (!meta.ok) return { ok: false, error: at(meta.error) }
  if (typeof record.default !== "function") {
    return { ok: false, error: at("legacy script body did not compile into a function") }
  }
  const bodyFn = record.default as (...globals: unknown[]) => Promise<unknown>
  return { ok: true, definition: buildLegacyDefinition(meta.meta, bodyFn, file) }
}

/**
 * 装载代码流程（v0.9.0 起唯一形态 = v1 js 脚本）：
 * 源码含 `export const meta` 且不含 `defineWorkflow` → legacy 适配分支；
 * 其余（defineWorkflow 模块 / 无 meta 的普通模块）一律 fail-loud 给改写指引。
 * 返回定义或错误文案（含文件名前缀）；不抛出。
 */
async function loadCodeWorkflowModule(
  file: string,
): Promise<{ ok: true; definition: WorkflowDefinition } | { ok: false; error: string }> {
  const at = (msg: string) => `${path.basename(file)}: ${msg}`
  let source: string
  try {
    source = await readFile(file, "utf8")
  } catch (error) {
    return { ok: false, error: at(`failed to read (${error instanceof Error ? error.message : String(error)})`) }
  }

  if (detectLegacyScript(source)) {
    return loadLegacyScriptModule(file, source)
  }
  if (source.includes("defineWorkflow")) {
    return { ok: false, error: at(MODULE_FORM_REMOVED_HINT) }
  }
  return { ok: false, error: at(NOT_A_SCRIPT_HINT) }
}

/**
 * 装载自定义流程（代码式 JS 模块；v0.6.0 起唯一形态）。
 * 文件级错误 warn+跳过（与装载纪律一致：观测/装载不能成为主链路故障源）。
 */
export async function loadCustomWorkflows(
  entries: string[],
  baseDir: string,
  reservedIds: string[] = [],
): Promise<{ definitions: AnyWorkflowDefinition[]; errors: string[] }> {
  const { files, errors } = await expandEntries(entries, baseDir)
  const definitions: AnyWorkflowDefinition[] = []
  const reserved = new Set(reservedIds)
  const seenIds = new Map<string, string>()
  // 装载索引（legacy workflow() 路径形解析用）：入口根 + 文件 → id
  for (const entry of entries) registerFlowRoot(path.resolve(baseDir, entry))
  for (const file of files) {
    const loaded = await loadCodeWorkflowModule(file)
    if (!loaded.ok) {
      errors.push(loaded.error)
      continue
    }
    if (reserved.has(loaded.definition.id)) {
      errors.push(`${path.basename(file)}: id "${loaded.definition.id}" is reserved by a built-in workflow`)
      continue
    }
    const key = `${loaded.definition.id}@${loaded.definition.version}`
    const seenIn = seenIds.get(key)
    if (seenIn) {
      errors.push(`${path.basename(file)}: duplicate ${key} (already loaded from ${seenIn})`)
      continue
    }
    seenIds.set(key, path.basename(file))
    registerFlowFile(file, loaded.definition.id)
    definitions.push(loaded.definition)
  }
  return { definitions, errors }
}
