# v1 能力对照与补齐排期（opencode-dynamic-workflows → opencode-agentic-workflow）

**日期**：2026-10-04 ｜ **性质**：排期 Backlog（对照基线：`thirdparties/opencode-dynamicworkflows`，
即本项目的 OpenCode v1 前代，npm `@mickorz/opencode-dynamic-workflows`）
**对照方法**：逐子系统盘点 v1 源码（runtime/schedule/tui/tools/cli/skills/agent/isolation）
+ DSL 参考 + how-to/configuration 文档，与 v2 现状（v0.4.0 + P4）逐项映射。

## 一、已覆盖映射（不需要再做）

| v1 能力 | v2 现状 |
|---|---|
| parallel 并发 + 自动钳制 | ✓ `parallel` + `withConcurrencyLimit`（默认 3，模型 API 约束） |
| sequence / fallback / retry / phase / check | ✓ 同名组合子 + `assert` |
| verify 对抗评审 | ✓ 更严格：全票制 + reviewer 协议局部重试（v1 是阈值投票，见 P2-11 增强） |
| checkpoint 人工确认（UI 通道 / headless 默认） | ✓ 更强：interactive RPC 门 + 策略门 + 调用级 `checkpointMode` 覆盖 |
| worktree 隔离 | ✓ 更强：run 级绑定 + journal 身份 + resume 精确重附着（v1 是 agent 级 opt-in，见差异表） |
| journal + 断点续跑 | ✓ 更强：版本化 registry + 步骤前缀跳过 + 精确版本解析（v1 按调用位置回放） |
| 上下文防污染（只回聚合结果） | ✓ 同一设计哲学 |
| 自定义流程装载 | ✓ P4 声明式 JSON（v1 是 JS 脚本 + skill 生成，见 P0-2 补生成链路） |
| token/时长统计 | ✓ metrics collector + `workflow_metrics` 工具 + 价目表成本估算（v2 多出美元成本） |

## 二、缺口排期（按优先级序）

> 优先级依据：① 是否阻塞已发布能力的完整可用；② adoption 策略（A4 拐点 =
> 用户自己写流程）；③ 外部测试在途的摩擦信号；④ v1 老用户迁移的硬缺口。

### P0 —— 阻塞性缺口（下一迭代立即排）

1. ~~**流程参数透传**（S）~~ ✅ **已完成（2026-10-04 深夜，随 0.5.0 发布）**——
   `src/plugin/tool-args.ts`（topic 恒顶层 + args 合并，非对象 fail-loud）、
   工具 schema 新增 `args` 参数、`registry.summarize()` 摘要非 topic 参数
   （`[args: name(type, required)]`，可发现性是透传的另一半）；测试 +7
   （全量 211/211）；E2E 实跑验收（examples/02 改造练习 2 形态）：
   audience 参数直达 prompt，journal args 完整落盘，产物按目标读者行文。
   feature-development 的 checkCommand/reviewers/keepLockfileChanges 同时解锁。
2. **自然语言 → 声明式 JSON 生成链路**（S~M）——v1 的「零代码」核心体验：主 agent
   经 skill 引导直接写出合规 flows/*.json 并落盘。v2 的 P4 只有手写路径。
   形态：workflow 工具描述内嵌格式规范 + （可选）内置 workflow-authoring skill。
   **验收**：对话中说需求 → 生成 JSON → 注册 → 调用全链无需人工编辑文件。

### P1 —— v1 老用户迁移硬缺口（本迭代争取）

3. **后台运行与 run 控制**（M）——v1：缺省后台返回 runId、完成后结果自动回传会话、
   `workflow_control status/stop` 全局控制。v2：前台阻塞、无停止手段（外部测试
   Watching 已有「杀进程后 run 悬置」信号，互相印证）。stop 语义需与 journal
   的 cancelled 状态（Watching 既有条目）一并设计。
4. **agent 调用级选项**（M）——v1：per-call `model` / `tier`（model-tiers.json 分层，
   小模型干活大模型把关）/ `timeoutMs` / `retries`。v2：model/agent 是插件级全局。
   分步：先 per-call model + timeoutMs/retries（executor 已有注入点），tier 体系缓发。
5. **组合子补齐：pipeline / race / judgePanel**（M）——v1 DSL 三件缺失件
   （流水线多阶段整形；首达取胜；评审团打分选优）。代码式可手工组合，
   但声明式与内置流程应有原语。judgePanel 与 verify 的 lens 想法同源。
6. **结构化输出**（M，有前置调研）——v1：agent 按 schema 返回对象。v2：纯文本。
   依赖 OpenCode v2 session API 的结构化输出能力，先做 API 验证再排实现。

### P2 —— 差异化体验 / 生态（按反馈启动）

7. **定时任务子系统**（M~L）——v1：cron + service + 协调 + store + `/schedule`
   命令（自然语言→cron→schedule_create 工具），边界「需 OpenCode 常驻」。
   v2：无。外部测试若有「定时跑旗舰」诉求则提前。
8. **TUI 进度树与节点详情**（L）——v1 招牌体验：侧栏实时树、节点详情（结果 +
   模型/时长/token 元数据 + Open Session 回放）、嵌套层级树。v2：trace JSONL
   落盘但无可视化。技术路径已有底子（interactive gate 的 RPC 双形态）。
9. **嵌套工作流**（L，架构前置）——v1：原生 `workflow()` 原语 + lineage。v2：
   递归守卫**显式禁止**（自饿死事故）。前置：checkpoint gate / executor 的
   per-run 化——与 0.4.0 已知限制「全局 gate 单例竞态」同根，是同一个 L 范围
   架构工作，宜一并设计。
10. **Installer CLI**（S~M，等数据）——v1：`npx install/uninstall/update/doctor`
    （配置合并 + .bak + skills 安装）。v2：手改 opencode.json（README 已验证可行）。
    是否值得做等外部测试的安装卡点反馈。
11. **verify 增强：lens 多视角 + threshold 投票**（S）——v1 的 reviewer 分配视角
    （安全/性能/正确性…）与阈值投票制，作为 v2 全票制之外的**可选项**引入
    （`mode: "unanimous" | "vote"`）。
12. **Skills 打包分发**（S）——v1：workflow-authoring（DSL 参考）+ workflow-optimize
    （迭代优化闭环）两个 skill 随装。v2：docs/ 已有人向指南；skill 形态（面向
    agent 消费）与 P0-2 的生成链路天然配套。

## 三、有意不回抄（v2 设计取态，防摇摆记录）

- **worktree 静默降级**（v1 非 git 目录/创建失败时静默共享目录）：v2 选择 fail-loud
  + journal 身份精确重附着——静默降级正是 0.4.0 两个 Blocker 的病灶家族
- **checkpoint 无 UI 通道时默认通过**（v1 `opts.default` 缺省 true）：v2 用显式
  策略门 + 调用级覆盖，安全语义优先
- **按调用位置回放的 resume**：v2 用版本化 journal + 前缀跳过 + 精确版本解析，
  语义更强（结构变更后不会错位），不回抄

## 四、纪律说明

- 本文档只做排期索引；各项立项时另建 P 级文档（含验收标准），完成即回填状态
- 与 P3-candidates 的关系：P3 是 bug/摩擦管道，本文是 feature 缺口管道；
  若某缺口被外部测试复现为阻塞，按 Blocker Override 规则提级
