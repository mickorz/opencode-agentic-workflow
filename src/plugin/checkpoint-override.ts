/**
 * checkpoint 覆盖（P3 Blocker 修复：守护进程单例投毒）
 *
 * 背景：插件在 init 时把 checkpoint gate 绑成 module 单例；OpenCode 的
 * 长驻 server 进程可能附着旧插件实例，新项目的 opencode.json 配置
 * （checkpoint.mode 等）被完全无视——实测 auto-approve 被静默替换成
 * 交互门（5 分钟超时假失败）+ 观测数据写进别的项目。
 *
 * 修复策略：**运行时显式 > 环境隐式**。workflow 工具新增保留参数
 * `checkpointMode`，调用时为**本次 run** 构建策略门，经 P2-9 的
 * run 级上下文（RunLaunchOptions.gate）注入——不再换装全局门，
 * 无恢复交叠竞态，对守护进程宿主与并发调用天然免疫。
 *
 * 范围收敛（v0.4.0）：只支持策略门（auto-approve / auto-reject）——
 * interactive 门需要 RPC 域 + bind() 注册，按调用创建会累积 RPC
 * 注册且无 unbind 通道，保持「仅限插件配置」。
 */

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
 * 为本次调用构建覆盖门（无覆盖返回 undefined——run 走默认 gate 链：
 * run 上下文继承 / 全局绑定）。
 */
export function buildCheckpointGate(
  mode: CheckpointModeOverride | undefined,
): PolicyCheckpointGate | undefined {
  if (!mode) return undefined
  console.log(
    `[agentic-workflow] checkpoint gate for this run: ${mode} ` +
      "(explicit per-call control; init-time config may differ)",
  )
  return new PolicyCheckpointGate(mode)
}
