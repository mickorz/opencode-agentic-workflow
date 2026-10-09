// 嵌套链条叶子 workflow（最底层）：单 agent 做主题要点分析
// 由上层 chain-middle.js 经 general 子代理调用 workflow 工具触发（scriptPath 指向本文件）
// 验证点：被嵌套执行的 workflow 自身能正常完成 run 并返回结构化结果

export const meta = { name: 'chain_leaf', description: '嵌套链叶子：单 agent 主题要点分析' }

// 上层可经 args 下发主题；直接单独跑也有缺省值
const topic = args?.topic ?? 'opencode 插件的 tool 注册机制'

const text = await agent(
  `阅读 docs/plugins.mdx，围绕主题「${topic}」给出 3 句以内的要点总结。`,
  { label: `叶子:${String(topic).slice(0, 12)}` },
)

return { topic, leafSummary: text }
