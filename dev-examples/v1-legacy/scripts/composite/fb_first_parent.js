// Composite V1 验收：fallback 首个候选成功即返回，后续完全跳过
// 后置 agent 两用：满足纯编排校验 + 验证 fallback 结束后父脚本继续
export const meta = { name: 'composite_fb_first', description: 'fallback 首选成功' }
phase('编排')
const r = await fallback([
  () => ({ provider: 'fast', note: '快路径直接成功' }),
  () => workflow('./scripts/native/1_spec.js'),
])
const after = await agent('回复固定文本：AFTER-FAST')
return { winner: r.provider, after }
