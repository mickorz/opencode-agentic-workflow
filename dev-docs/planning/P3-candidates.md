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

（暂无真实信号；有 1–2 次出现的需求放这里，防丢趋势）

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
