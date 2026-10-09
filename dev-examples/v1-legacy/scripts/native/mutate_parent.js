// 验收：args 克隆隔离（父对象不受 child 影响）
export const meta = { name: 'mutate_parent', description: 'args 克隆隔离验收' }
phase('隔离验证')
const cfg = { counter: 1 }
await workflow('./scripts/native/mutate_child.js', { cfg })
return { counter: cfg.counter, injected: 'injected' in cfg }
