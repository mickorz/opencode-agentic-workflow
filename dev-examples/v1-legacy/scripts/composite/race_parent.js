// Composite V1 P1 验收：race 多路竞争，首个成功胜出，其余取消
// 慢路 child 内含两个 agent：第一个挂起等取消（验证局部中止面传播），第二个不应执行
export const meta = { name: 'composite_race', description: 'race 竞争择优' }
phase('编排')
const winner = await race([
  () => workflow('./scripts/composite/race_slow.js'),
  () => agent('用一句话回答：2+2 等于几', { label: '快路' }),
])
const after = await agent('回复固定文本：AFTER-RACE')
return { winner, after }
