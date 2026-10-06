#!/usr/bin/env node
/**
 * opencode-agentic-workflow 安装器 CLI 入口（P2-10）
 *
 * npx @mickorz/opencode-agentic-workflow <命令> [flags]
 *
 *   ├─> install（默认）  交互式安装；flags 指齐 + --yes 转无头
 *   ├─> update          升级（locked: npm update；其余: 清宿主缓存）
 *   ├─> uninstall       对称卸载（配置条目 + skills + locked 依赖）
 *   ├─> doctor          只读环境排查（[OK]/[WARN]/[FAIL] 清单）
 *   └─> help            帮助
 *
 * flags（install）：--global / --project / --locked、--model <providerID/modelId>、
 *   --agent <id>、--no-journal、--no-skills、--yes
 * flags（uninstall）：--global / --project / --locked（可组合）、--yes
 * flags（update）：--yes
 */

import { runInstall, type InstallFlags } from "./install.js"
import { runUpdate } from "./update.js"
import { runUninstall, type UninstallFlags } from "./uninstall.js"
import { runDoctor } from "./doctor.js"
import type { InstallKind } from "./config.js"

const HELP = `
opencode-agentic-workflow 安装器

用法：npx @mickorz/opencode-agentic-workflow <命令> [flags]

命令：
  install      交互式安装（默认）
  update       升级插件本体与 skills
  uninstall    卸载（与安装对称）
  doctor       环境排查（只读）
  help         显示本帮助

install flags：
  --global / --project / --locked   安装方式（无头必填）
  --model <providerID/modelId>      子会话模型（无头必填）
  --agent <id>                      子会话 agent（缺省 build）
  --no-journal                      不启用 journal 持久化
  --no-skills                       不安装 skills
  --yes                             跳过确认（无头模式）

uninstall flags：
  --global / --project / --locked   要卸载的方式（可组合）
  --yes                             跳过确认
`

function parseArgs(argv: string[]): {
  command: string
  flags: { mode?: InstallKind; kinds: InstallKind[]; model?: string; agent?: string; journal?: boolean; skills?: boolean; yes?: boolean }
} {
  const command = argv[0]?.toLowerCase() ?? "install"
  const out = {
    command,
    flags: { kinds: [] as InstallKind[] },
  } as {
    command: string
    flags: InstallFlags & UninstallFlags & { mode?: InstallKind; kinds: InstallKind[] }
  }
  const args = argv.slice(1)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case "--global":
        out.flags.mode = "global"
        out.flags.kinds.push("global")
        break
      case "--project":
        out.flags.mode = "project"
        out.flags.kinds.push("project")
        break
      case "--locked":
        out.flags.mode = "locked"
        out.flags.kinds.push("locked")
        break
      case "--model":
        out.flags.model = args[++i]
        break
      case "--agent":
        out.flags.agent = args[++i]
        break
      case "--no-journal":
        out.flags.journal = false
        break
      case "--no-skills":
        out.flags.skills = false
        break
      case "--yes":
      case "-y":
        out.flags.yes = true
        break
      default:
        throw new Error(`未知参数：${arg}\n${HELP}`)
    }
  }
  return out
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2))

  switch (command) {
    case "install":
      await runInstall(flags)
      break
    case "update":
      await runUpdate({ yes: flags.yes })
      break
    case "uninstall":
      await runUninstall({ kinds: flags.kinds, yes: flags.yes })
      break
    case "doctor":
      await runDoctor()
      break
    case "help":
    case "--help":
    case "-h":
      console.log(HELP)
      break
    default:
      console.log(`未知命令：${command}`)
      console.log(HELP)
      process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`CLI 执行出错：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
