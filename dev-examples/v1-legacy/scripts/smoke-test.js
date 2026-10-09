// 冒烟脚本：3 个 agent（1 个发现 + 2 个并行）
// 用法：在 examples/sample-project 目录启动 OpenCode 后，
//       对 Main Agent 说"用 workflow 工具执行 examples 脚本原样如下"并粘贴本文件内容

export const meta = { name: 'smoke_test', description: '最小冒烟：2 个 agent 并行' }

phase('Scan')
const info = await agent('列出你当前目录下的文件，只输出前 10 行')

phase('Echo')
const results = await parallel([
  () => agent('用一句话说明什么是工作流编排'),
  () => agent('用一句话说明什么是确定性重放'),
])
return { info, results }
