/**
 * 只读环境排查（P2-10）—— [OK]/[WARN]/[FAIL]/[INFO] 清单，绝不修改任何东西。
 * 退出码：有 FAIL = 1，否则 0。
 */

import { spawnSync } from "node:child_process"
import { existsSync, accessSync, constants } from "node:fs"
import { join } from "node:path"
import * as p from "@clack/prompts"

import {
  globalOpenCodeJsonPath,
  installedEntryOptions,
  detectInstalled,
  isSkillPathEntry,
  pluginCacheDir,
  projectOpenCodeJsonPath,
  readInstalledVersion,
  readJsonc,
  skillTargetExists,
  skillTargets,
} from "./config.js"
import { latestVersionOnNpm } from "./update.js"

type Level = "OK" | "WARN" | "FAIL" | "INFO"

const icon: Record<Level, string> = { OK: "[OK]", WARN: "[WARN]", FAIL: "[FAIL]", INFO: "[INFO]" }

function shellOut(cmd: string): { ok: boolean; out: string } {
  const res = spawnSync(cmd, { encoding: "utf8", shell: true, timeout: 15_000 })
  return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() }
}

export async function runDoctor(): Promise<void> {
  p.intro("opencode-agentic-workflow 环境排查（只读）")
  const lines: Array<{ level: Level; text: string }> = []
  const fail = (text: string) => lines.push({ level: "FAIL", text })
  const warn = (text: string) => lines.push({ level: "WARN", text })
  const ok = (text: string) => lines.push({ level: "OK", text })
  const info = (text: string) => lines.push({ level: "INFO", text })

  // Node 版本
  const nodeMajor = Number(process.versions.node.split(".")[0])
  if (nodeMajor >= 20) ok(`Node ${process.versions.node}（>= 20）`)
  else fail(`Node ${process.versions.node} 低于 20（插件要求 >= 20）`)

  // opencode CLI 与大版本（本插件针对 v2）
  const oc = shellOut("opencode --version")
  if (!oc.ok) {
    warn("未检测到 opencode 命令（可能仅装了桌面版），无法核对本插件要求的 V2 平台")
  } else {
    const ver = oc.out.match(/(\d+)\.\d+\.\d+/)
    const major = ver ? Number(ver[1]) : null
    if (major === 2) ok(`OpenCode ${oc.out}（V2）`)
    else warn(`OpenCode ${oc.out}——本插件针对 OpenCode V2，大版本不匹配`)
  }

  // 安装方式存在性 + 条目健康
  const cwd = process.cwd()
  const detected = detectInstalled(cwd)
  if (detected.length === 0) {
    warn("未检测到安装（全局 / 项目 / 锁定均无）——npx " + "@mickorz/opencode-agentic-workflow install")
  }
  for (const d of detected) {
    info(`安装方式 ${d.kind}：${d.evidence}`)
    const configPath = d.kind === "global" ? globalOpenCodeJsonPath() : projectOpenCodeJsonPath(cwd)
    if (!existsSync(configPath)) {
      warn(`${d.kind} 证据来自 node_modules 残留（配置无本插件条目）——重跑 install 补配置，或 uninstall --locked 移除依赖`)
      continue
    }
    const options = installedEntryOptions(configPath)
    if (options === null) {
      warn(`${configPath} 里找不到可解析的 options（配置可能手改过）`)
      continue
    }
    if (options.model) ok(`options.model = ${options.model.providerID}/${options.model.id}`)
    else warn("条目缺 options.model——子会话没有模型，agent 步会失败")
    if (options.agent) ok(`options.agent = ${options.agent}`)
    else warn("条目缺 options.agent——子会话默认无 agent（通常需要 build）")
    if (options.journalDir) {
      const journalPath = join(cwd, options.journalDir)
      try {
        if (existsSync(journalPath)) accessSync(journalPath, constants.W_OK)
        else accessSync(join(cwd, "."), constants.W_OK)
        ok(`journalDir = ${options.journalDir}（${existsSync(journalPath) ? "存在且可写" : "将在首次运行时创建，父目录可写"}）`)
      } catch {
        fail(`journalDir 不可写：${journalPath}`)
      }
    } else {
      info("未配置 journalDir——不持久化、不可恢复（如需 resume 请配置）")
    }
  }

  // git（worktree 隔离可选能力）
  if (shellOut("git --version").ok) ok("git 可用（worktree 隔离可用）")
  else warn("git 不可用——isolation: git-worktree 无法使用")

  // skills 状态
  for (const kind of ["global", "project"] as const) {
    for (const target of skillTargets(cwd, kind)) {
      if (skillTargetExists(target)) info(`skill 已拷贝（${kind}）：${target.destDir}`)
    }
  }
  for (const configPath of [projectOpenCodeJsonPath(cwd), globalOpenCodeJsonPath()]) {
    const loaded = readJsonc(configPath)
    const skills = loaded?.data.skills
    if (Array.isArray(skills) && skills.some((item) => isSkillPathEntry(item))) {
      const entry = skills.find((item) => isSkillPathEntry(item))
      info(`skills 零拷贝条目（${configPath}）：${String(entry)}`)
      const resolved = join(cwd, String(entry))
      if (existsSync(resolved)) ok(`零拷贝 skills 目录存在：${resolved}`)
      else fail(`零拷贝 skills 目录不存在：${resolved}（先 npm install ${"@mickorz/opencode-agentic-workflow"}）`)
    }
  }

  // 版本对比
  const installed = readInstalledVersion(cwd)
  if (installed !== null) {
    const latest = latestVersionOnNpm()
    if (latest === null) warn(`已装 ${installed}，npm 最新版本查询失败（网络 / registry）`)
    else if (latest === installed) ok(`已装 ${installed}（npm 最新）`)
    else warn(`已装 ${installed}，npm 最新 ${latest}——npx @mickorz/opencode-agentic-workflow update`)
    info(`插件缓存目录（供参考）：${pluginCacheDir()}`)
  } else {
    info("未发现本地可读的已装版本（全局模式由宿主缓存管理，属正常）")
  }

  for (const line of lines) {
    const text = `${icon[line.level]} ${line.text}`
    if (line.level === "FAIL") p.log.error(text)
    else if (line.level === "WARN") p.log.warn(text)
    else if (line.level === "INFO") p.log.info(text)
    else p.log.step(text)
  }

  const hasFail = lines.some((l) => l.level === "FAIL")
  p.outro(hasFail ? "存在 FAIL 项，请先处理再使用" : "排查完成")
  if (hasFail) process.exitCode = 1
}
