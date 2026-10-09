/**
 * 代码 workflow 装载器 —— 用户自定义流程的 JS 模块形态（唯一形态）
 *
 * v0.6.0 产品决策：声明式 JSON 流程面下线（设计未定型，暂只保留代码流程）。
 * 历史 JSON 机器（validateWorkflow / toDefinition / 模板解析）在 git 历史与
 * dev-docs/design 中留档，重设计时再取。
 *
 * 装载契约：
 *   - 入口：.js / .mjs / .cjs 文件路径或目录（扫一层，忽略点开头文件）；相对 baseDir
 *   - v2 模块形态：default / definition / workflow 三形态之一，最小形状校验
 *     （id/version 非空字符串 + run 函数）
 *   - v1 脚本形态（v0.8.0）：`export const meta = {...}` + 魔法全局
 *     `phase/agent/parallel/...` + 顶层 return——legacy 适配分支装载
 *     （见 legacy-script.ts），不改写、不迁移
 *   - <pkg>/core 裸说明符重写（v0.6.0）：用户 flows 目录通常解析不到本包
 *     （包在 opencode 全局缓存，不在用户 node_modules 链上）——装载时把
 *     "<pkg>/core" 重写为插件自身 dist/core 的绝对 file URL 再导入，
 *     保证拿到与宿主同一模块实例（executor / ambient 状态已接线）。
 *     实现方式：同目录隐藏临时 .mjs（保留用户目录的相对/npm 解析语义）
 *     → import → 清理；目录不可写时回退 data: URL 导入。
 *   - .json 入口不再装载：显式文件或目录内 .json 都给出迁移提示（fail-loud）
 *   - 错误语义：装载期文件级 skip+warn（不阻断其他文件与内置流程）
 *
 * 纪律：本文件属于 Core 侧资产装载，禁止 import OpenCode API
 * （架构不变量）；路径解析基准由调用方（plugin）传入。
 */

import { createHash } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

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

/** 代码流程模块扩展名 */
const CODE_EXTENSIONS = [".js", ".mjs", ".cjs"] as const

const JSON_REMOVED_HINT =
  'JSON workflows were removed in v0.6.0 - convert to a .js/.mjs module (see README "代码流程")'

/** 用户代码里引用核心 API 的裸说明符（重写目标） */
const PKG_CORE_SPEC = "@mickorz/opencode-agentic-workflow/core"

/** 本插件自身 core barrel 的绝对 file URL（惰性求值；dist 与 tsx src 两种布局兼容） */
let cachedCoreUrl: string | undefined
function coreBarrelUrl(): string {
  if (cachedCoreUrl !== undefined) return cachedCoreUrl
  const dir = path.dirname(fileURLToPath(import.meta.url))
  for (const rel of ["../core/index.js", "../core/index.ts"]) {
    const candidate = path.resolve(dir, rel)
    if (existsSync(candidate)) {
      cachedCoreUrl = pathToFileURL(candidate).href
      return cachedCoreUrl
    }
  }
  // 布局异常时按包结构兜底（装载报错会自行暴露路径问题）
  cachedCoreUrl = pathToFileURL(path.resolve(dir, "../core/index.js")).href
  return cachedCoreUrl
}

/**
 * 解析入口路径列表为流程文件列表（目录 = 一层扫描，忽略点开头文件；
 * 不存在的入口报错；.json 给迁移提示不装载）。
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
        if (!name.startsWith(".") && name.endsWith(".json")) {
          errors.push(`${path.join(entry, name)}: ${JSON_REMOVED_HINT}`)
        }
      }
      if (codeNames.length === 0) {
        errors.push(`${entry}: directory has no workflow files (.js/.mjs/.cjs)`)
        continue
      }
      files.push(...codeNames.map((n) => path.join(resolved, n)))
    } else if (entry.endsWith(".json")) {
      errors.push(`${entry}: ${JSON_REMOVED_HINT}`)
    } else {
      files.push(resolved)
    }
  }
  return { files, errors }
}

/**
 * 在用户目录旁导入改写后的模块源（保留该文件其余相对/npm 解析语义）：
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
 * 装载代码流程模块：.js/.mjs/.cjs 动态 import，取
 * default / definition / workflow 三种导出形态之一，校验
 * WorkflowDefinition 最小形状（id/version 字符串 + run 函数）。
 * v1 脚本形态（export const meta + 魔法全局）走 legacy 适配分支。
 * 含 <pkg>/core 裸说明符重写（见文件头）。返回定义或错误文案（含文件名前缀）；不抛出。
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

  const coreUrl = coreBarrelUrl()
  // 三种引用形态：from "<pkg>/core" / 副作用 import "<pkg>/core" / 动态 import("<pkg>/core")
  const rewritten = source
    .replace(/(\bfrom\s*)(["'])@mickorz\/opencode-agentic-workflow\/core\2/g, `$1"${coreUrl}"`)
    .replace(/(\bimport\s*)(["'])@mickorz\/opencode-agentic-workflow\/core\2/g, `$1"${coreUrl}"`)
    .replace(/(\bimport\s*\(\s*)(["'])@mickorz\/opencode-agentic-workflow\/core\2/g, `$1"${coreUrl}"`)

  let mod: unknown
  try {
    if (!source.includes(PKG_CORE_SPEC)) {
      // 未引用核心 API：原样导入（用户目录自身的相对/npm 解析语义保持不变）
      mod = await import(pathToFileURL(file).href)
    } else if (file.endsWith(".cjs")) {
      return {
        ok: false,
        error: at(`imports "${PKG_CORE_SPEC}" but .cjs cannot be specifier-rewritten - rename to .mjs (ESM)`),
      }
    } else {
      mod = await importRewrittenSource(file, rewritten)
    }
  } catch (error) {
    return { ok: false, error: at(`failed to import (${error instanceof Error ? error.message : String(error)})`) }
  }
  if (typeof mod !== "object" || mod === null) {
    return { ok: false, error: at("module must export a workflow (default export or named `definition`)") }
  }
  const candidate = (mod as Record<string, unknown>).default ?? (mod as Record<string, unknown>).definition ?? (mod as Record<string, unknown>).workflow
  if (typeof candidate !== "object" || candidate === null) {
    return {
      ok: false,
      error: at("module must export a workflow (default export or named `definition`): export defineWorkflow({...}) result"),
    }
  }
  const def = candidate as { id?: unknown; version?: unknown; run?: unknown }
  if (typeof def.id !== "string" || def.id.length === 0) {
    return { ok: false, error: at("workflow.id must be a non-empty string") }
  }
  if (typeof def.version !== "string" || def.version.length === 0) {
    return { ok: false, error: at("workflow.version must be a non-empty string (semver; bump on structure change)") }
  }
  if (typeof def.run !== "function") {
    return { ok: false, error: at("workflow.run must be a function: async run(args, ctx)") }
  }
  return { ok: true, definition: candidate as WorkflowDefinition }
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
