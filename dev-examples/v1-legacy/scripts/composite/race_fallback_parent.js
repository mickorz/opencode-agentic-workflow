// Composite V1 P1 验收：race + fallback + sequence 三层组合（决策树形态）
export const meta = { name: 'composite_race_fb', description: '组合控制流综合' }
phase('编排')
const result = await sequence([
  () => '仓库内 Composite 控制流的改动（race/sequence/fallback 节点）',
  (task) => race([
    () => agent('判断任务类型（快速）：' + task + '，只回答一个词', { label: '快判' }),
    () => workflow('./scripts/composite/race_slow.js'),
  ]),
  (verdict) => fallback([
    () => agent('基于判断给出执行方案：' + verdict, { label: '方案生成' }),
    () => ({ source: 'rule-based', note: '生成失败时的规则兜底' }),
  ]),
])
return { result }
