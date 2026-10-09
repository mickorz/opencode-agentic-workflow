// 验收：child 业务失败直接上抛（父 try-catch 自理）
export const meta = { name: 'error_child', description: '故意抛错的子流程' }
await agent('检查产物闸门')
throw new Error('child 业务失败：产物闸门未通过')
