// 验收：自环拒绝（root 触发自环 child）
export const meta = { name: 'self_ref_parent', description: '自环父编排' }
return await workflow('./scripts/native/self_ref.js')
