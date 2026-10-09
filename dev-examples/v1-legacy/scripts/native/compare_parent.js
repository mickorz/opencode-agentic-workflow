// Native 组合验收 B：同脚本三实例并行（label 区分 + args 隔离）
export const meta = { name: 'native_compare', description: 'parallel 三 child 同定义不同实例' }
phase('模型对比')
const rs = await parallel([
  () => workflow({ scriptPath: './scripts/native/1_spec.js', label: 'lane_a' }, { tag: 'A' }),
  () => workflow({ scriptPath: './scripts/native/1_spec.js', label: 'lane_b' }, { tag: 'B' }),
  () => workflow({ scriptPath: './scripts/native/1_spec.js', label: 'lane_c' }, { tag: 'C' }),
])
return rs.map((r) => r.brief)
