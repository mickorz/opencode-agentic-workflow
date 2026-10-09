// P1 worktree 隔离演示：写型 agent 在独立 git worktree 中改动并汇报（结束后 worktree 自动拆除，主目录不受影响）
// 用法：让 Main Agent 用 workflow 工具执行本脚本（scriptPath 传本文件路径）
// 注意：本仓库必须是 git 仓库（sample-project 在 opencode-dynamic-workflows 仓库内，天然满足）

export const meta = { name: 'worktree_demo', description: 'P1 worktree 隔离：独立 git worktree 中的写型 agent' }

phase('Isolated')
const report = await agent(
  '你正在一个独立的 git worktree 中工作。请依次执行：' +
  '1) 运行 git branch --show-current 记录当前分支名；' +
  '2) 创建文件 demo-note.txt，内容为一行：worktree isolation ok；' +
  '3) 运行 git status --short 确认新文件出现；' +
  '4) 以文本返回：分支名 + git status 输出。不要执行 commit。',
  { isolation: 'worktree', agentType: 'general', label: '隔离写手' }
)
return { report }
