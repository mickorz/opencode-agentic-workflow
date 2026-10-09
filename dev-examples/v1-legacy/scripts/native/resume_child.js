// 验收：resume 跨 scope（child 的 agent 可回放）
export const meta = { name: 'resume_child', description: 'resume 子流程' }
phase('子阶段')
return await agent('回复固定文本：RESUME-PROBE')
