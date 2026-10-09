// Composite V1 验收：sequence 三段串行（纯编排父，prev 链传递）
// 与 native/pipeline_parent.js 等价——旧写法 await 链 vs sequence 重写的实机对照
export const meta = { name: 'composite_seq', description: 'sequence 三段流水线父编排' }
phase('编排')
const code = await sequence([
  () => workflow('./scripts/native/1_spec.js'),
  (spec) => workflow('./scripts/native/2_design.js', { brief: spec.brief }),
  (design) => workflow('./scripts/native/3_code.js', { design: design.design }),
])
return { lastNodeValue: code, chain: 'spec->design->code 经 prev 传递' }
