// Node Inspector 大结果截断验收（T05）：结果序列化超过 20KB 触发截断提示
// 预期：Node Detail 正文被截断，末尾出现 "Result truncated, original size: xx KB"，界面可滚轮滑动、不卡死
// 说明：1MB 级极端场景的截断与 UTF-8 边界逻辑由单元测试覆盖（tests/result-view.test.ts），
//       真机以 20KB+ 验收打开即响应即可
// 用法：同 node-detail-ab-test.js。运行约 1-3 分钟（两个长输出 agent）

export const meta = { name: 'node_detail_large_result', description: 'Node Inspector 大结果截断验收' }

phase('BigText')
// 文本路径大结果：Node Detail 显示原文（截断后）
const bigText = await agent(
  '围绕"OpenCode 插件体系与动态工作流"写一篇详尽的中文说明，分八个章节逐节展开，'
  + '总长度不少于 6000 词，直接输出纯文本，不要使用 Markdown 代码块围栏',
  { label: 'long-output' }
)

phase('BigJson')
// 结构化路径大结果：Node Detail 显示 pretty-print JSON（截断后）
const bigStructured = await agent(
  '返回一个 JSON 对象：title 为"插件生态清单"，items 为 120 个条目的数组，'
  + '每个条目含 id（数字）、name（插件名）、description（不少于 60 词的中文描述）',
  {
    label: 'long-structured',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              name: { type: 'string' },
              description: { type: 'string' }
            },
            required: ['id', 'name', 'description']
          }
        }
      },
      required: ['title', 'items']
    }
  }
)

return { bigText, bigStructured }
