// Composite V1 验收：sequence 节点内组合 parallel（两实例并发，结果保序）
export const meta = { name: 'composite_seq_par', description: 'sequence 组合 parallel' }
phase('编排')
const lanes = await sequence([
  () => '视角种子',
  (seed) => parallel([
    () => workflow('./scripts/native/1_spec.js', { tag: seed + '-A' }),
    () => workflow('./scripts/native/1_spec.js', { tag: seed + '-B' }),
  ]),
])
return { laneCount: lanes.length, briefs: lanes.map(l => l.brief) }
