// TUI 增强验收（#32/#33/#34）：三节点并行观察
// A 限时重试节点：8s 超时 x 重试 2 -> 侧栏应见 (2/3) 前缀与 /8s 上限
// B 无上限节点：无 timeoutMs -> 纯计时（无 /xx 后缀）
// C 长上限节点：90s 上限 -> 计时后缀 /1m
// A 三次尝试全部超时耗尽 -> 下一 phase 边界触发失败闸门（预期报错，属验收点之一）
export const meta = { name: 'tui_enhance', description: '重试进度与超时上限显示验收' }
phase('观察')
const rs = await parallel([
  () => agent('慢慢分析这个目录的结构，写 300 字报告（要超过 25 秒）', { label: '限时重试节点', timeoutMs: 8000, retries: 2 }),
  () => agent('慢慢分析这个目录的用途，写 300 字报告（要超过 40 秒）', { label: '无上限节点' }),
  () => agent('用两三句话概括这个目录', { label: '长上限节点', timeoutMs: 90000 }),
])
phase('汇总')
return rs.length
