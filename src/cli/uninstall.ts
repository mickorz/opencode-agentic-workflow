/**
 * 交互式 / 无头卸载（P2-10）
 *
 * 对称原则（v1 0.2.0 实测教训）：locked 安装无条件 npm install，卸载就
 * 无条件 npm uninstall；配置条目清空的数组连键删除；只剩 $schema 空壳的
 * 配置整文件删除（含 .bak）；**本轮**改动产生的 .bak 一并清理。
 * 含用户数据的删除（拷贝的 skill 目录、journal 运行记录）不自动删：
 * 交互逐个确认，无头模式打印手动清理命令。
 */

import { spawnSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import * as p from "@clack/prompts"

import {
  DEFAULT_JOURNAL_DIR,
  PKG_NAME,
  detectInstalled,
  globalOpenCodeJsonPath,
  isShellConfig,
  projectOpenCodeJsonPath,
  removeConfigWithBackup,
  removePluginEntries,
  removeSkillTarget,
  skillTargetExists,
  skillTargets,
  unwrap,
  type InstallKind,
} from "./config.js"

export interface UninstallFlags {
  /** 勾选要卸载的方式（无头必填；交互模式为 multiselect） */
  kinds?: InstallKind[]
  yes?: boolean
}

export async function runUninstall(flags: UninstallFlags): Promise<void> {
  p.intro("opencode-agentic-workflow 卸载")

  const cwd = process.cwd()
  const detected = detectInstalled(cwd)
  if (detected.length === 0) {
    p.outro("未检测到任何安装痕迹（全局 / 项目 / 锁定均无）")
    return
  }
  p.log.info(`检测到：${detected.map((d) => `${d.kind}（${d.evidence}）`).join("、")}`)

  // 选择要卸载的方式
  let kinds: InstallKind[]
  if (flags.kinds !== undefined && flags.kinds.length > 0) {
    kinds = flags.kinds
  } else if (flags.yes || process.stdout.isTTY !== true) {
    throw new Error("无头卸载请用 --global / --project / --locked 指明要卸载的方式（可组合）")
  } else {
    kinds = unwrap<InstallKind[]>(
      await p.multiselect({
        message: "选择要卸载的安装方式",
        options: detected.map((d) => ({ value: d.kind, label: d.kind, hint: d.evidence })),
        required: true,
      }),
    )
  }
  const unknown = kinds.filter((k) => !detected.some((d) => d.kind === k))
  if (unknown.length > 0) {
    p.log.warn(`未检测到 ${unknown.join("、")} 的安装痕迹，跳过`)
    kinds = kinds.filter((k) => detected.some((d) => d.kind === k))
  }
  if (kinds.length === 0) {
    p.outro("无可卸载项")
    return
  }

  const confirmed =
    flags.yes ?? unwrap<boolean>(await p.confirm({ message: `确认卸载 ${kinds.join("、")}`, initialValue: true }))
  if (!confirmed) {
    p.outro("已取消")
    return
  }

  const s = p.spinner()
  const manualCleanups: string[] = []

  for (const kind of kinds) {
    const configPath = kind === "global" ? globalOpenCodeJsonPath() : projectOpenCodeJsonPath(cwd)

    // 1) 配置条目移除（plugins 对象 + skills 零拷贝路径）
    s.start(`移除配置条目 ${configPath}`)
    const changed = removePluginEntries(configPath)
    if (changed) {
      // 空壳整文件删；否则清掉本轮产生的 .bak（还原到本次卸载前即用户预期）
      if (isShellConfig(configPath)) {
        removeConfigWithBackup(configPath)
        s.stop(`配置已清空，整文件删除 ${configPath}`)
      } else {
        rmSync(`${configPath}.bak`, { force: true })
        s.stop(`已更新 ${configPath}`)
      }
    } else {
      s.stop(`${configPath} 无本插件条目`)
    }

    // 2) 拷贝的 skill 目录（可能含用户改动：交互逐个确认，无头不自动删）
    if (kind !== "locked") {
      for (const target of skillTargets(cwd, kind)) {
        if (!skillTargetExists(target)) continue
        if (flags.yes || process.stdout.isTTY !== true) {
          manualCleanups.push(`rm -rf ${target.destDir}`)
          continue
        }
        const del = unwrap<boolean>(await p.confirm({ message: `删除 skill 目录：${target.destDir}`, initialValue: false }))
        if (del) removeSkillTarget(target)
      }
    }

    // 3) locked：对称无条件 npm uninstall
    if (kind === "locked") {
      s.start(`npm uninstall ${PKG_NAME}`)
      const res = spawnSync(`npm uninstall ${PKG_NAME}`, { cwd, stdio: "inherit", shell: true })
      if (res.status !== 0) {
        p.log.warn("npm uninstall 失败（可能本来就不是依赖），请手动核对 package.json")
      } else {
        s.stop("npm 依赖已移除")
      }
    }
  }

  // 4) journal 运行记录（用户数据，永不自动删）
  const journalPath = `${cwd}/${DEFAULT_JOURNAL_DIR}`
  if (existsSync(journalPath)) {
    manualCleanups.push(`rm -rf ${journalPath}  # 运行记录（resume 数据），确认不再需要再删`)
  }

  const outro = ["卸载完成。请重启 OpenCode 使配置生效。"]
  if (manualCleanups.length > 0) {
    outro.push("以下内容含你的数据，未自动删除，需要时手动清理：", ...manualCleanups.map((c) => `  ${c}`))
  }
  p.outro(outro.join("\n"))
}
