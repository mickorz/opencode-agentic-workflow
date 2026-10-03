# feature-development 首跑五连坑（titlecase 实战）

**日期**：2026-10-04 ｜ **阶段**：v0.3.x Adoption（examples/01 TUI 手动验收）
**载体**：`examples/01-coding-reliable` ｜ 三次 run：`htn39z0s` / `0pnf8bzb` / `cp2tz6hy`
**取证**：journal ×3 + 保留 worktree ×2 + 分支 diff + 主仓 package-lock 比对，均为文件级一手证据
（本文档由 TUI 侧排查记录与 agent 侧取证合并而成，唯一权威版本）

## 背景

需求：新增 `src/utils/titlecase.ts` + `tests/utils/titlecase.test.ts`。
产物本身一次到位（170 测试全绿、reviewer 认可实现正确），但链路在
enum / verify / checkpoint 反复失败，暴露 5+1 个问题：2 个需人工干预、
1 个至今未解（checkpoint 无法在无 TUI 语境收尾）。

## 前置坑 0：enum 拒绝被主 agent 擅自降级（run `htn39z0s`）

用户请求 `flow=feature-development`，因 npm 包名缓存（另见
`opencode插件npm包名解析走自身缓存.md`）enum 只有 3 个 flow，工具拒绝；
**主 agent 自作主张改用 reliable 跑完**——任务被静默替换还烧了 token。
教训：工具描述应加「enum 失败禁止降级替代」，枚举拒绝必须原样失败。

以下是 feature-development 本体的五连坑（run `0pnf8bzb` 首发，`cp2tz6hy` 全程）：

## 坑 1：stale package-lock.json 被 check 步骤"顺手"提交，污染 feature diff

**现象**：verify 首败，reviewer 拒绝理由之一：diff 混入 365 行与需求无关的
package-lock.json 改动。

**根因链**（三层叠加，远因已实测坐实）：

1. **主仓 lockfile 本来就和 package.json 不同步**：package.json 已是
   `@mickorz/opencode-agentic-workflow@0.3.0`，lockfile 还停在无 scope 的
   `opencode-agentic-workflow@0.2.0`（2026-10-04 实测比对）；
2. check 步骤默认命令 `DEFAULT_FEATURE_CHECK_COMMAND` 以 `npm install` 开头
   （worktree 无 node_modules），install 会把 lockfile 重新生成为与
   package.json 一致；
3. check 通过后的固化脚本是 `git add -A && git commit`——**无差别全量提交**，
   把重生成的 lockfile 一起提交进了 feature commit。
   （注：`0pnf8bzb` 复现、`cp2tz6hy` 首发——是否出现取决于 install 是否触发
   重写，不确定性本身是危害。）

**修复**：在 worktree 里 `git checkout <baseSha> -- package-lock.json` 后
`git commit --amend`，feature commit 只剩 2 个文件 +49 行。

**预防**：根治主仓 lockfile 同步；固化前恢复 lockfile 噪声（或显式路径清单——
implement 步骤的 agent 输出本就带变更文件清单）；lockfile 敏感场景用 `npm ci`。

## 坑 2：diff 超长被截断，核心代码对 reviewer 不可见

**现象**：verify 首败的另一理由：核心实现与测试代码因 diff 截断不可见。

**根因**：verify 的 `MAX_DIFF_CHARS = 24_000`。混入 365 行 lockfile 后总量超限，
截断的恰恰是排在 diff 末尾的两个真正需求文件（lockfile 按路径序在前）。

**关联**：坑 1 的放大效应——污染不仅"混入无关改动"，还把"该看的挤出了窗口"。
截断机制本身没错，错在 artifact 组装没有"重要文件优先"策略。

**预防**：diff 排序把源码/测试放前、lockfile/生成物放后，或后者在 artifact
中折叠为一行统计。

## 坑 3：reviewer 输出非法 JSON，直接判 fail、无重试

**现象**：verify 首败的第三个理由：`reviewer output was not valid JSON with
verdict/summary`——某个 reviewer 的输出没解析成结构化 verdict。

**根因**：reviewer agent 输出无强 schema 约束，一次格式跑偏就整体 fail，
`assertVerify` 内没有针对单 reviewer 的重试。

**预防**：reviewer 走 JSON mode / 结构化输出；或单 reviewer 解析失败局部重试
1-2 次再判负。

## 坑 4：人工修复 commit 后 resume，读到的是 journal 里的陈旧状态

**现象**：amend 掉 lockfile 后 resume，verify **仍然**抱怨 package-lock.json：
"变更统计中混入需求范围外且 diff 未展示的 package-lock.json 大改动"。

**根因**：verify 的 artifact 由两部分拼成——`git diff baseSha..HEAD`（现算，
已干净）与 `prev.diffStat`（来自 journal 里 check 步骤的落盘输出，还是 amend
前的旧统计，含 lockfile +365）。两者矛盾，reviewer 合理拒绝。同理 `commitSha`
也是陈旧的（amend 换了 HEAD，journal 还记着旧值，最终报告会指向不存在的
commit）。

**修复（journal 手术）**：备份后改 `.agw/journal/run_*.json` 的
`steps[2].output.{commitSha,diffStat}` 与 `steps[3].input.{commitSha,diffStat}`
为真实值（`a6f9b11` / 2 文件 +49），再次 resume 后 verify 一次通过。

**教训**：

- **resume 的输入契约是 journal 快照，不会感知 worktree 的外部修正**。任何绕过
  workflow 直接改 worktree/git 的救火动作，都要同步校正 journal 对应步骤的
  output/input，否则下个步骤吃到的还是旧世界；
- 更本质：verify 的 `diffStat` 应与 diff **同源同时计算**（步骤内现算
  `git diff --stat`），不引用上一步缓存值——两份数据本就该强一致。

## 坑 5：checkpoint 在无 TUI 语境下必然超时拒绝，且外部批准无法注入（未解）

**现象**：verify 通过后卡在 checkpoint `accept-implementation`：
`no interactive reply within 300000ms (no TUI attached?)`，重试依旧。
run 终态 `failed / currentStep=4`（该错误在 `htn39z0s` 上亦复现过一次）。

**根因**：`checkpoint.mode: "interactive"` 走 `InteractiveCheckpointGate`：
emit RPC 事件等 TUI 弹窗应答，300s 无应答按 `onTimeout: "reject"`（安全失败）。
经 workflow 工具编程式调用时没有 TUI 订阅该事件；**即便用户已在对话中明确
"接受"，这个决定没有任何通道注入 gate**——resume 只会重新挂起 300s 再超时。

**现状**：人工审批语义上已完成，但链路无法收口：产物完好（分支
`agw/run_1791048661145_cp2tz6hy`、commit `a6f9b11`、170 测试全绿），但
checkpoint 步骤失败 = run 失败，approved 状态与按 cleanup 策略的清理未执行。

**候选解法**：

1. headless 用 `checkpoint.mode: "auto-approve"` resume——但等于放弃人工闸门；
2. 给 InteractiveCheckpointGate 增加**外部应答通道**（journal 落 pending
   decision / CLI 或工具回复 requestId），让"对话里批准"能传给挂起中的 gate；
3. 超时放宽 + 事件流显式提示"等待 TUI 应答"，避免编程式调用者不知情干等。

## 时间线速览

| # | 动作 | 结果 |
| --- | --- | --- |
| 0 | TUI 请求 feature-development（包名缓存期） | enum 拒绝 → 主 agent 降级跑 reliable → checkpoint 超时死（前置坑 0） |
| 1 | 路径修复后首发 `0pnf8bzb`（及 `cp2tz6hy` 首发） | check 通过；verify 拒绝（坑 1/2/3） |
| 2 | worktree 内 amend 剔除 lockfile，手工跑测试 170 绿 | commit 干净（`a6f9b11`） |
| 3 | resume #1 | verify 仍拒绝：journal 陈旧 diffStat 与新 diff 矛盾（坑 4） |
| 4 | journal 手术（commitSha/diffStat，备份在前）+ resume #2 | verify 通过；checkpoint 300s 超时被拒（坑 5） |
| 5 | 对话中征得用户批准 + resume #3 | checkpoint 再次超时被拒，run 停在 `failed/currentStep=4` |

## 修复落位（feature-development v1.1.0，2026-10-04）

- **坑 1**：check 固化前恢复锁文件噪声（package-lock / shrinkwrap / pnpm / yarn / bun），
  `keepLockfileChanges` arg 显式保留依赖变更；主仓 lockfile 陈旧远因已同步（0.3.0）
- **坑 4**：verify 步骤的 `diffStat` / `commitSha` 与 diff **同源现算**，不再引用
  journal 中 check 步骤的缓存值——外部 amend 等修正后报告仍强一致
- 单测：默认恢复 / 显式保留 / amend 同源现算 三场景（173/173 绿）
- 未修：坑 2/3（verify 原语层）→ 坑 3 已入 Watching
  （reviewer JSON 容错）；坑 2（artifact 排序）随首个受害 workflow 泛化时
  按作者规范处理（docs/workflow-authoring.md）；坑 4 的 systemic 解法已入
  Watching（journal 快照一致性）；坑 5（checkpoint 决定注入通道）在 Watching；
  前置坑 0（工具描述约束，待 Watching 信号）

## 关联与回填

- Watching 回填：坑 5 → 「TUI workflow 运行进度可视化」升至 2 次；失败 run
  3 worktree + 3 挂牌分支无回收 → 「停止/取消 workflow」条目补实证；
  checkpoint 外部应答通道为新增 Watching 信号
- `experience/journal收口与workspace清理顺序.md`：同为 journal 状态一致性
  纪律——journal 是 resume 的唯一事实源，外部改动必须回写
- 代码位置：`src/workflows/feature-development.ts`（check 固化 `git add -A`、
  verify artifact 组装、`MAX_DIFF_CHARS`）、`src/plugin/interactive-checkpoint-gate.ts`
  （300s/onTimeout=reject 默认值）
- 主仓 package.json / package-lock.json 不同步是坑 1 远因（存量问题）

## 共同心法

1. **插件环境假设三兄弟**（缓存/版本/解析基准）每次配置变更都要重验证（坑 0）
2. **检查者不能污染被检现场**，且污染会级联（lockfile 噪声 → 截断挤出真文件 →
   reviewer 拒绝）（坑 1/2）
3. **resume 的输入契约是 journal 快照**：外部救火必须回写 journal，跨步骤缓存的
   衍生数据应同源现算（坑 4）
4. **等待必须有边界和可见性**：300s 静默是安全阀，不是交互设计；人工决定需要
   一条注入通道（坑 5）
5. **交付物与审批解耦**：实现完成应可取回（分支上的 `a6f9b11` 即证据），
   人工门失败不应埋葬已完成的工作
