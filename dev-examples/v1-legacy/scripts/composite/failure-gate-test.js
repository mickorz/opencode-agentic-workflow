// Bug1 修复实机验收：阶段失败闸门
// Test1 主链路：失败节点(1ms 超时注入) -> 下一 phase() 边界终止并报告
// Test2 同 phase 收尾：失败后同阶段 tail 节点照常执行，边界才拦
export const meta = { name: 'failure_gate', description: '阶段失败闸门实机验收' }
phase('执行')
// timeoutMs:1 做确定性失败注入（1ms 必超时；retries:0 立即耗尽触发闸门）
const bad = await agent('回复任意文本（此调用 1ms 超时必失败）', { label: '会失败的节点', timeoutMs: 1, retries: 0 })
// Test2 验收点：同 phase 后续 agent 照常收尾（阶段边界才拦）
const tail = await agent('回复固定文本：收尾成功', { label: '同阶段收尾' })
phase('汇总')
return { bad, tail }
