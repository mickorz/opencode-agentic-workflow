// Node Inspector 失败态验收（T08）：成功与失败混合，验证 Error UI 不崩溃、不显示 undefined
// 预期：失败节点 Node Detail 显示 Error 区块（含超时错误消息），Result 区不出现 undefined 或 [object Object]；
//       对照组节点正常显示结果。sidebar 节点行出现失败图标与错误摘要行
// 用法：同 node-detail-ab-test.js。数秒内结束（1ms 超时立即失败）

export const meta = { name: 'node_detail_failed', description: '失败态：Error UI 验收' }

phase('Mixed')
const results = await parallel([
  () => agent('总结 docs/config.mdx 的主题，输出 3 句话', { label: '对照组-成功' }),
  () => agent('这个任务必定超时', { label: '超时失败A', timeoutMs: 1 }),
  // retries:1 的可恢复失败耗尽路径：节点同样 failed，且 journal 该节点 executions 应有 2 条尝试
  () => agent('这个任务也必定超时', { label: '超时失败B', timeoutMs: 1, retries: 1 }),
])
return { results }
