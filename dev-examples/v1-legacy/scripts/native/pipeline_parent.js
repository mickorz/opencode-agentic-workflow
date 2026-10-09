// Native 组合验收 A：父纯编排（零 agent），三段串行 child
export const meta = { name: 'native_pipeline', description: '三段式流水线父编排（纯编排零 agent）' }
phase('编排')
const spec = await workflow('./scripts/native/1_spec.js')
const design = await workflow('./scripts/native/2_design.js', { brief: spec.brief })
const code = await workflow('./scripts/native/3_code.js', { design: design.design })
return { brief: spec.brief, design: design.design, code: code.code }
