// P1 tier 回退演示：请求未配置的 tier -> 回退会话默认模型并告警（每 run 每 tier 一次）
// 用法：让 Main Agent 用 workflow 工具执行本脚本（scriptPath 传本文件路径）
// 配置真实 tier 的方法见 Docs/03_测试指南/P1测试指南.md 测试三

export const meta = { name: 'tier_fallback_demo', description: 'P1 tier 回退演示：未配置 tier 回退默认模型并告警' }

const reply = await agent('用一句话说明你是什么模型，以及你如何理解"分层路由"', {
  tier: 'nonexistent-tier',
  label: 'tier回退',
})
return reply
