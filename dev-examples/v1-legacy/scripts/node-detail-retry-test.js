// Node Inspector 多次执行验收（T12）：可恢复失败自动重试，底层保留全部执行记录
// 预期：agent 1ms 超时属可恢复失败，重试 3 次耗尽后塌缩为 null（节点 failed）；
//       数据面：.opencode-workflows/journal/<runId>.json 中该节点 entry 的 executions 数组
//       应有 4 条记录（attempt 1..4，全部 failed），互不覆盖；
//       UI 面：Node Detail 显示 Error（最新一次执行的错误），不显示中间尝试
// 注："重试后成功"的稳定制造依赖真实网络抖动，该子场景由单元测试覆盖（fake runner 注入）
// 用法：同 node-detail-ab-test.js。数秒内结束

export const meta = { name: 'node_detail_retry', description: '重试多 execution：数据结构支撑多条记录' }

phase('Retry')
const outcome = await agent('这个任务每次都会超时（用于制造重试）', { label: '重试对象', timeoutMs: 1, retries: 3 })
return { outcome }
