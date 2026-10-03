# feature-development 首次实战五连坑：stale lockfile 污染 diff、resume 陈旧 journal、checkpoint 无 TUI 应答

日期：2026-10-04 ｜ runId：`run_1791048661145_cp2tz6hy` ｜ 链路：feature-development@1.0.0（analyze → implement → check → verify → checkpoint）｜ 环境：examples/01-coding-reliable，隔离 worktree

## 背景

需求：新增 `src/utils/titlecase.ts` + `tests/utils/titlecase.test.ts`。
产物本身一次到位（170 测试全绿、2/2 reviewer 认可实现正确），但链路在
verify / checkpoint 反复失败，共暴露 5 个问题，其中 2 个需要人工干预、
1 个至今未解（checkpoint 无法在无 TUI 语境收尾）。

## 坑 1：stale package-lock.json 被 check 步骤"顺手"提交，污染 feature diff

**现象**：verify 首败，reviewer 拒绝理由之一：diff 混入 365 行与需求无关的
package-lock.json 改动。

**根因链**（三层叠加）：

1. **主仓 lockfile 本来就和 package.json 不同步**：package.json 已是
   `@mickorz/opencode-agentic-workflow@0.3.0`，lockfile 还停在
   `opencode-agentic-workflow@0.2.0`；
2. check 步骤默认命令 `DEFAULT_FEATURE_CHECK_COMMAND` 以
   `npm install` 开头（worktree 无 node_modules），install 会把 lockfile
   重新生成为与 package.json 一致；
3. check 通过后的固化脚本是 `git add -A && git commit`——**无差别全量提交**，
   把重生成的 lockfile 一起提交进了 feature commit。

**修复**：在 worktree 里 `git checkout <baseSha> -- package-lock.json` 后
`git commit --amend`，feature commit 只剩 2 个文件 +49 行。

**预防**：

- 根治：主仓把 package-lock.json 与 package.json 同步掉（这是既有的不一致）；
- check 默认命令对 lockfile 敏感场景可用 `npm ci`（但 lockfile 不同步时
  `npm ci` 会直接失败，需先治本）；
- commit 固化建议改为显式路径清单（implement 步骤的 agent 输出本来就带
  变更文件清单），或至少排除 `package-lock.json` / lockfile 类文件。

## 坑 2：diff 超长被截断，核心代码对 reviewer 不可见

**现象**：verify 首败的另一理由：核心实现与测试代码因 diff 截断不可见。

**根因**：verify 提供 diff 的上限 `MAX_DIFF_CHARS = 24_000`。混入 365 行
lockfile 后总量超限，截断的恰恰是排在 diff 末尾的两个真正需求文件。

**关联**：这是坑 1 的放大效应——污染不仅"混入无关改动"，还把"该看的挤出了
窗口"。单独看截断机制没错，但 artifact 组装没有"重要文件优先"的排序策略。

**预防**：diff 按路径排序时把测试/源码放前、lockfile/生成物放后，或对
lockfile 类文件在 artifact 中折叠为一行统计。

## 坑 3：reviewer 输出非法 JSON，直接判 fail、无重试

**现象**：verify 首败的第三个理由：`reviewer output was not valid JSON with
verdict/summary`——某个 reviewer 的输出根本没解析成结构化 verdict。

**根因**：reviewer agent 的输出没有强 schema 约束（或解析器容错不足），
一次格式跑偏就整体 fail，`assertVerify` 内没有针对单 reviewer 的重试。

**预防**：reviewer 输出走 JSON mode / 结构化工具调用；或单 reviewer 解析
失败时局部重试 1-2 次再判负。

## 坑 4：人工修复 commit 后 resume，读到的是 journal 里的陈旧状态

**现象**：amend 掉 lockfile 后恢复运行，verify **仍然**抱怨 package-lock.json：
"变更统计中混入需求范围外且 diff 未展示的 package-lock.json 大改动"。

**根因**：verify 的 artifact 由两部分拼成：

- `git diff baseSha..HEAD`——**现算**，已经干净；
- `prev.diffStat`——来自 **journal 里 check 步骤的落盘输出**，还是 amend
  前的旧统计（含 lockfile +365）。两者互相矛盾，reviewer 合理拒绝。

同理 `commitSha` 也是陈旧的（amend 换了 HEAD，journal 还记着旧
`29ec221`，最终报告会指向不存在的 commit）。

**修复（journal 手术）**：备份后用脚本改
`.agw/journal/run_*.json` 的 `steps[2].output.{commitSha,diffStat}` 与
`steps[3].input.{commitSha,diffStat}` 为真实值（`a6f9b11` / 2 文件 +49），
再次 resume 后 verify 一次通过。

**教训**：

- **resume 的输入契约是 journal 快照，不会感知 worktree 的外部修正**。
  任何绕过 workflow 直接改 worktree/git 的救火动作，都要同步校正 journal
  里对应步骤的 output/input，否则下个步骤吃到的还是旧世界；
- 更本质的改进：verify 的 `diffStat` 应与 diff **同源同时计算**
  （在 verify 步骤内现算 `git diff --stat`），而不是引用上一步的缓存值——
  两份数据本就该强一致。

## 坑 5：checkpoint 在无 TUI 语境下必然超时拒绝，且外部批准无法注入（未解）

**现象**：verify 通过后卡在 checkpoint
`accept-implementation`：`no interactive reply within 300000ms (no TUI
attached?)`，重试一次依旧。run 终态 `failed / currentStep=4`。

**根因**：插件默认 `checkpoint.mode = "interactive"`，走
`InteractiveCheckpointGate`：emit RPC 事件等 TUI 弹窗应答，300s 无应答按
`onTimeout: "reject"`（安全失败）裁决。经 workflow 工具编程式调用时没有
TUI 订阅该事件；即便用户已在对话中明确"接受"，**这个决定没有任何通道注入
gate**——resume 只会重新挂起等待 300s 再超时一次。

**现状**：人工审批语义上已经完成（用户批准），但链路无法收口：
- 产物完好：分支 `agw/run_1791048661145_cp2tz6hy`（`a6f9b11`，仅
  `src/utils/titlecase.ts` + `tests/utils/titlecase.test.ts`，170 测试全绿）；
- checkpoint 步骤失败 = run 失败，报告/收尾（approved 状态、按 cleanup
  策略清理 worktree）未执行。

**候选解法**：

1. 配置 `checkpoint.mode: "auto-approve"`（`PolicyCheckpointGate`）后
   resume——适合 headless，但等于放弃这一道人工闸门；
2. 给 InteractiveCheckpointGate 增加**外部应答通道**（如 journal 落一条
   pending decision、或提供 CLI/工具回复 requestId），让"用户在对话里批准"
   可以传递给挂起中的 gate；
3. 超时从 300s 放宽 + 在事件流里显式提示"等待 TUI 应答"，避免编程式调用
   者不知情干等。

## 时间线速览

| # | 动作 | 结果 |
| --- | --- | --- |
| 1 | 首次运行 | check 通过；verify 拒绝（坑 1/2/3） |
| 2 | worktree 内 amend 剔除 lockfile，手工跑测试 170 绿 | commit 干净（`a6f9b11`） |
| 3 | resume #1 | verify 仍拒绝：journal 陈旧 diffStat 与新 diff 矛盾（坑 4） |
| 4 | journal 手术（commitSha/diffStat，备份在前） + resume #2 | verify 通过；checkpoint 300s 超时被拒（坑 5） |
| 5 | 对话中征得用户批准 + resume #3 | checkpoint 再次超时被拒，run 停在 `failed/currentStep=4` |

## 关联

- `experience/journal收口与workspace清理顺序.md`：同为 journal 状态一致性
  纪律——journal 是 resume 的唯一事实源，外部改动必须回写；
- `src/workflows/feature-development.ts`（check 固化 `git add -A`、verify
  artifact 组装、`MAX_DIFF_CHARS`）与 `src/plugin/interactive-checkpoint-gate.ts`
  （300s/onTimeout=reject 默认值）是三个坑的代码位置；
- 主仓 package.json / package-lock.json 不同步是坑 1 的远因，属存量问题。
