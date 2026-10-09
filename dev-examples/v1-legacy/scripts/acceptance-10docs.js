// 标准验收脚本（A-01/A-02/A-03）：10 个文档并行分析
// 语料：examples/sample-project/docs 下 10 个 OpenCode 官方文档 mdx
// 用法：在 examples/sample-project 目录启动 OpenCode 后，让 Main Agent 用 workflow 工具执行本脚本（scriptPath 传本文件路径）

export const meta = { name: 'acceptance_10docs', description: '标准验收：10 个文档并行分析' }

phase('Scan')
const files = await agent('列出当前目录 docs 下的 .mdx 文件，按文件名排序取全部 10 个，输出文件名，每行一个，不要任何其他内容')

phase('Analyze')
const findings = await parallel(
  files.split('\n').map(s => s.trim()).filter(Boolean).map(file => () =>
    agent('阅读 docs/' + file + '，用 3 句话总结：主题、关键 API、适用场景', {
      label: file
    })
  )
)

phase('Synthesize')
return await agent('综合以下 10 份文档摘要，输出一页总览，包含：共同主题、出现的 API 清单、使用注意事项\n\n' + findings.join('\n\n'))
