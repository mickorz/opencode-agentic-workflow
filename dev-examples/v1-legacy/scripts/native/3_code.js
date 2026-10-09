// Native 组合验收：阶段三（伪代码，消费上段结果）
export const meta = { name: 'native_code', description: '三段流水线第三段' }
phase('伪代码')
const code = await agent('把以下设计转成 3 行伪代码：' + args.design, { label: '伪代码' })
return { code }
