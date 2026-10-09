// 结构化输出验证脚本（方案 A 验证用：先调查后提交指令是否生效）
// 用法：在 examples/sample-project 目录启动 OpenCode 后，让 Main Agent 用 workflow 工具执行本脚本（scriptPath 传本文件路径）
//
// 本版任务刻意选了「硬事实」字段（标题原文、行数、子命令数），凭印象编不出正确答案：
//  - 若子会话里只有一次 StructuredOutput 调用（无 read 工具） -> 模型仍一步交卷，方案 A 失效，需切方案 C
//  - 若先出现 read 工具调用、最后才 StructuredOutput -> 方案 A 生效
//  - 核对答案：终端跑  wc -l docs/cli.mdx docs/agents.mdx  与  head -n 1 两文件，和结果比对
//  - token：节点 token 数应明显大于修复前（含多轮探索消耗）

export const meta = { name: 'schema_test', description: '结构化输出验证' }

const report = await agent(
  '阅读 docs/cli.mdx 与 docs/agents.mdx 两个文件，完成以下调查：每个文件的一级标题（# 开头）原文、每个文件的总行数、以及 cli.mdx 中出现的子命令数量',
  {
    label: '硬事实抽取',
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径' },
              h1Title: { type: 'string', description: '一级标题原文，逐字抄录' },
              lineCount: { type: 'number', description: '文件总行数' },
            },
            required: ['path', 'h1Title', 'lineCount'],
          },
        },
        cliSubcommandCount: { type: 'number', description: 'cli.mdx 中出现的子命令数量' },
      },
      required: ['files', 'cliSubcommandCount'],
    },
  },
)
return report
