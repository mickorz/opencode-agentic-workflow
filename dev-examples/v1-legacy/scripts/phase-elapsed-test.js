// Phase 耗时实时显示验收脚本（TUI phase · Ns 功能）
// 验证点（观察 sidebar 树与 /workflow 全屏路由两处）：
//  1. 每个 phase 标题行右侧出现 · Ns（整数秒，无小数点）
//  2. running 的 phase 耗时随轮询递增（约 3 秒一跳）；完成后定格不再变
//  3. running 节点行显示整数秒实时耗时（如 · 12s）；完成态节点保持一位小数（如 · 12.4s）
//  4. 第二阶段两个并行 agent 重叠执行，phase 定格耗时应小于两节点耗时之和（墙钟口径不重复计费）
// 用法：在 examples/sample-project 目录启动 OpenCode 后，对 Main Agent 说：
//       "用 workflow 工具执行 scripts/phase-elapsed-test.js，scriptPath 传该路径，不要粘贴脚本内容"
// 备注：任务刻意选长文本多文件（全量通读 + 逐项罗列），拉长每个 agent 的执行时间便于观察递增

export const meta = { name: 'phase_elapsed_test', description: 'phase 耗时实时显示验收' }

phase('准备')
const overview = await agent(
  '通读 docs/config.mdx 全文，逐节罗列出现过的每一个配置项名称与一句话作用，不要遗漏',
  { label: '配置清单' },
)

phase('并行调查')
const details = await parallel([
  () => agent(
    '通读 docs/cli.mdx 全文，列出全部子命令及各自用途，并对每个子命令补一句典型用法示例',
    { label: 'cli 详解' },
  ),
  () => agent(
    '通读 docs/agents.mdx 全文，列出内置 agent 的名称、权限差异与适用场景，并说明自定义 agent 的定义方式',
    { label: 'agents 详解' },
  ),
])

phase('汇总')
const report = await agent(
  '根据以下三份调查材料，写一段 10 行以内的汇总：配置体系要点、CLI 能力全景、agent 体系结论\n\n' +
    '[配置清单]\n' + overview + '\n\n[cli 详解]\n' + details[0] + '\n\n[agents 详解]\n' + details[1],
  { label: '总报告' },
)
return { report }
