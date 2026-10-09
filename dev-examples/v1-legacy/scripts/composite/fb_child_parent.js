// Composite V1 验收：fallback 候选为 child workflow，失败换下一候选
// 核心验证：child 脚本 throw 不再污染整 run 中止面（poisoning 修正）
export const meta = { name: 'composite_fb_child', description: 'fallback child 候选换链' }
phase('编排')
const r = await fallback([
  () => workflow('./scripts/native/error_child.js'),
  () => workflow('./scripts/native/1_spec.js', { tag: 'FALLBACK' }),
])
const after = await agent('回复固定文本：AFTER-FALLBACK')
return { winner: r, after }
