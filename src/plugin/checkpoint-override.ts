/**
 * checkpoint 覆盖（P3 Blocker 修复：守护进程单例投毒）
 *
 * 背景：插件在 init 时把 checkpoint gate 绑成 module 单例；OpenCode 的
 * 长驻 server 进程可能附着旧插件实例，新项目的 opencode.json 配置
 * （checkpoint.mode 等）被完全无视——实测 auto-approve 被静默替换成
 * 交互门（5 分钟超时假失败）+ 观测数据写进别的项目。
 *
 * 修复策略：**运行时显式 > 环境隐式**。workflow 工具新增保留参数
 * `checkpointMode`，调用时显式覆盖本次运行的审批门，结束恢复原绑定。
 * 对守护进程宿主天然免疫（参数随调用走，不依赖 init 快照）。
 *
 * 范围收敛（v0.4.0）：只支持策略门（auto-approve / auto-reject）——
 * interactive 门需要 RPC 域 + bind() 注册，按调用创建会累积 RPC
 * 注册且无 unbind 通道，保持「仅限插件配置」。
 *
 * 已知限制：全局 gate 仍是单例，两个并发调用携带不同覆盖值时存在
 * 竞态（restore 交叠）。per-run gate 线程化是后续 L 范围工作；
 * 单会话 `opencode run` / TUI 串行场景不受影响。
 */

import { getCheckpointGate, setCheckpointGate } from "../quality/checkpoint.js"
import { PolicyCheckpointGate } from "./policy-checkpoint-gate.js"

/** 可作为调用级覆盖的审批模式（策略门子集） */
export type CheckpointModeOverride = "auto-approve" | "auto-reject"

export function parseCheckpointModeOverride(
  value: unknown,
): CheckpointModeOverride | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (value === "auto-approve" || value === "auto-reject") return value
  if (value === "interactive") {
    console.log(
      "[agentic-workflow] checkpointMode=interactive is not available as an " +
        "invocation override (requires TUI plugin config); ignoring",
    )
    return undefined
  }
  console.log(
    `[agentic-workflow] invalid checkpointMode override ignored: ${String(value)}`,
  )
  return undefined
}

/**
 * 为**本次**调用绑定覆盖门；返回恢复函数（无覆盖时返回 undefined）。
 * 必须在 finally 中调用恢复函数，防止覆盖泄漏到后续调用。
 */
export function applyCheckpointModeOverride(
  mode: CheckpointModeOverride | undefined,
): (() => void) | undefined {
  if (!mode) return undefined
  const previous = getCheckpointGate()
  setCheckpointGate(new PolicyCheckpointGate(mode))
  console.log(
    `[agentic-workflow] checkpoint gate override for this invocation: ${mode} ` +
      "(explicit per-call control; init-time config may differ)",
  )
  return () => setCheckpointGate(previous)
}
