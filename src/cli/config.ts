/**
 * Installer CLI 配置与检测工具（install / update / uninstall / doctor 共用）
 *
 * P2-10（详见 dev-docs/planning/P2-10-installer-cli.md）。
 * v2 形态与 v1 安装器的差异：
 *   - plugins 数组元素是对象 { package, options }（v1 是字符串 plugin 数组）
 *   - 无 tui.json 二次注册（v2 TUI 面板走同一插件）
 *   - skills 两形态：零拷贝 config `skills: ["node_modules/<pkg>/skills"]`（locked）
 *     或拷贝进原生扫描目录（global: ~/.config/opencode/skills；project: .opencode/skills）
 *
 * 纪律：JSONC 增量合并保留注释；写前 .bak；modify 传 undefined = 删键；
 * 数组整体替换（jsonc-parser 逐下标删除语义不可靠）。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse, type FormattingOptions } from "jsonc-parser"

/** npm 包名（plugins 条目的包名形式） */
export const PKG_NAME = "@mickorz/opencode-agentic-workflow"
/** 包在 node_modules 下的相对路径（正斜杠形式；匹配时统一替换反斜杠） */
export const PKG_IN_NODE_MODULES = `node_modules/${PKG_NAME}`
/** 锁定模式的 plugins.package（相对项目根，指向编译产物目录） */
export const PLUGIN_LOCAL_SPEC = `./${PKG_IN_NODE_MODULES}/dist/plugin`
/** 零拷贝 skills 数组条目（相对项目根） */
export const SKILLS_LOCAL_SPEC = `${PKG_IN_NODE_MODULES}/skills`
/** 包内 skills/ 目录下的 skill 名 */
export const SKILL_NAMES = ["workflow-authoring", "workflow-optimize"] as const
/** 安装器写入的 journal 目录（相对项目根；v2 相对路径以项目目录解析） */
export const DEFAULT_JOURNAL_DIR = ".agentic-workflow/journal"

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/** 全局配置目录：优先 ~/.config/opencode，Windows 回退 %APPDATA%/opencode */
export function globalConfigDir(): string {
  const preferred = join(homedir(), ".config", "opencode")
  if (existsSync(preferred)) return preferred
  const appData = process.env.APPDATA
  if (appData) return join(appData, "opencode")
  return preferred
}

export function globalOpenCodeJsonPath(): string {
  return join(globalConfigDir(), "opencode.json")
}

export function projectOpenCodeJsonPath(cwd: string): string {
  return join(cwd, "opencode.json")
}

/** v2 项目级 skill 原生扫描目录（.opencode/skills/<name>/SKILL.md） */
export function projectSkillsTargetDir(cwd: string): string {
  return join(cwd, ".opencode", "skills")
}

/** 全局 skill 原生扫描目录 */
export function globalSkillsTargetDir(): string {
  return join(globalConfigDir(), "skills")
}

/** 项目 node_modules 中包本体的位置 */
export function projectPackageDir(cwd: string): string {
  return join(cwd, PKG_IN_NODE_MODULES)
}

/**
 * OpenCode 插件缓存中本包的候选目录（update 清缓存 best-effort 用）。
 * v1 1.18.x 实测为 bun wrapper 结构；v2 未官方化——目录不存在不算错误。
 */
export function pluginCacheDir(): string {
  const [scope, name] = PKG_NAME.split("/")
  return join(homedir(), ".cache", "opencode", "packages", scope!, name!)
}

/** CLI 自身包根（npx 运行时位于 npx 缓存；skill 拷贝源取此处） */
export function cliPackageRoot(): string {
  // 编译后位于 dist/cli/config.js，包根为其上两级；源码运行（tsx）时为仓库根
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..")
}

// ---------------------------------------------------------------------------
// 插件条目构造与匹配
// ---------------------------------------------------------------------------

/** 模型引用（"providerID/modelId"）解析；不合法返回 null */
export function parseModelRef(ref: string): { providerID: string; id: string } | null {
  const match = ref.trim().match(/^([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)$/)
  return match ? { providerID: match[1]!, id: match[2]! } : null
}

export interface PluginEntryOptions {
  model: { providerID: string; id: string }
  agent: string
  journalDir?: string
}

/** 构造 plugins 数组条目对象（package 字段按安装方式取包名或本地路径） */
export function makePluginEntry(options: PluginEntryOptions, locked: boolean): Record<string, unknown> {
  return {
    package: locked ? PLUGIN_LOCAL_SPEC : PKG_NAME,
    options: {
      model: options.model,
      agent: options.agent,
      ...(options.journalDir !== undefined ? { journalDir: options.journalDir } : {}),
    },
  }
}

/** plugins 数组条目（对象）是否为本插件的：看 package 字段（包名 / 本地路径结尾匹配） */
export function isPluginEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false
  const pkg = (entry as Record<string, unknown>).package
  if (typeof pkg !== "string") return false
  const norm = pkg.replaceAll("\\", "/")
  return (
    pkg === PKG_NAME ||
    norm === PLUGIN_LOCAL_SPEC ||
    norm.endsWith(`${PKG_IN_NODE_MODULES}/dist/plugin`)
  )
}

/** skills 数组条目（字符串）是否为本插件零拷贝路径 */
export function isSkillPathEntry(entry: unknown): boolean {
  if (typeof entry !== "string") return false
  return entry.replaceAll("\\", "/").endsWith(SKILLS_LOCAL_SPEC)
}

/** 读取已配置条目的 options（doctor 检查 model/agent 用）；未安装返回 null */
export function installedEntryOptions(path: string): PluginEntryOptions | null {
  const loaded = readJsonc(path)
  if (!loaded) return null
  const plugins = loaded.data.plugins
  if (!Array.isArray(plugins)) return null
  const entry = plugins.find((item) => isPluginEntry(item)) as Record<string, unknown> | undefined
  const options = entry?.options
  if (typeof options !== "object" || options === null) return null
  return options as unknown as PluginEntryOptions
}

// ---------------------------------------------------------------------------
// JSONC 增量读写
// ---------------------------------------------------------------------------

interface LoadedConfig {
  path: string
  text: string
  data: Record<string, unknown>
}

/** 读 JSONC 文件；不存在或顶层不是对象返回 null */
export function readJsonc(path: string): LoadedConfig | null {
  if (!existsSync(path)) return null
  const text = readFileSync(path, "utf8")
  const data = parse(text) as Record<string, unknown> | undefined
  if (data === undefined || data === null || typeof data !== "object" || Array.isArray(data)) return null
  return { path, text, data }
}

const FORMAT: FormattingOptions = { tabSize: 2, insertSpaces: true }

/**
 * 向 plugins 数组增量写入条目对象（已有本插件条目则跳过，幂等）。
 * 数组不存在时创建；写回前备份 .bak；返回是否发生了修改。
 */
export function mergePluginEntry(path: string, entry: Record<string, unknown>): boolean {
  const loaded = ensureLoaded(path)
  const original = loaded.text
  const plugins = (loaded.data.plugins as unknown[] | undefined) ?? []
  if (plugins.some((item) => isPluginEntry(item))) return false

  const text = applyEdits(original, modify(original, ["plugins"], [...plugins, entry], { formattingOptions: FORMAT }))
  return writeWithBackup(path, original, text)
}

/**
 * 向 skills 数组增量写入零拷贝路径（locked 模式；已存在则跳过）。
 * 返回是否发生了修改。
 */
export function mergeSkillsEntry(path: string, skillsPath: string): boolean {
  const loaded = ensureLoaded(path)
  const original = loaded.text
  const skills = (loaded.data.skills as unknown[] | undefined) ?? []
  if (skills.some((item) => item === skillsPath || isSkillPathEntry(item))) return false

  const text = applyEdits(original, modify(original, ["skills"], [...skills, skillsPath], { formattingOptions: FORMAT }))
  return writeWithBackup(path, original, text)
}

/**
 * 从配置移除本插件相关条目：plugins 中匹配 isPluginEntry 的对象、
 * skills 中匹配 isSkillPathEntry 的字符串。数组清空后连键删除（不留空壳）。
 * 返回是否发生了修改。
 */
export function removePluginEntries(path: string): boolean {
  const loaded = readJsonc(path)
  if (!loaded) return false
  const original = loaded.text
  let text = original
  let changed = false

  const plugins = loaded.data.plugins
  if (Array.isArray(plugins)) {
    const next = plugins.filter((item) => !isPluginEntry(item))
    if (next.length !== plugins.length) {
      // modify 传 undefined 即删除该属性
      text = applyEdits(text, modify(text, ["plugins"], next.length > 0 ? next : undefined, { formattingOptions: FORMAT }))
      changed = true
    }
  }

  const skills = loaded.data.skills
  if (Array.isArray(skills)) {
    const next = skills.filter((item) => !isSkillPathEntry(item))
    if (next.length !== skills.length) {
      text = applyEdits(text, modify(text, ["skills"], next.length > 0 ? next : undefined, { formattingOptions: FORMAT }))
      changed = true
    }
  }

  if (!changed) return false
  return writeWithBackup(path, original, text)
}

/** 配置移除条目后是否只剩空壳（$schema 与空数组/空对象）——卸载时整文件删除 */
export function isShellConfig(path: string): boolean {
  const loaded = readJsonc(path)
  if (!loaded) return false
  return Object.keys(loaded.data).every((key) => {
    if (key === "$schema") return true
    const value = loaded.data[key]
    if (Array.isArray(value)) return value.length === 0
    if (value !== null && typeof value === "object") return Object.keys(value).length === 0
    return false
  })
}

/** 整体删除配置文件与其 .bak（不存在则静默跳过） */
export function removeConfigWithBackup(path: string): void {
  rmSync(path, { force: true })
  rmSync(`${path}.bak`, { force: true })
}

function ensureLoaded(path: string): LoadedConfig {
  const loaded = readJsonc(path)
  if (loaded) return loaded
  // 不存在则写带 $schema 的最小骨架（创建场景），父目录自动创建
  const text = `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, "utf8")
  return { path, text, data: parse(text) as Record<string, unknown> }
}

function writeWithBackup(path: string, originalText: string, nextText: string): boolean {
  if (originalText.trim() === nextText.trim()) return false
  try {
    writeFileSync(`${path}.bak`, originalText, "utf8")
  } catch {
    // 备份失败不阻塞写入（只读目录等），主流程继续
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, nextText, "utf8")
  return true
}

/**
 * 收窄 @clack 交互返回值：用户取消（ctrl+c）直接退出进程。
 * （isCancel 的 type guard 指向 unique symbol，泛型联合无法负向收窄，
 * 因此签名收 unknown、调用方以显式类型参声明期望类型。）
 */
export function unwrap<T>(value: unknown): T {
  if (typeof value === "symbol") process.exit(0)
  return value as T
}

// ---------------------------------------------------------------------------
// 存在性检测（install / update / uninstall / doctor 共用）
// ---------------------------------------------------------------------------

export type InstallKind = "global" | "project" | "locked"

export interface DetectResult {
  kind: InstallKind
  /** 命中证据描述（哪个文件 / 哪个目录） */
  evidence: string
}

function fileHitsPlugin(path: string): boolean {
  const loaded = readJsonc(path)
  const plugins = loaded?.data.plugins
  return Array.isArray(plugins) && plugins.some((item) => isPluginEntry(item))
}

/** 检测三种安装方式的存在性（globalDir 供测试注入） */
export function detectInstalled(cwd: string, globalDir = globalConfigDir()): DetectResult[] {
  const results: DetectResult[] = []

  const globalJson = join(globalDir, "opencode.json")
  if (fileHitsPlugin(globalJson)) {
    results.push({ kind: "global", evidence: globalJson })
  }

  const projectJson = projectOpenCodeJsonPath(cwd)
  if (fileHitsPlugin(projectJson)) {
    const loaded = readJsonc(projectJson)
    const plugins = loaded?.data.plugins
    // 分类只看条目形态：路径形式 = locked；包名形式 = project。
    // （node_modules 存在性不参与分类——npm 装了包但配置走包名是合法组合，
    // 归为 project；node_modules 残留单独走下面的 else-if 分支）
    const lockedByPath = Array.isArray(plugins) && plugins.some((item) => {
      if (!isPluginEntry(item)) return false
      const pkg = (item as Record<string, unknown>).package
      return typeof pkg === "string" && pkg !== PKG_NAME
    })
    results.push({
      kind: lockedByPath ? "locked" : "project",
      evidence: projectJson,
    })
  } else if (existsSync(projectPackageDir(cwd))) {
    // 无配置条目但包在 node_modules：locked 残留（半装 / 手动 npm install 未配置）
    results.push({ kind: "locked", evidence: projectPackageDir(cwd) })
  }

  return results
}

/** 读取已安装包版本：优先项目 node_modules，其次全局插件缓存；都没有返回 null */
export function readInstalledVersion(cwd: string): string | null {
  for (const dir of [projectPackageDir(cwd), pluginCacheDir()]) {
    const pkgPath = join(dir, "package.json")
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }
        return pkg.version ?? null
      } catch {
        return null
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// skill 拷贝（global / project 模式；locked 走零拷贝条目）
// ---------------------------------------------------------------------------

export interface SkillCopyTarget {
  name: string
  destDir: string
}

/** skill 拷贝目标列表：global 到 ~/.config/opencode/skills，其余到 .opencode/skills */
export function skillTargets(cwd: string, mode: "global" | "project" | "locked"): SkillCopyTarget[] {
  const base = mode === "global" ? globalSkillsTargetDir() : projectSkillsTargetDir(cwd)
  return SKILL_NAMES.map((name) => ({ name, destDir: join(base, name) }))
}

/** 递归拷贝单个 skill 目录（目标已存在时整体替换） */
export function copySkill(sourceBaseDir: string, target: SkillCopyTarget): void {
  const src = join(sourceBaseDir, target.name)
  if (!existsSync(src)) {
    throw new Error(`skill 源目录不存在：${src}`)
  }
  mkdirSync(target.destDir, { recursive: true })
  rmSync(target.destDir, { recursive: true, force: true })
  cpSync(src, target.destDir, { recursive: true })
}

/** 删除已拷贝的 skill 目录（不存在则静默跳过） */
export function removeSkillTarget(target: SkillCopyTarget): void {
  rmSync(target.destDir, { recursive: true, force: true })
}

/** 供 doctor / uninstall 判断 skill 目录是否已拷贝 */
export function skillTargetExists(target: SkillCopyTarget): boolean {
  return existsSync(join(target.destDir, "SKILL.md"))
}

/** 解析用户输入的 ~ 前缀路径（提示文案用） */
export function expandHome(p: string): string {
  if (!isAbsolute(p) && p.startsWith("~")) return join(homedir(), p.slice(1))
  return p
}
