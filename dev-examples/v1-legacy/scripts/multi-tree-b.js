// 多树同显验收脚本 B（较长）：两轮串行 phase 各 2 并行，约 60 到 100 秒
// 设计意图：A 树（multi-tree-a）完成后本脚本仍在运行，用于验证"完成树与运行树并存"
// 以及"后台 run 完成回传期间快照保持终态不再复活为 running"
// 用法：在 examples/sample-project 目录启动 OpenCode 后，对 Main Agent 说：
//       "用 workflow 工具执行 scripts/multi-tree-b.js，scriptPath 传该路径并传 background: true，不要粘贴脚本内容"

export const meta = { name: 'multi_tree_b', description: '多树同显验收 B 树：两轮 2 并行' }

phase('FirstPass')
const round1 = await parallel([
  () => agent('阅读 docs/custom-tools.mdx，用 2 句话总结核心内容', { label: 'B自定义工具' }),
  () => agent('阅读 docs/cli.mdx，用 2 句话总结核心内容', { label: 'B命令行' }),
])

phase('SecondPass')
const round2 = await parallel([
  () => agent('阅读 docs/acp.mdx，用 2 句话总结核心内容', { label: 'B协议' }),
  () => agent('阅读 docs/github.mdx，用 2 句话总结核心内容', { label: 'B集成' }),
])

return { round1, round2 }
