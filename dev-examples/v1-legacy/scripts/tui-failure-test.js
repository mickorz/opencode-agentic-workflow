// TUI 失败态验收脚本：每个 agent 1ms 超时，全部立即失败（快速观察 ✖ 图标与 ↳ 错误行）
// 用法：同 tui-progress-test.js，让 Main Agent 用 workflow 工具执行本脚本（scriptPath 传本文件路径）

export const meta = { name: 'tui_failure', description: 'TUI 失败态验收：全部立即超时' }

phase('Analyze')
const results = await parallel([
  () => agent('总结 docs/config.mdx 的主题', { label: '快失败A', timeoutMs: 1 }),
  () => agent('总结 docs/agents.mdx 的主题', { label: '快失败B', timeoutMs: 1 }),
])
return { results }
