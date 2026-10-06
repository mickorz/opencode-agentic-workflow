/**
 * 交互式 / 无头安装流程（P2-10）
 *
 * 交互：安装方式 → 模型引用 → journal 开关 → skills 开关 → 变更清单确认。
 * 无头：flags 指齐必答项 + --yes 即跳过全部交互（可脚本化）；
 * 非 TTY 且缺必答 → 报错列出缺项（绝不挂起）。
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import * as p from "@clack/prompts"

import {
  DEFAULT_JOURNAL_DIR,
  PKG_NAME,
  SKILL_NAMES,
  SKILLS_LOCAL_SPEC,
  cliPackageRoot,
  copySkill,
  detectInstalled,
  globalOpenCodeJsonPath,
  makePluginEntry,
  mergePluginEntry,
  mergeSkillsEntry,
  parseModelRef,
  projectOpenCodeJsonPath,
  skillTargets,
  unwrap,
  type InstallKind,
} from "./config.js"

export interface InstallFlags {
  mode?: InstallKind
  /** 模型引用 "providerID/modelId" */
  model?: string
  agent?: string
  journal?: boolean
  skills?: boolean
  /** 跳过确认（无头模式的必答项齐备检查同时启用） */
  yes?: boolean
}

export async function runInstall(flags: InstallFlags): Promise<void> {
  p.intro("opencode-agentic-workflow 安装器")

  const interactive = process.stdout.isTTY === true

  // ---- 必答项补齐：交互逐项问；无头缺项即报错 ----
  const answers: {
    mode?: InstallKind
    model?: string
    agent: string
    journal: boolean
    skills: boolean
  } = {
    mode: flags.mode,
    model: flags.model,
    agent: flags.agent ?? "build",
    journal: flags.journal ?? true,
    skills: flags.skills ?? true,
  }

  // fill 内部已 unwrap（泛型联合吸收 unique symbol，收窄只能在具体联合处做）
  const ask = async <T>(fill: () => Promise<T>, name: string): Promise<T> => {
    if (interactive && !flags.yes) return await fill()
    throw new Error(`缺少必答项 ${name}（无头模式请用 flags 指齐，或去掉 --yes 走交互）`)
  }

  if (answers.mode === undefined) {
    answers.mode = await ask(
      async () =>
        unwrap<InstallKind>(
          await p.select<InstallKind>({
            message: "请选择安装方式",
            options: [
              { value: "global", label: "全局安装", hint: "所有 OpenCode 项目生效" },
              { value: "project", label: "当前项目", hint: "仅当前项目生效（推荐）" },
              { value: "locked", label: "当前项目 + 锁定版本", hint: "npm 装进 node_modules，适合团队协作" },
            ],
          }),
        ),
      "--global / --project / --locked",
    )
  }

  if (answers.model === undefined) {
    answers.model = await ask(
      async () =>
        unwrap<string>(
          await p.text({
            message: "子会话模型（providerID/modelId，如 glm/glm-5.3-flash）",
            validate: (value) => (parseModelRef(value ?? "") === null ? "格式应为 providerID/modelId" : undefined),
          }),
        ),
      "--model <providerID/modelId>",
    )
  }
  const model = parseModelRef(answers.model)
  if (model === null) {
    throw new Error(`模型引用不合法：${answers.model}（应形如 providerID/modelId）`)
  }
  const mode = answers.mode  // 上面分支保证已填

  // 可选开关（journal/skills）：交互才问；无头保持缺省（只有 mode/model 必答）
  if (flags.journal === undefined && interactive && !flags.yes) {
    answers.journal = await ask(
      async () =>
        unwrap<boolean>(await p.confirm({ message: "启用 journal 持久化（resume / 后台 run / 调度都依赖）", initialValue: true })),
      "--no-journal",
    )
  }
  if (flags.skills === undefined && interactive && !flags.yes) {
    answers.skills = await ask(
      async () => unwrap<boolean>(await p.confirm({ message: `安装 skills（${SKILL_NAMES.join(" / ")}）`, initialValue: true })),
      "--no-skills",
    )
  }

  // ---- 计划 ----
  const cwd = process.cwd()
  const locked = mode === "locked"
  const configPath = mode === "global" ? globalOpenCodeJsonPath() : projectOpenCodeJsonPath(cwd)
  const entry = makePluginEntry(
    {
      model,
      agent: answers.agent,
      ...(answers.journal ? { journalDir: DEFAULT_JOURNAL_DIR } : {}),
    },
    locked,
  )

  const existing = detectInstalled(cwd).find((item) => item.kind === mode)
  if (existing) {
    p.log.info(`该方式似乎已安装（命中 ${existing.evidence}），继续将做增量合并`)
  }

  const lines = [`修改  ${configPath}（plugins += ${String(entry.package)}）`]
  if (locked) {
    lines.unshift(`执行  npm install ${PKG_NAME}（在 ${cwd}）`)
    if (answers.skills) lines.push(`写入  skills 数组 += ${SKILLS_LOCAL_SPEC}（零拷贝）`)
  } else if (answers.skills) {
    const base = skillTargets(cwd, mode)[0]!.destDir
    lines.push(`拷贝  ${join(cliPackageRoot(), "skills")}/ 下 ${SKILL_NAMES.length} 个 skill 到 ${base}/`)
  }
  if (answers.journal) {
    lines.push(`创建  ${DEFAULT_JOURNAL_DIR}/（首次运行时落盘 journal）`)
  }
  p.note(lines.join("\n"), "将修改以下内容（已存在的配置会留 .bak 备份）")

  const go = flags.yes ?? unwrap<boolean>(await p.confirm({ message: "开始安装", initialValue: true }))
  if (!go) {
    p.outro("已取消")
    return
  }

  // ---- 执行 ----
  const s = p.spinner()
  try {
    if (locked) {
      s.start("安装 npm 包到当前项目")
      const res = spawnSync(`npm install ${PKG_NAME}`, { cwd, stdio: "inherit", shell: true })
      if (res.status !== 0) throw new Error("npm install 失败，请检查网络 / registry 后重试")
      s.stop(`npm 包已安装到 ${join(cwd, "node_modules")}`)
    }

    s.start("合并 opencode.json")
    mergePluginEntry(configPath, entry)
    s.stop(`已更新 ${configPath}`)

    if (locked && answers.skills) {
      s.start("写入 skills 零拷贝路径")
      mergeSkillsEntry(configPath, SKILLS_LOCAL_SPEC)
      s.stop(`skills 数组已包含 ${SKILLS_LOCAL_SPEC}`)
    } else if (answers.skills) {
      const targets = skillTargets(cwd, mode)
      for (const target of targets) {
        if (existsSync(target.destDir)) {
          const overwrite =
            flags.yes ??
            unwrap<boolean>(await p.confirm({ message: `skill 目录已存在，覆盖吗：${target.destDir}`, initialValue: true }))
          if (!overwrite) {
            p.log.info(`跳过 ${target.name}`)
            continue
          }
        }
        s.start(`拷贝 skill ${target.name}`)
        copySkill(join(cliPackageRoot(), "skills"), target)
        s.stop(`已拷贝 ${target.name} → ${target.destDir}`)
      }
    }
  } catch (error) {
    s.stop("安装失败")
    throw error
  }

  p.outro(
    [
      "安装完成。请重启 OpenCode 使配置生效。",
      locked ? `升级：npm update ${PKG_NAME}` : "升级：npx " + PKG_NAME + " update",
      `排查：npx ${PKG_NAME} doctor`,
    ].join("\n"),
  )
}
