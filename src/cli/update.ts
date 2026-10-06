/**
 * 升级流程（P2-10）
 *
 * locked：npm update（升级本体，skills 零拷贝随包更新）。
 * global / project：删 OpenCode 插件缓存目录让宿主下次启动重新拉最新
 * （v2 缓存路径未官方化——best-effort，目录不存在仅 WARN）。
 * 拷贝型 skills（global/project）：无条件从 CLI 包根重新拷贝（安装器
 * 自有内容，非用户数据）。
 * 版本对比只读提示，失败不阻塞。
 */

import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import * as p from "@clack/prompts"

import {
  PKG_NAME,
  cliPackageRoot,
  copySkill,
  detectInstalled,
  pluginCacheDir,
  readInstalledVersion,
  skillTargets,
  unwrap,
} from "./config.js"

/** `npm view <pkg> version`（官方源）；失败返回 null */
export function latestVersionOnNpm(): string | null {
  const res = spawnSync(`npm view ${PKG_NAME} version --registry=https://registry.npmjs.org/`, {
    encoding: "utf8",
    shell: true,
    timeout: 30_000,
  })
  const out = `${res.stdout ?? ""}`.trim()
  return res.status === 0 && /^\d+\.\d+\.\d+/.test(out) ? out.split("\n").at(-1)! : null
}

export async function runUpdate(flags: { yes?: boolean }): Promise<void> {
  p.intro("opencode-agentic-workflow 升级")

  const cwd = process.cwd()
  const detected = detectInstalled(cwd)
  if (detected.length === 0) {
    p.outro("未检测到安装（先 npx " + PKG_NAME + " install）")
    return
  }
  p.log.info(`检测到：${detected.map((d) => d.kind).join("、")}`)

  const installed = readInstalledVersion(cwd)
  if (installed) {
    const latest = latestVersionOnNpm()
    if (latest === null) {
      p.log.warn("npm view 查询最新版本失败（网络 / registry），跳过版本对比")
    } else if (latest === installed) {
      p.log.step(`当前 ${installed} 已是 npm 最新`)
    } else {
      p.log.step(`当前 ${installed}，npm 最新 ${latest}`)
    }
  }

  const confirmed =
    flags.yes ?? unwrap<boolean>(await p.confirm({ message: "继续升级", initialValue: true }))
  if (!confirmed) {
    p.outro("已取消")
    return
  }

  const s = p.spinner()

  // 插件本体
  if (detected.some((d) => d.kind === "locked")) {
    s.start(`npm update ${PKG_NAME}`)
    const res = spawnSync(`npm update ${PKG_NAME}`, { cwd, stdio: "inherit", shell: true })
    if (res.status !== 0) {
      p.log.warn("npm update 失败，请检查网络 / registry 后重试")
    } else {
      s.stop("npm 依赖已更新")
    }
  }
  if (detected.some((d) => d.kind === "global" || d.kind === "project")) {
    const cache = pluginCacheDir()
    try {
      rmSync(cache, { recursive: true, force: true })
      s.stop(`已清插件缓存 ${cache}（宿主下次启动重新拉取最新）`)
    } catch {
      p.log.warn(`插件缓存清理失败：${cache}——可手动删除；宿主可能仍用缓存版本直到缓存过期`)
    }
  }

  // 拷贝型 skills 刷新（locked 零拷贝，npm update 已覆盖）
  for (const kind of ["global", "project"] as const) {
    if (!detected.some((d) => d.kind === kind)) continue
    for (const target of skillTargets(cwd, kind)) {
      s.start(`刷新 skill ${target.name}（${kind}）`)
      copySkill(`${cliPackageRoot()}/skills`, target)
      s.stop(`已刷新 ${target.destDir}`)
    }
  }

  p.outro("升级完成。请重启 OpenCode 使其重新加载插件。")
}
