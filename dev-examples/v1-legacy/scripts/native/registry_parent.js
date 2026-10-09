// v0.10 验收：按注册名引用（schedule-test.js 已在注册目录，id=schedule_test）
export const meta = { name: 'registry_demo', description: '注册名引用验收' }
phase('按名引用')
const r = await workflow('schedule_test')
return r
