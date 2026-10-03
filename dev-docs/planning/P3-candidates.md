# P3 Candidates（正式治理规则：证据驱动，不预设功能）

> **进入 P3 的条件不是"时间到了"，而是至少一批候选跨过了本文定义的真实需求阈值。**
> 没有 Source 和 Frequency 的条目只能留在 Backlog，不得排期。

## 流程（v0.4.x 启动的 gate）

```text
v0.3.0 Release & Adoption
        ↓
Feedback Collection（issues / discussions / npm / 用户对话）
        ↓
P3-candidates.md（本文件）
        ↓
Evidence + Frequency 达标
        ↓
Accepted Candidate
        ↓
P3 Scope（v0.4.x 立项）
```

## 文件结构

```text
├─ Accepted   已跨过阈值，进入排期
├─ Watching   出现过 1–2 次，未达触发阈值（趋势观察，防止丢信号）
├─ Backlog    内部已知缺口，无真实用户来源，不得排期
└─ Declined   明确拒绝并记录原因（防翻烧饼）
```

## 候选条目模板

```text
## Request: <名称>

Source:
  GitHub issue #xx / discussion / 用户对话（日期）

Frequency:
  N 个独立用户/场景

Evidence:
  用户原话 / issue 摘要 / 复现链接

Problem:
  <用户面对的真实问题，不是我们想象的功能缺口>

Existing capability:
  当前 runtime 哪些能力已能部分解决

Current workaround:
  <用户现在怎么绕过>

Impact:
  <不解决的后果>

Complexity:
  <S/M/L 估计>

Success criteria:
  <做完后怎么判断这个需求真的解决了（可验证）>

Decision:
  Accepted(v0.4.x) / Watching / Pending / Declined(原因)
```

### 填写示例（⚠️ 数据虚构，仅演示格式，勿当真实反馈引用）

```text
## Request: Parallel resume

Source:
  GitHub issue #42
  用户对话 2026-10-12

Frequency:
  4 个独立用户

Evidence:
  用户的 parallel workflow 运行 40 分钟后单分支失败，
  当前必须整体重跑。

Problem:
  parallel workflow 无法只恢复失败分支。

Existing capability:
  sequence resume 已支持 completed prefix 跳过，
  但 parallel 无 branch-level journal identity。

Current workaround:
  拆成多个 sequence workflow，或整体重跑。

Impact:
  长耗时 workflow 成本高，失败恢复时间长。

Complexity:
  L

Success criteria:
  parallel 中已完成 branch 不重新执行；
  失败 branch 可跨进程恢复；
  journal 能准确记录 branch 状态。

Decision:
  Pending
```

---

## Accepted（已跨阈值，进入排期）

（暂无——这是刻意的：v0.3.0 刚发布，反馈通道刚建立）

## Watching（出现过信号，未达阈值）

> 来源均为真实使用反馈；出现 1–2 次的放这里，防丢趋势（≥3 次独立用户即评估升级 Accepted）。

### Request: Workflow 列表查询命令

Source:
  用户对话 2026-10-04（Adoption Sprint，TUI 手动验收时）

Frequency:
  1 次（作者 dogfood；读者侧是否同样卡住待观察）

Evidence:
  用户在 TUI 问「查看当前 workflow 有哪些」——当前只能让主 agent 读
  workflow 工具描述间接获得（registry.summarize 内嵌于 description），
  无第一等的用户命令/工具。

Problem:
  用户无法直接枚举可用 workflow 及其入参；新会话/新用户 discover 成本高。

Existing capability:
  工具描述内嵌注册表摘要（主 agent 可转述）；journal/metrics 可查历史。

Current workaround:
  问主 agent「有哪些可用的 workflow」。

Impact:
  Adoption 摩擦（A3 看懂核心价值的前置）；不影响已知道 flow id 的用户。

Complexity:
  S（新增只读 workflow_list 工具或 /flows 命令，registry 已有 summarize）

Success criteria:
  用户一条指令/一次工具调用即可枚举 flow id、描述与入参 schema；
  与 registry 注册自动同步，零维护。

Decision:
  Watching

### Request: 停止/取消运行中的 workflow

Source:
  用户对话 2026-10-04（Adoption Sprint，TUI 手动验收时）

Frequency:
  1 次

Evidence:
  用户问「还有停止 workflow 功能吗」——当前无取消 API，只能杀进程。
  关联实证：titlecase 首跑三连败各留一个 worktree + 挂牌分支、无回收路径
  （experience/titlecase-feature-run五连坑.md 坑 4）——失败生命周期管理缺口。

Problem:
  长链路（如 feature-development 的 check/npm install 阶段）无法主动中止；
  误启动的 run 只能等它跑完或杀掉整个 opencode。

Existing capability:
  杀进程后 run 停留在 journal 非 completed 状态，resumeRunId 可续跑
  （completed 前缀跳过）——「中断 + 恢复」有，「主动取消」无。

Current workaround:
  退出 opencode / 杀 service；run 变为可 resume 状态。

Impact:
  成本失控风险（跑错的 workflow 继续烧 token）；HITL 体验缺口。

Complexity:
  M~L（需设计：运行中 agent 任务中止传播、journal 取消态收口与 resume
  语义、worktree cleanup 决策、workflowDepth 守卫释放）

Success criteria:
  用户可一条指令取消指定 runId；journal 有显式 cancelled 状态；
  取消后 workspace 按 cleanup 策略处理且可安全 resume 或归档；
  metrics/trace 记录取消事件。

Decision:
  Watching

### Request: TUI workflow 运行进度可视化

Source:
  用户对话 2026-10-04（Adoption Sprint，TUI 手动验收时）

Frequency:
  2 次（2026-10-04 TUI 询问一次；titlecase 旗舰首跑中亲历黑盒 5+ 分钟——
  见 experience/titlecase-feature-run五连坑.md 坑 5，Run3 机械链路全通但全程不可见）

Evidence:
  用户在 TUI 发起 feature-development 后问「阶段/agent 显示是不是没开发」；
  随后的三次真实 run 中，workflow 工具调用均为不透明的块，phase/步骤/子
  agent 活动/verify 结论全程不可见，结束才一次性返回报告。

Problem:
  长链路（5+ 分钟）运行期间用户零反馈，无法判断卡死还是在跑。

Existing capability:
  事件流完整（step/agent/phase/verify 事件经 emitEvent 产生，落 trace jsonl
  与 metrics）；server→TUI 事件通道已由 checkpoint 验证（emit + 订阅 + RPC）。

Current workaround:
  另开终端 tail trace events.jsonl；或等工具调用结束读报告。

Impact:
  Demo/Adoption 杀伤力大：黑盒感直接削弱「可观测」卖点；用户可能中途误杀。

Complexity:
  M（转发既有事件到 TUI 总线 + TUI 侧渲染；渲染可用的 TUI API 面需调研——
  目前只验证过 dialog.confirm）

Success criteria:
  workflow 运行中 TUI 实时显示：当前步骤（stepNames 完成态）、活跃子 agent、
  check/verify 结论；不阻塞工具调用；事件与 trace jsonl 同源零维护。

Decision:
  Watching

---

## Backlog（尚无真实用户来源，不得排期）

以下均为**内部设计时已知的能力缺口**，仅作记录——在拿到真实用户反馈前，
它们不构成 P3 排期依据：

### Parallel resume

- 缺口：resume 目前仅支持 `sequence()`；parallel 步骤崩溃后无法部分恢复
- 现状：设计决策（P2.2，复杂度/收益比），文档已声明
- 触发条件：出现 3+ 个真实用户有长时 parallel workflow 崩溃恢复需求

### Worktree 产出回流（branch merge / auto PR / auto commit）

- 缺口：隔离 worktree 的产出目前留在 `agw/<runId>` 分支，需人工回流
- 触发条件：用户实际用 artifact 型 workflow 并反馈回流摩擦

### DB-backed ExecutionStore

- 缺口：journal 目前文件落盘；高频/多项目场景无索引查询
- 触发条件：出现单目录 run 数量级 >10³ 或跨项目聚合查询需求

### Workflow Gallery / Hub

- 缺口：社区共享 workflow 无入口
- 前置：先做仓库内 `examples/`（Adoption Sprint 第三优先级），
  有外部贡献者提交 workflow 后再评估独立 Hub

### Telemetry（默认 OFF，opt-in）

- 原则：匿名、公开 schema、不采 prompt/代码/workflow 内容；
  第一阶段完全不做，仅用 GitHub Issues/Discussions/npm downloads/
  stars/forks 验证需求
- 候选字段（仅当启动时）：plugin version、OpenCode version、
  workflow started/completed/failed、使用的 primitive、duration、error category
- 触发条件：用户基数足以让匿名统计有意义，且社区无反感信号

---

## 已 Declined（记录原因，防止翻烧饼）

（暂无）
