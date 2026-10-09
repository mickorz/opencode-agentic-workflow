// 嵌套链条中间层：并行启动两个子 workflow（chain-leaf.js）
// 每个 leaf 经 agentType general 的子代理调用 workflow 工具完成（general 权限 "*" allow，可用插件工具）
// 验证点：workflow 内 agent() 的子代理能否再次触发 workflow 工具，形成 middle -> leaf 嵌套

export const meta = { name: 'chain_middle', description: '嵌套链中间层：并行两个子 workflow 再汇总' }

const leafScriptPath = 'scripts/chain-leaf.js'

// 组装 leaf 调用：要求子代理调 workflow 工具跑 leaf 脚本，完成后原样回传结果 JSON
const callLeaf = (topic, tag) => agent(
  `请调用 workflow 工具执行一个子工作流，参数要求：\n` +
  `- scriptPath: "${leafScriptPath}"\n` +
  `- args: {"topic": "${topic}"}\n` +
  `不要传 background，不要传 script（二选一规则）。必须等子工作流真正执行完成。\n` +
  `完成后把 workflow 返回的最终结果 JSON 原样作为你的回复输出，不要添加解释文字。`,
  { label: `子workflow:${tag}`, agentType: 'general', timeoutMs: 300000 },
)

phase('FanOut')
log('并行启动两个叶子 workflow')
const leaves = await parallel([
  () => callLeaf('权限系统与 permission 配置', '权限'),
  () => callLeaf('session 与 message 的数据模型', '数据模型'),
])

phase('Merge')
const merged = await agent(
  `下面是两份来自子工作流的分析结果，请合并为一段 3 句话的总结，并保留各自的 topic 字段：\n\n` +
  JSON.stringify(leaves, null, 2),
  { label: '中间层汇总' },
)

return { leaves, merged }
