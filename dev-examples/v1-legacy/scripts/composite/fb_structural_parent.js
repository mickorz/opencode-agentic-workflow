// Composite V1 验收：结构性错误必须上抛，fallback 不吞编程错误
export const meta = { name: 'composite_fb_struct', description: 'fallback 结构性错误' }
phase('编排')
const r = await fallback([
  () => workflow('./scripts/native/不存在的脚本.js'),
  () => ({ provider: 'backup' }),
])
return { winner: r }
