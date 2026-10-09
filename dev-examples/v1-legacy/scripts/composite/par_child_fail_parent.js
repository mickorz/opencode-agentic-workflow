// Composite V1 验收：parallel 内 child 失败塌缩为 null（poisoning 修正后的文档语义）
// 旧版行为：child throw 杀整个 run；新版：对应槽位 null，兄弟分支照常完成
export const meta = { name: 'composite_par_fail', description: 'parallel child 失败塌缩' }
phase('编排')
const rs = await parallel([
  () => workflow('./scripts/native/error_child.js'),
  () => workflow('./scripts/native/1_spec.js', { tag: 'SIBLING' }),
])
return { len: rs.length, failedLane: rs[0] === null ? 'collapsed-null' : 'unexpected', okLane: rs[1]?.brief }
