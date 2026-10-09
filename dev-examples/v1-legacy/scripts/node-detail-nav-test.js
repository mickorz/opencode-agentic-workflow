// 节点详情方向键导航验收脚本：6 个自标识节点（3 文本 + 3 schema，两个 phase）
// 配套验收：详情视图 left/right 切换相邻 agent、up 返回（plugin.tsx 键位层）
//
// 用法：在 examples/sample-project 目录启动 OpenCode 后，对 Main Agent 说：
//       "用 workflow 工具执行 scripts/node-detail-nav-test.js，scriptPath 传该路径"
//       （前台执行，等完成后再按下方清单验收）
//
// 验收清单：
//   1. 输入 /workflow 打开列表，j/k 选中 节点T1，按 Enter 进详情
//   2. 核对：头部 label 是 T1 港口，正文 result 是 T1 三行标记（含 T1 字样）
//   3. 连按 right 五次：应依次看到 T2 山谷、T3 夜市、S1、S2、S3，
//      每个节点的 label 与 result 内容必须对得上号（S 系列是 schema 结构化展示）
//   4. 再按 right 一次：回绕到 T1（循环导航）
//   5. 按 left 一次：回到 S3
//   6. 按 up：返回列表视图（Esc/q 效果相同）
//   7. 回归重点：若切到某节点后 result 仍显示上一个节点的内容（如切到 S2 还显示
//      S1 的结果），即命中 journal diff 守卫回归（已修复，不应出现）
//   8. 可选：Enter/o 进原生子会话，Esc 返回（原生界面键位不变属预期）

export const meta = { name: 'node_detail_nav_test', description: '节点详情方向键导航验收：6 个自标识节点' }

phase('Text')
const texts = await parallel([
  () => agent(
    '复述任务：只输出下面三行，一字不改，不要加任何解释\n[T1 第一行] 清晨的港口\n[T1 第二行] 雾气未散\n[T1 第三行] 汽笛声由远及近',
    { label: 'T1 港口' },
  ),
  () => agent(
    '复述任务：只输出下面三行，一字不改，不要加任何解释\n[T2 第一行] 正午的山谷\n[T2 第二行] 风穿过松林\n[T2 第三行] 影子缩到脚边',
    { label: 'T2 山谷' },
  ),
  () => agent(
    '复述任务：只输出下面三行，一字不改，不要加任何解释\n[T3 第一行] 午夜的夜市\n[T3 第二行] 灯笼连成一线\n[T3 第三行] 人声渐渐稀落',
    { label: 'T3 夜市' },
  ),
])

phase('Schema')
const markerSchema = () => ({
  type: 'object',
  properties: {
    index: { type: 'number', description: '固定返回传入的编号' },
    marker: { type: 'string', description: '固定返回传入的标记词' },
  },
  required: ['index', 'marker'],
})
const schemas = await parallel([
  () => agent('把 index 设为 1，marker 设为 schema节点一', { label: 'S1', schema: markerSchema() }),
  () => agent('把 index 设为 2，marker 设为 schema节点二', { label: 'S2', schema: markerSchema() }),
  () => agent('把 index 设为 3，marker 设为 schema节点三', { label: 'S3', schema: markerSchema() }),
])

log(`文本节点 ${texts.filter(Boolean).length}/3，schema 节点 ${schemas.filter(Boolean).length}/3`)
return {
  textOk: texts.filter(Boolean).length,
  schemaOk: schemas.filter(Boolean).length,
  note: '进 /workflow 按 Enter 后用 left/right 逐个核对内容与 label 对号',
}
