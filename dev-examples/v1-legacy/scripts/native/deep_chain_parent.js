// 分支A验收：三层链根（root -> l2 -> l3）
export const meta = { name: 'deep_chain', description: '三层嵌套验收' }
phase('根层')
await agent('用一句话说明什么是 git')
return await workflow('./scripts/native/deep_chain_l2.js')
