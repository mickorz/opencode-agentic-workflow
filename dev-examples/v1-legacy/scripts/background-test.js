// P2 后台运行演示：background 参数 + workflow_control 控制
// 用法：让 Main Agent 用 workflow 工具执行本脚本（scriptPath 传本文件路径）（脚本会作为 background: true 的 workflow 调用提交）
// 提示词：用 workflow 工具执行 scripts/background-test.js，scriptPath 传该路径，并传 background: true

export const meta = { name: 'bg_demo', description: 'P2 后台运行演示：3 个 agent 扇出' }

phase('Analyze')
const findings = await parallel([
  () => agent('用两句话说明什么是后台工作流', { label: '解释1' }),
  () => agent('用两句话说明什么是运行注册表', { label: '解释2' }),
  () => agent('用两句话说明结果回传的意义', { label: '解释3' }),
])

phase('Summarize')
return await agent('综合以下三段解释，输出一段总结\n\n' + findings.join('\n\n'), { label: '总结' })
