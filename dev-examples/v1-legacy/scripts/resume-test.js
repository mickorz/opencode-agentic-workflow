// P1 journal/resume 演示：3 个顺序 agent（第一步：首跑建立 journal）
// 用法：让 Main Agent 用 workflow 工具执行本脚本（scriptPath 传本文件路径），记下输出里的 runId；
//       第二步见 Docs/03_测试指南/P1测试指南.md（改 B 的 prompt + resumeFromRunId 重跑）

export const meta = { name: 'resume_demo', description: 'P1 journal/resume 演示：3 个 agent 顺序调用' }

phase('Explain')
const a = await agent('用一句话解释什么是 SHA256 哈希', { label: 'A-哈希' })
const b = await agent('用一句话解释什么是最长未变前缀', { label: 'B-前缀' })
const c = await agent('用一句话解释什么是缓存回放', { label: 'C-回放' })
return { a, b, c }
