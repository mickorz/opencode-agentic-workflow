/**
 * phase() —— 标记当前工作流阶段（P0 仅 metadata + log）
 *
 * P1+ 逐步扩展为 trace / progress / TUI / metrics / journal 的挂载点。
 */

export function phase(name: string): void {
  console.log(`[agentic-workflow] phase: ${name}`)
}
