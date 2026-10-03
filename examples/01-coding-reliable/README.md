# 01 · coding-reliable ⭐ Flagship

> **Turn a feature request into implemented, tested, reviewed and
> human-approved code.**

一句话需求，走完「分析 → 隔离 worktree 实现 → 确定性测试 → 失败自动修复 →
reviewer 审查真实 diff → 人工审批 → 分支交付」全链路。
这是「为什么用 Agentic Workflow 而不是单个 Coding Agent」的最直接回答。

## 运行

```bash
# 1. 仓库根构建插件（dist/ 是插件的加载入口）
npm install && npm run build        # 在仓库根执行一次

# 2. 本目录无需任何安装，直接启动
cd examples/01-coding-reliable
```

然后**重启 OpenCode 并在本目录启动**（插件只在启动时加载）。
在会话里说：

```text
调用 workflow 工具：flow=feature-development,
topic=新增 src/utils/titlecase.ts：导出 titlecase(s: string): string，
将英文句子中每个单词首字母转为大写、其余字母小写；
并在 tests/utils/titlecase.test.ts 新增单测，覆盖普通句子/空串/多连续空格/单字母。
```

## 你会看到什么

```text
analyze    分析仓库与需求，产出实现计划
implement  agent 在隔离 worktree 中编码（不污染你的工作区）
check      在 worktree 根真实执行 npm install + typecheck + test
           （失败会自动进入修复回路：fix agent -> 复检，最多 2 轮）
           通过后固化为 agw/<runId> 分支上的 commit
verify     2 名 reviewer 并行审查「真实 git diff」（非 agent 自述）
checkpoint TUI 弹出确认框：接受 / 拒绝该实现
```

产物与证据：

- **分支** `agw/<runId>`：实现已固化为 commit，worktree 清理后仍保留；
  回流 = 对目标仓库 `git merge` / `git cherry-pick`
- **journal**：`.agw/journal/`（runId、步骤状态、累积 state，可 resume）
- **trace / metrics**：`.agw/trace/`（events.jsonl + metrics.json）

## 配置要点（opencode.json）

- **插件引用用相对路径 `"../../dist/plugin"`**（相对项目目录解析，需先在仓库根
  `npm run build`）。注意：npm 包名形式（`"@mickorz/opencode-agentic-workflow"`）
  会被 OpenCode 安装到它自己的缓存并按 registry 版本解析——**项目 node_modules
  对其无效**；待 npm 发布含本 workflow 的版本（≥0.3.1）后可切换为包名引用。
- `checkpoint.mode: "interactive"`——TUI 审批弹框（人工决策的招牌体验）。
  若用 `opencode run` 无 TUI 跑，请改为 `"auto-approve"`
  （interactive 在无 TUI 应答时 5 分钟超时后按 reject 安全失败）。
- `isolation.mode: "git-worktree"`——本 workflow 必需；worktree 落在
  仓库同级 `<repo>-worktrees/<runId>`，主工作区零污染。
- `model` / `prices` 按需替换为你自己的 provider 与价目。

## 失败了怎么办

任一步骤失败（测试修不过、reviewer 驳回、审批拒绝），run 记录在 journal，
工具结果会带回 `runId`——用 `resumeRunId="<runId>"` 从失败步骤续跑，
已完成的步骤不会重复执行。
