// 验收：resume 跨 scope（父前置 agent + child）
export const meta = { name: 'resume_parent', description: 'resume 父编排' }
phase('前置')
await agent('回复固定文本：PARENT-PROBE')
return await workflow('./scripts/native/resume_child.js')
