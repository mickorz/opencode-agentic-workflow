// flows/sentence-demo.js —— 本地联调冒烟：2 个子流程各写一句话，父流程合并
// 验证链路：legacy js 装载 → subflow（workflow() 全局）→ parallel → journal/面板
// 跑法：在 dev-examples/local-dev 目录下对 agent 说
//   「用 workflow 工具跑 sentence_demo，args.topic=雨，checkpointMode=auto-approve」
export const meta = {
  name: 'sentence_demo',
  description: '本地联调冒烟：2 个子流程各写一句话，父流程合并',
}

phase('Gather')
const results = await parallel([
  () => workflow('./sentence-a.js', { topic: args.topic }),
  () => workflow('./sentence-b.js', { topic: args.topic }),
])

phase('Merge')
const lines = results.map((r, i) =>
  r && typeof r.output === 'string' && r.output.trim() ? r.output.trim() : `（第 ${i + 1} 句未返回）`,
)
log('两句分列：', lines)
return { output: lines.join(''), sentences: lines }
