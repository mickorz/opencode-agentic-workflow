# P3 Candidates（反馈驱动，不预设功能）

> 纪律：P3 不从「我觉得有用」出发，只从真实反馈出发。
> 每个候选必须有 Source（issue/discussion/用户对话）与 Frequency；
> 没有来源的条目只能停留在 Backlog 区，不得排期。

## 流程

```text
用户反馈 → 归类 → 出现频率 → 现有能力能否解决 → 是否属于 Runtime → P3 Candidate
```

## 候选条目模板

```text
## Request: <名称>

Source:
  GitHub issue #xx / discussion / 用户对话（日期）

Frequency:
  N 个独立用户/场景

Problem:
  <用户面对的真实问题，不是我们想象的功能缺口>

Current workaround:
  <用户现在怎么绕过>

Impact:
  <不解决的后果>

Complexity:
  <S/M/L 估计>

Decision:
  Pending / Accepted(v0.4.x) / Declined(原因) / Deferred
```

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
