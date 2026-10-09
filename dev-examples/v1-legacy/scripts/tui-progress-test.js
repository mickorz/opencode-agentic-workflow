// TUI 实时树验收脚本（F-20 / TA-01a 前台通道）：4 个并行分析 + 1 个汇总
// 运行时长足够（每个 agent 真实调 LLM 十几秒），可从容观察 sidebar 实时树的变化
// 用法：在 examples/sample-project 目录启动 OpenCode 后，对 Main Agent 说：
//       "用 workflow 工具执行 scripts/tui-progress-test.js，scriptPath 传该路径，不要粘贴脚本内容"

export const meta = { name: 'tui_progress', description: 'TUI 实时树验收：4 并行 + 1 汇总' }

phase('Analyze')
const findings = await parallel([
  () => agent('阅读 docs/config.mdx，用 3 句话总结：主题、关键 API、适用场景', { label: 'config' }),
  () => agent('阅读 docs/agents.mdx，用 3 句话总结：主题、关键 API、适用场景', { label: 'agents' }),
  () => agent('阅读 docs/custom-tools.mdx，用 3 句话总结：主题、关键 API、适用场景', { label: 'custom-tools' }),
  () => agent('阅读 docs/commands.mdx，用 3 句话总结：主题、关键 API、适用场景', { label: 'commands' }),
])

phase('Summarize')
const summary = await agent('综合以下 4 份文档摘要，输出 5 行总览\n\n' + findings.join('\n\n'), { label: '汇总' })
return { summary }
