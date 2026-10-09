// Native 组合验收：阶段二（概要设计，消费上段结果）
export const meta = { name: 'native_design', description: '三段流水线第二段' }
phase('概要设计')
const design = await agent('基于以下需求写一句概要设计（一个主循环+一个存储）：' + args.brief, { label: '概要设计' })
return { design, basedOn: args.brief }
