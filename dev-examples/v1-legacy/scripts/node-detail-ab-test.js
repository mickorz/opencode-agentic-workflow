// Node Inspector 黄金回归脚本（T01~T04）：schema 与 text 双路径 A/B 对照
// 背景：schema 子会话正文空白是已定案的合法形态（不是 bug），本脚本验证结果在
//       Node Detail 视图中有正确的展示位，且四处数据一致
// 覆盖：T01 默认模型+schema / T02 默认模型+text；换模型重跑即 T03/T04
// 用法：在 examples/sample-project 目录启动 OpenCode 后，对 Main Agent 说：
//       "用 workflow 工具执行 scripts/node-detail-ab-test.js，scriptPath 传该路径，不要粘贴脚本内容"
//       换模型跑 T03/T04 时追加一句：
//       "args 传 {\"model\": \"provider/modelId\"}"

export const meta = { name: 'node_detail_ab_test', description: 'Node Inspector 黄金回归：schema 与 text 双路径对照' }

// args.model 可选（"provider/modelId" 形式）；缺省用会话默认模型
const modelOptions = {}
if (args && typeof args.model === 'string') modelOptions.model = args.model

phase('Result')
// A 路径：schema 结构化输出。随后进 Node Detail 验收本结果；
// 用 Open Session 进入子会话时 assistant 正文为空属预期（T01 判定第 1 条）
const structured = await agent(
  '读取项目根目录的 opencode.json，判断插件配置是否可用，返回 JSON：'
  + 'ok 为布尔值，summary 为一句话结论，plugins 为配置里的插件路径字符串数组',
  {
    label: 'schema-reader',
    ...modelOptions,
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', description: '插件配置是否可用' },
        summary: { type: 'string', description: '一句话结论' },
        plugins: { type: 'array', items: { type: 'string' }, description: 'plugin 配置数组' }
      },
      required: ['ok', 'summary']
    }
  }
)

// B 路径：无 schema 普通文本（对照组）
const text = await agent('用一句话说明 docs/cli.mdx 的主题', { label: 'text-reader', ...modelOptions })

return { structured, text }
