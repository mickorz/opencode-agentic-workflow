// race 慢路：单 agent 深度分析（耗时长，作为被取消方）
export const meta = { name: 'race_slow', description: 'race 慢路候选' }
phase('慢路分析')
const deep = await agent('深入分析这个仓库的架构并写 500 字报告（慢慢写，写详细些）', { label: '慢路分析' })
return { lane: 'slow', deep }
