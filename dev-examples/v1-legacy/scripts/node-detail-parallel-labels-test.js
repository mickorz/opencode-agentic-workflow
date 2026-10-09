// Node Inspector 并行同 label 验收（T06）：20 个并行 agent 共用同一个 label "scan"
// 验证：节点索引与结果映射走 node.id（runId:callIndex），label 重复不串位——
//       逐个打开节点，Prompt 与 Result 必须指向同一份文档，结果数组位置与定义顺序一致
// 用法：同 node-detail-ab-test.js。约 1-3 分钟（concurrency 缺省 CPU 核数-2，分批完成）

export const meta = { name: 'node_detail_parallel_labels', description: '并行 20 agent 同 label：executionId 映射不串位' }

phase('Scan')
const docs = ['acp', 'agents', 'cli', 'commands', 'config', 'custom-tools', 'ecosystem', 'enterprise', 'formatters', 'github']
// 同一批文档跑两轮：同 label 且两轮 prompt 完全相同，是最严苛的串位检验
const results = await parallel(
  docs.concat(docs).map((name) => () =>
    agent(`用一句话总结 docs/${name}.mdx 的主题，句中必须出现文档名 ${name}`, { label: 'scan' })
  )
)
return { count: results.length, results }
