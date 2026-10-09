// Bug2 修复实机验收：并发 2 下 4 个 agent——排队中的节点侧栏不显示计时（拿到槽位才开始计时）
export const meta = { name: 'queue_timer', description: '排队计时修复验收' }
phase('排队演示')
const rs = await parallel([
  () => agent('慢慢分析这个目录的文件结构，写 100 字', { label: '慢1' }),
  () => agent('慢慢分析这个目录的依赖关系，写 100 字', { label: '慢2' }),
  () => agent('慢慢分析这个目录的模块划分，写 100 字', { label: '慢3' }),
  () => agent('慢慢分析这个目录的配置文件，写 100 字', { label: '慢4' }),
])
return rs.length
