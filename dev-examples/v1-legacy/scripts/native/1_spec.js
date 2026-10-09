// Native 组合验收：阶段一（需求概述；tag 供并行对比实例区分）
export const meta = { name: 'native_spec', description: '三段流水线第一段' }
phase('需求概述')
const brief = await agent('用两句话概括"定时任务调度器"的核心需求（视角编号 ' + (args.tag ?? 'X') + '），不要展开', { label: '需求概述' })
return { brief }
