// 验收：深度限制（root -> deep_child -> 1_spec 两层）
export const meta = { name: 'deep_parent', description: '深度限制父编排' }
return await workflow('./scripts/native/deep_child.js')
