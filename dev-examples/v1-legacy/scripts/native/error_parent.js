// 验收：父捕获 child 错误并降级
export const meta = { name: 'error_parent', description: '子流程错误上抛验收' }
phase('错误处理')
let failed = null
try {
  await workflow('./scripts/native/error_child.js')
} catch (e) {
  failed = String(e.message || e)
}
return { caught: failed !== null, message: failed }
