// Node Inspector 运行中点击与 Open Session 回归（T09 / T11）：长跑任务，留足观察窗口
// T09：运行中点击未完成节点进 Node Detail，应显示 "No result yet"；
//      完成后不退出不重进，界面在 1-2 秒内自动刷新出结果（Header 状态与 Result 同步更新）
// T11：Node Detail 内按 Enter（Open Session）跳转子会话，sessionID 必须与节点一致且不新建会话，
//      按 Esc 返回 Node Detail，再按 Esc 返回列表
// 用法：同 node-detail-ab-test.js。全程前台约 2-4 分钟

export const meta = { name: 'node_detail_running_click', description: '运行中点击与 Open Session 回归' }

phase('Watch')
const part1 = await parallel([
  () => agent('阅读 docs/config.mdx，用 8 句话总结要点', { label: '观察A' }),
  () => agent('阅读 docs/agents.mdx，用 8 句话总结要点', { label: '观察B' }),
])

phase('Follow')
const part2 = await agent('综合以下两份摘要，输出一段 10 句话的总览\n\n' + part1.join('\n\n'), { label: '汇总' })
return { part2 }
