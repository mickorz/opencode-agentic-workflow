// Composite V1 验收：sequence 内节点可恢复失败立即停止，返回 null
export const meta = { name: 'composite_seq_fail', description: 'sequence 失败终止' }
phase('编排')
const seen = []
const r = await sequence([
  () => { seen.push('a'); return 'step-a' },
  () => { seen.push('b'); throw new Error('第二个节点故意失败') },
  () => { seen.push('c'); return 'never' },
])
const after = await agent('回复固定文本：STOP-CHECK')
return { seqResult: r, isNull: r === null, seen, after }
