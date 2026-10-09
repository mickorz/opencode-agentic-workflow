// 验收：深度限制（child 内再调一层 child）
export const meta = { name: 'deep_child', description: '深度限制验收' }
await agent('深层任务')
return await workflow('./scripts/native/1_spec.js')
