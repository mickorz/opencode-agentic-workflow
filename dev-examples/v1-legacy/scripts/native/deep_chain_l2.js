// 分支A验收：三层链中间层（含自己的 agent + 孙层）
export const meta = { name: 'deep_l2', description: '三层链中间层' }
phase('中间层')
await agent('用一句话说明 git rebase 与 merge 的区别')
return await workflow('./scripts/native/deep_chain_l3.js')
