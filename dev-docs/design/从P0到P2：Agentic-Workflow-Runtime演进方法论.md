# 从 P0 到 P2：Durable Agentic Workflow Runtime 的演进方法论

> 一个 OpenCode 插件项目的三阶段实录：如何从「能跑一个 multi-agent workflow」
> 走到「崩溃后可恢复、全程可观测、每次 run 文件系统隔离的生产级 Runtime」。
> 本文是方法论文档，可直接作为分享/案例材料；逐 commit 交付细节见
> `dev-docs/progress/执行进度.md`。

日期：2026-10-03 ｜ 版本：v0.3.0（P0/P1/P2 全部收官）

---

## 0. 三问框架

整个项目的路线图可以压缩成三个问题：

```text
P0  Can it run?             能不能跑起来
P1  Can it run reliably?    跑得可不可靠
P2  Can it survive production?  生产环境崩了之后还活着吗
```

它们分别对应三种工程能力：

| 阶段 | 问题 | 交付 | 版本 |
|------|------|------|------|
| P0 | Execution | 编排原语（agent/parallel/sequence/phase）+ 宿主适配（V2 Executor）+ 递归防护 | v0.1.0 |
| P1 | Reliability | 确定性检查（check/assert）+ 语义评审（verify）+ 失败语义与重试降级 + 审批门 | v0.2.0 |
| P2 | Production Runtime | Journal/Resume + 版本化 Registry + 事件 Trace + Token/Cost Metrics + Worktree 隔离 | v0.3.0 |

关键在于**顺序不可交换**：durability 建立在 reliability 之上（checkpoint 语义
稳定后才敢做 journal），reliability 建立在 execution 之上（原语稳定后才定义
失败语义）。每一阶段用真实 e2e 关门，才进入下一阶段。

---

## 1. P0：Can it run? —— 先把边界画对

P0 的产出很小（跑通 smoke workflow），但定下了后面所有阶段的**架构红线**：

```text
Workflow Core（编排/质量/状态/观测/注册表/工作区）零 OpenCode 依赖
只有 src/plugin/ 允许 import @opencode/plugin
workflow → AgentExecutor（抽象） → OpenCodeV2Executor（实现） → ctx.session
```

这条红线的价值在 P2 才真正兑现：journal、trace、metrics、worktree 全部
可以脱离 OpenCode 单测（158 个测试无需起服务），宿主 API 的坑
（cost 记账为 0、价目缓存滞后、session location……）全部被隔离在
plugin 层一个目录里。

P0 也是踩坑密度最高的阶段，三个坑全部沉淀为经验文档：

1. **工具抛错 → 主 agent 无限重试**（22 轮重试烧穿配额）→ 工具永不抛错，
   失败以结果文本返回；
2. **子会话递归调用 workflow + 并发信号量 = 自饿死死锁**→ 运行中直接拒绝嵌套；
3. **模型 API 并发上限** → `withConcurrencyLimit` 默认 3，全链路统一限流。

> 方法论 1：**先把依赖边界画死，再写功能**。边界不是文档约定，
> 是 import 检查可验证的事实。

> 方法论 2：**每个坑都要变成机制或经验文档**，否则会在 P2 更高的
> 复杂度下原样复发。

---

## 2. P1：Can it run reliably? —— 分清"做事"与"验证"

P1 的核心洞察是职责二分：

```text
agent  = 做事（LLM，非确定性，可能错）
check  = 确定性验证（谓词，可重复，退出码/fs 判定）
verify = 语义验证（多 reviewer 独立评审 + 聚合 verdict）
```

由此得到 reliable workflow 的标准链：

```text
execute（agent 产出）→ check（命令/谓词硬校验）→ verify（多评审语义校验）
→ checkpoint（人工/策略审批）→ 任一环失败即 fail-fast
```

工程要点：

- **失败语义分级**：步骤失败 / run 失败 / 中断（aborted）三态，
  失败信息完整可结构化消费（WorkflowCheckError 携带 CheckResult）；
- **审批门是注入抽象**：P1 只做策略门（auto-approve/auto-reject）——
  因为 server 侧插件域没有创建交互请求的 API。**先证明语义，再补交互**，
  interactive TUI 审批留给 P2（RPC 双形态插件）；
- **状态用 prev 链累积**（`{...prev, newFields}`）而不是闭包捕获——
  这在当时只是风格选择，在 P2 resume 时成为硬要求（跳过的步骤也要能
  重建最终报告）。

> 方法论 3：**确定性验证和非确定性执行必须分开建模**——
> "让 LLM 自己检查自己"不是 reliability，是错觉。

> 方法论 4：**平台没有的能力（如 server 侧交互），先用策略抽象顶住语义，
> 把交互形态作为后续注入实现**。不为平台缺口停下主线。

---

## 3. P2：Can it survive production? —— durable 的四块基石

### 3.1 Journal + Resume：崩溃是常态

```text
每次状态变更原子落盘（journal = 一串快照，不是日志追加）
崩溃 → 新进程读 journal → registry 精确版本解析 → completed 步骤跳过 → 续跑
```

三个关键决策（全部来自真实教训）：

1. **journal 记录 workflow {id, version}，resume 精确版本解析**——
   绝不隐式取最新。版本漂移下"恢复"等于用错误的步骤结构解释旧状态；
2. **resume 只支持 `sequence()`**（用户决策）：并行步骤的部分完成语义
   复杂度远超收益，先不做；
3. **失败输出自带恢复句柄**（`可用 resumeRunId="..." 恢复本次执行`）——
   恢复路径必须写在失败现场，不能指望用户翻文档。

### 3.2 Registry：workflow 是带版本身份的资产

```text
WorkflowDefinition { id, version, description, argsSchema, stepNames, run(args, ctx) }
同 id 多版本共存；get(id) 取最新 semver，get(id, version) 精确命中
工具的 flow 枚举/描述/路由全部由注册表驱动
```

args 用 JSON-Schema 子集校验（不引 Zod）——定义即契约，
工具调用面和 resume 面共用同一份校验。

### 3.3 Observability + Metrics：旁路消费，不侵入主链

事件总线（P2.4）是分水岭：全原语只 emit 事件，
trace 落盘和 metrics 聚合都是**纯消费者**：

```text
EventBus → TraceSink（events.jsonl）
        → MetricsCollector（tokens/cost/时长/质量门计数 → workflow_metrics 工具 + metrics.json）
```

metrics 接入零改动编排代码——这是"观测不能成为故障源"的结构性保障
（聚合/落盘失败只记录，不阻断 workflow）。

成本口径来自实测：宿主消息的 cost 常记账为 0，价目表可能滞后于线上，
因此取值优先级定为 **用户覆盖 > 宿主价目 > 宿主上报**，
并用 token×价目估算兜底（reasoning 按 output 价计，文档化约定）。

### 3.4 Worktree Isolation：durable = journal 状态 + 文件系统状态

抽象先行（Core 不知道 git）：

```text
WorkspaceProvider { create(runId) / attach(identity) }
GitWorktreeProvider：git worktree add -b agw/<runId>（仓库同级目录）
resume → attach journal 记录的原 worktree（缺失即报错，绝不静默重建）
cleanup：on-success（默认，失败留现场）/ always / never
```

子会话 cwd 经 `session.create({ location })` 绑定到 worktree 根——
**产物落隔离目录、项目目录零污染**，真实 e2e 验证。

这一段踩出两条 durable 语义定律：

> 定律 1：**journal 先收口，外部资源清理最后做**。清理先于收口，
> 会让持有旧内存快照的 journal 在收口落盘时把已清理的资源身份
> "复活"写回——幂等 resume 随即 attach 一个已删除的目录。

> 定律 2：**跨进程恢复时，资源的归属从资源自身解析**。
> journal 里记录的 path 是唯一事实源；从当前环境（cwd/配置/startDir）
> 重推导归属，在跨目录场景必然错位。

---

## 4. 验收方法论：从"看 stdout"到"读现场"

这是贯穿三阶段、进化最多的一条线：

```text
P0     裸跑 opencode run 看输出            → 一次挂死终端（opencode run 可永久无响应）
P1     预检模型 + 看门狗超时                → 分不清"慢"和"死"仍是问题
P2 初  看门狗 + journal/trace 落盘取证      → stdout 丢失也能完整还原
P2 末  可复用验收脚本（全新目录/新服务/真实 restart，
       31 项断言：journal/trace/metrics/worktree 全取证）
```

沉淀出的纪律：

1. **取证优先级：journal > traceDir 文件 > 工具结果原文 > stdout**
   （stdout 可能随进程死亡丢失；磁盘文件天然免疫被杀）；
2. **每次验收全新一次性目录**（service 缓存插件代码直至 restart；
   在 agent 会话里 restart service 会杀死自己的服务）；
3. **看门狗按最坏延迟给**（同一天同一模型，单 agent 从 12s 到 15.6 分钟）；
   预检只验证可用性，不验证延迟；
4. **macOS 看门狗直杀 PID + 杀进程树**（子壳/管道模式杀不掉 opencode 本体）；
5. **被杀的 run 不是废数据**——durable 设计让每次挂起事故都成为
   一次免费的恢复演练。

意外收获：**e2e 的"重启"不需要真做进程崩溃**——新目录 + 新服务 +
共享绝对路径 journalDir，就是一次等价（且可重复）的 restart。

---

## 5. 依赖倒置清单：五个注入抽象

Core 零宿主依赖不是口号，是五个具体的接缝：

| 抽象 | Core 侧 | 宿主实现 | 换实现的能力 |
|------|---------|----------|--------------|
| `AgentExecutor` | 执行子任务 | OpenCodeV2Executor（session/prompt/wait/usage 提取） | MockExecutor 全离线单测；可接其他宿主 |
| `CheckpointGate` | ask(decision) | 策略门 / TUI 交互门（RPC 双形态） | CI 用策略门，桌面用交互门 |
| `CommandRunner` | 跑确定性命令 | NodeCommandRunner（强制超时） | 测试注入替身 |
| `ExecutionStore` | run 状态存取 | FileExecutionStore（原子写） | 可换 DB 存储 |
| `WorkspaceProvider` | create/attach 工作区 | GitWorktreeProvider | 可换 Docker/远程工作区 |

加上 ambient 绑定模式（`setExecutor` / `setCheckpointGate` /
`setCurrentWorkspace`：runner 设置、原语读取），workflow 业务代码
完全不感知宿主与生命周期——这就是"声明式定义可 durable"的结构前提。

---

## 6. 数据：20 个 commit，三个版本

```text
P0  v0.1.0   commit 01–06   能跑：原语 + V2 适配 + 递归防护（11 tests）
P1  v0.2.0   commit 07–12   可靠：check/verify/重试降级/审批（32→… tests）
P2  v0.3.0   commit 13–20   生产：journal/resume/registry/trace/metrics/isolation
                           （158 tests + 31 项真实 e2e 全链断言）
经验文档 11 篇；每个阶段关门标准 = 真实 e2e（非仅单测）
```

## 7. 下一步：Release & Adoption，而不是 P3

P2 收官后的选择是**先不堆功能**：

```text
v0.3.0 收口：README / 架构图 / Quick Start / 六类示例 / 迁移指南 / 本方法论
之后再评估 P3 候选（多 workflow 并发调度、workflow 市场、远程工作区、
RunTree TUI、DB 存储……）
```

理由很朴素：能力已经发生质变（Execution → Production Runtime），
但**别人看不懂怎么用的东西，技术上再强也等于不存在**。
先让人用起来，让使用反馈决定 P3 做什么。

---

## 附：一句话总结

> **P0 把边界画对，P1 把失败当一等公民，P2 把崩溃当常态——
> 而贯穿始终的，是"每个抽象都注入、每次验收都留现场、每个坑都变文档"。**
