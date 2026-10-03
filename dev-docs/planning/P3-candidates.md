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

## Blocker Override（v0.3.1 起）

> **Frequency 治理功能需求；Correctness / Adoption Blocker 用 Severity × Reproducibility 治理。**
> 两类东西不共用准入规则——这不是破例通道，是平行的第二条规则。

```text
Normal candidate:
  真实用户反馈达到 Frequency 阈值
          ↓
  可进入排期

Correctness / Adoption Blocker（满足条件越多越优先）:
  1. 可稳定复现（如 2/2 确定性）
  2. 导致正确产物被判失败（false negative）
  3. 阻断 Quick Start / Flagship Demo
  4. 有数据损坏 / 恢复错误风险
  5. 用户无合理 workaround
          ↓
  可提前处理（仍需在条目记录 Blocker 判定依据）
```

约束：Blocker 修复严格限制在最小范围（S~M 局部改动），禁止借机重构；
修复合入后在原条目记录修复落位与版本。

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

### Request: checkpoint 决定注入通道（headless/对话场景）

Source:
  用户对话 2026-10-04（titlecase 旗舰首跑，experience/titlecase-feature-run五连坑.md 坑 5）

Frequency:
  1 个场景（2 回合超时重试）：用户在对话中明确批准，resume 仍两次 300s 超时被拒

Evidence:
  run `cp2tz6hy` 终态 failed/currentStep=4；产物完好（分支 `a6f9b11`）但
  approved 状态与 cleanup 未执行——InteractiveCheckpointGate 只认 TUI RPC
  应答，对话/编程式批准无通道注入。

Problem:
  interactive 模式下经 workflow 工具编程式调用时，人工审批语义完成却无法
  收口 run。

Existing capability:
  PolicyCheckpointGate（auto-approve）可绕过但放弃人工闸门；超时 reject 保安全。

Current workaround:
  切 auto-approve 后 resume（丢人工语义）；或 journal 手术（不可推广）。

Impact:
  HITL 卖点在 headless/对话场景不可用；已完成实现被人工门卡死无法完成 run。

Complexity:
  M（journal 落 pending decision 或 CLI/工具回复 requestId 的通道设计）

Success criteria:
  用户在对话/CLI 表达的决定可送达挂起中的 gate；run 正常收口；
  通道有超时与幂等保护；不破坏 TUI 弹窗既有路径。

Decision:
  Watching

### Request: reviewer 输出解析容错（非法 JSON 无单点重试）

Source:
  titlecase 旗舰首跑 2026-10-04（experience/titlecase-feature-run五连坑.md 坑 3）；
  v1.1.0 验证跑 2026-10-04（run_1791051494484_5o0phtsh，trace events.jsonl）

Frequency:
  2 次（均作者 dogfood，同日两遇）

Evidence:
  verify 首败理由之三：`reviewer output was not valid JSON with
  verdict/summary`——reviewer agent 输出无强 schema 约束，一次格式跑偏
  （尾随文字/围栏等）即整体 fail；`assertVerify` 内无针对单 reviewer 的
  解析重试。
  第二次为**确定性复现**：v1.1.0 验证跑（kebabCase 需求）reviewer #1 pass、
  #2 输出非法 JSON；主 agent 自动 resume 重放 verify，#2 仍同样失败
  （trace：verify.completed×2 passedCount=1/2）。产物本身完好且独立复验
  通过（tsc + 9/9 单测），仅链路无法收口。

Problem:
  verify 步骤的结论解析脆弱：上游 analyze/implement/check 成本已沉没，
  却因一个 reviewer 的格式失误整步作废。

Existing capability:
  verify 并行多 reviewer + 判决聚合；失败可 resume 重跑 verify
  （completed 前缀跳过）——但重跑整步而非修复单点。

Current workaround:
  resume 重跑 verify 步骤（再赌一次格式运气）；或人工检查后接受。

Impact:
  长链路 workflow 的尾部脆弱性；verify 结论可信度打折（格式错 ≠ 评审否）。
  **已实际阻断旗舰链路收口**：两次 dogfood 均出现「产物完好、check 全绿、
  run 却 failed」——用户视角即「成功被判失败」。

Complexity:
  S~M（单 reviewer 解析失败局部重试 N 次；或 reviewer prompt 收紧 +
  输出 JSON mode/结构化抽取）

Success criteria:
  单 reviewer 输出非法时自动局部重试；重试仍失败才计入 fail 且报错
  明示「格式错误」与「评审否决」的区别；不影响多 reviewer 聚合语义。

Decision:
  Blocker Override（v0.3.1 已修复）

**Blocker 判定（2026-10-04）**：Reproducible ✅（2/2 确定性，含 resume 重放）；
False negative ✅（产物全绿被判失败）；Flagship blocking ✅（阻断旗舰链路收口，
外部测试第一批就会撞上）；无合理 workaround ✅（resume 只会重放同样失败的
verify）。满足 4/5 条件，按 Blocker Override 提前修复。

**修复落位（v0.3.1）**：`src/quality/verify.ts` 三态模型——语义结论
（pass/fail，**不重试**，禁止「问到同意为止」）/ 解析失败（**仅此类局部重试**，
默认 attempts=2，修复指令只要求重出格式不重新评审，`reviewerProtocol.attempts`
可调）/ 重试耗尽抛 `ReviewerProtocolError`（错误信息明确「verification
could not be completed … protocol failure, NOT a semantic rejection …
resume to retry verify」，绝不伪装成 `verify failed`）。新增
`verify.protocol_failed` 事件。单测 5 个新场景（含两个核心验收：
非法→重试→pass 恢复；重试耗尽→ProtocolError 而非 artifact rejected）。

### Request: journal 快照与外部变更的一致性（systemic 解法）

Source:
  titlecase 旗舰首跑 2026-10-04（experience/titlecase-feature-run五连坑.md 坑 4）

Frequency:
  1 次（外部 amend 救火后 resume，journal 衍生字段与现实脱节）

Evidence:
  外部 `git commit --amend` 修正交付后 resume：verify 的 diff 现算是干净的，
  但 journal 缓存的 `diffStat` 仍含 lockfile +365、`commitSha` 指向不存在
  的 commit——两源矛盾导致 reviewer 合理拒绝。当时靠手工「journal 手术」
  （改写已完成步骤的 output）才续跑成功。

Problem:
  resume 只信任 journal 快照，不感知 worktree/git 的外部修正；衍生字段
  缓存让「已完成的过去」绑架「现在的真相」。

Existing capability:
  v1.1.0 已落 author 侧缓解：verify 的 diffStat/commitSha 与 diff 同源现算
  （docs/workflow-authoring.md「派生字段不要跨步骤缓存」）；worktree/分支
  状态每次现查。

Current workaround:
  遵循 authoring 规则现算衍生数据；确需外部手术时手改 journal
  （不可推广，仅作者可用）。

Impact:
  任何绕过 workflow 的现场修正（人工救火、外部工具）都可能造成 journal
  与现实分叉；分叉后只有懂内部的人能救。

Complexity:
  M（候选方向：resume 时对衍生字段做一致性校验并标记失效/重建；
  或 journal 只存步骤产出、衍生数据一律消费点现算的架构化约定）

Success criteria:
  外部 amend/手改文件后 resume，不手改 journal 也能正确收口；
  校验发现分叉时给出明确诊断而非静默错误数据。

Decision:
  Watching

---

## Backlog（尚无真实用户来源，不得排期）

以下均为**内部设计时已知的能力缺口**，仅作记录——在拿到真实用户反馈前，
它们不构成 P3 排期依据：

### Large repository workspace strategy（大仓库隔离策略）

- 缺口：超大 repo（Unity/游戏/monorepo）下 full worktree 的工作树 checkout、
  依赖安装与缓存（`Library/`、`node_modules/`、build cache）成本过高
- 方案（完整设计见 `dev-docs/design/大仓库Workspace隔离策略.md`）：
  `sparse-worktree`（worktree + sparse-checkout）、`shared` 只读共享
  （分析/审查类 workflow 不建 worktree，可演进为步骤级策略）、
  `off`、缓存分离层（Git 文件隔离 + 缓存共享，CI 同构）、Workspace Scope
  （scope 同时约束 sparse checkout / agent cwd / search / RAG / 权限）
- 现状：`WorkspaceProvider` 抽象已支持扩展（Core 零改动，仅一种实现）；
  **当前默认 `git-worktree` 保持不变**
- 触发条件（任一真实反馈出现才启动）：① worktree 创建/checkout 明显慢；
  ② 单 run 磁盘占用过高；③ Unity/大型 monorepo 项目实际采用

### 自定义 workflow 装载机制（user-defined workflow loading）

- 缺口：npm 包 `exports` 只有插件入口（`.`/`./tui`/`./rpc`），无库形式的
  authoring API——外部用户今天**无法装载自己写的 workflow**（只能 fork 仓库
  改 `src/workflows/` + 注册）。这是 Adoption 指标 **A4（用户写自己的
  workflow，真正的 adoption 拐点）的产品前置**
- 现状：WorkflowDefinition/primitives 全部在包内但未作为公共 API 导出；
  `docs/workflow-authoring.md` 已沉淀编写规范（当前仅本仓库贡献者可用）
- 候选方向：库导出（`/sdk` 子路径）+ 用户定义装载（约定目录/配置注册），
  版本纪律与 resume 契约沿用现有 registry
- 触发条件：外部用户表达「想写自己的 workflow」（issue/对话），或
  Gallery 出现外部贡献——在此之前不预写装载骨架

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
