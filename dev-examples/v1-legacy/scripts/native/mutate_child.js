// 验收：args 克隆隔离（child 内改动不外溢）
export const meta = { name: 'mutate_child', description: 'args 突变子流程' }
args.cfg.counter = 999
args.cfg.injected = true
return await agent('回复 ok')
