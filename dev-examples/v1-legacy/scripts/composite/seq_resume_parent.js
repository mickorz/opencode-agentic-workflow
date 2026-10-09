// Composite V1 验收：resume 下 sequence 内 agent 全量回放
// 结构关键：sequence（callIndex 0/1）在前，可变的父 agent（callIndex 2）在后——
// 改父 prompt 只触发 firstMiss=2，sequence 内两个 agent 因前缀未变而回放
export const meta = { name: 'composite_seq_resume', description: 'sequence resume 回放' }
phase('编排')
const r = await sequence([
  () => agent('回复固定文本：SEQ-NODE-1'),
  (prev) => agent('把上一步的返回文本原样重复一遍，不要加任何其他字：' + prev),
])
phase('前置')
const parentReply = await agent('回复固定文本：PARENT-PROBE-2')
return { parent: parentReply, seq: r }
