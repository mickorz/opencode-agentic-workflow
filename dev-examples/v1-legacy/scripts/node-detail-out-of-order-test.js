// Node Inspector 乱序完成验收（T07）：3 个 agent 按任务体量拉开耗时，完成顺序与定义序颠倒
// 设计：定义序为 重 中 轻（重任务在最前），但体量决定完成序为 轻 中 重——
//       最先定义的最晚完成，最后定义的最先完成，构成「完成先后与列表顺序无关」的反差
// 验证：运行期间各节点状态按自身 executionId 独立翻转（running 变 ok 的先后与列表顺序相反），
//       TUI 列表顺序始终按脚本定义序（重 中 轻）；每个节点完成后 Result 各自出现，不错位
// 用法：同 node-detail-ab-test.js。运行期间用命令面板 "Open workflow view" 进 /workflow 持续观察

export const meta = { name: 'node_detail_out_of_order', description: '并行乱序完成：状态按 executionId 更新' }

phase('Stagger')
const staggered = await parallel([
  () => agent(
    '阅读 docs/cli.mdx、docs/commands.mdx、docs/custom-tools.mdx、docs/ecosystem.mdx，'
    + '每个文档用 10 句话总结，最后合并为一段总览',
    { label: '重任务' }
  ),
  () => agent('阅读 docs/config.mdx 与 docs/agents.mdx，各用 5 句话总结', { label: '中任务' }),
  () => agent('只输出一个词：quick', { label: '轻任务' }),
])
return { staggered }
