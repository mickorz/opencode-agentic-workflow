// 多树同显验收脚本 A（较短）：3 并行 + 1 汇总，约 30 到 50 秒
// 与 multi-tree-b.js 搭配使用：先后以后台方式启动，sidebar 应同时出现两棵独立的 workflow 树
// 用法：在 examples/sample-project 目录启动 OpenCode 后，对 Main Agent 说：
//       "用 workflow 工具执行 scripts/multi-tree-a.js，scriptPath 传该路径并传 background: true，不要粘贴脚本内容"

export const meta = { name: 'multi_tree_a', description: '多树同显验收 A 树：3 并行 + 1 汇总' }

phase('Analyze')
const findings = await parallel([
  () => agent('阅读 docs/config.mdx，用 2 句话总结核心内容', { label: 'A配置' }),
  () => agent('阅读 docs/agents.mdx，用 2 句话总结核心内容', { label: 'A代理' }),
  () => agent('阅读 docs/commands.mdx，用 2 句话总结核心内容', { label: 'A命令' }),
])

phase('Summarize')
const summary = await agent('综合以下 3 段摘要，输出 3 行总览\n\n' + findings.join('\n\n'), { label: 'A汇总' })
return { summary }
