// 验收：自环拒绝（child 调用自身）
export const meta = { name: 'self_ref', description: '自环拒绝验收' }
await agent('第一步')
return await workflow('./scripts/native/self_ref.js')
