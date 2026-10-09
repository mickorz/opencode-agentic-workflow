// 嵌套链条根 workflow（最上层）：经 general 子代理启动 chain-middle.js
// middle 内部再并行两个 chain-leaf.js，形成 root -> middle -> leaf 三层串联
// 验证点：workflow 嵌套 workflow 的完整链路（journal 应出现 4 个 runId：root/middle/leaf x2）

export const meta = { name: 'chain_root', description: '嵌套链根：串联 middle 与 leaf 两层子 workflow' }

phase('Launch')
log('启动中间层子 workflow（其内部将再嵌套两个叶子）')
const middle = await agent(
  `请调用 workflow 工具执行一个子工作流，参数要求：\n` +
  `- scriptPath: "scripts/chain-middle.js"\n` +
  `不要传 args，不要传 background，不要传 script（二选一规则）。必须等子工作流真正执行完成。\n` +
  `完成后把 workflow 返回的最终结果 JSON 原样作为你的回复输出，不要添加解释文字。`,
  { label: '子workflow:middle', agentType: 'general', timeoutMs: 600000 },
)

phase('Report')
const report = await agent(
  `以下是一次三层嵌套工作流（root -> middle -> 两个并行 leaf）的产出，请用 3 句话总结核心结论：\n\n` +
  (typeof middle === 'string' ? middle : JSON.stringify(middle)),
  { label: '根汇总' },
)

return { middle, report }
