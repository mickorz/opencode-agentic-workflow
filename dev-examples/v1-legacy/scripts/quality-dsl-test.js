// P1 质量 DSL 演示：judgePanel 评审团 + verify 对抗验证 + checkpoint 人工确认
// 用法：让 Main Agent 用 workflow 工具执行本脚本（scriptPath 传本文件路径）；checkpoint 处会弹权限确认（允许=true / 拒绝=false）

export const meta = { name: 'quality_demo', description: 'P1 质量 DSL：judgePanel + verify + checkpoint' }

phase('Generate')
const attempts = await parallel([
  () => agent('给"文档审查工作流"起一个 3 到 5 个词的英文名字，只输出名字本身', { label: '候选-英文' }),
  () => agent('给"文档审查工作流"起一个朗朗上口的中文短语，只输出短语本身', { label: '候选-中文' }),
])

phase('Judge')
const best = await judgePanel(attempts, { judges: 2, rubric: '作为工作流名字的贴切与易记程度' })

phase('Verify')
const verdict = await verify(best.attempt, { reviewers: 2 })

phase('Gate')
const adopted = await checkpoint('是否采用胜出的名字？', { default: true })
return { attempts, best: { index: best.index, score: best.score, attempt: best.attempt }, verdict: { real: verdict.real, realCount: verdict.realCount }, adopted }
