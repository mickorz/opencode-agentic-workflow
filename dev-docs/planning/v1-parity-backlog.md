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
2. ~~**自然语言 → 声明式 JSON 生成链路**（S~M）~~ ✅ **已完成（2026-10-05，随 0.5.0
   发布）**——新工具 `workflow_define`：主 agent 对话中把需求整理成声明式 JSON，
   校验（复用装载器同一套规则）→ 立即注册（当场可调用）→ 落盘到 `workflows`
   配置目录（之后每次启动自动装载）。幂等重定义 / 同版不同内容拒绝（版本契约）/
   升版共存取最新；`flow` 参数由 enum 改自由字符串（运行期定义的 id 可达，
   未知 id 报错并列出可用清单）。测试 +8（全量 219/219）；E2E 一次通过：
   对话给需求 → agent 生成合规 JSON（缺省 version 补齐）→ 落盘 → 立即调用，
   journal `compare@1.0.0` completed ×2，产物落盘，全程零人工编辑文件。

### P1 —— v1 老用户迁移硬缺口（本迭代争取）

3. ~~**后台运行与 run 控制**（M）~~ ✅ **已完成（2026-10-05，随 0.5.0 发布）**——
   `workflow` 工具新增 `background=true`（begin/run 拆分，runId 先行返回，
   depth/gate 生命周期移交 completion；结果经 `workflow_control status` 轮询，
   journal 为唯一事实源）；新工具 `workflow_control`：status（全量列表/单 run
   详情含 output）+ stop（活体=协作式取消于步骤边界、journal 收口
   **aborted**（主动停≠出错，reopen 兼容可 resume）；孤儿 run 直接收口——
   外部测试「杀进程后 run 悬置」信号的解）。已知限制：单进程同时仅一个
   workflow（gate/workspace 全局单例，L 范围架构项与 P2-9 同根）。
   测试 +8（全量 227/227）；E2E：后台启动→轮询→journal completed×3→产物落盘。
4. ~~**agent 调用级选项**（M）~~ ✅ **已完成（2026-10-05，随 0.5.0 发布）**——
   `agent(prompt, { model, timeoutMs, retries, retryDelayMs })`：model
   （"providerID/modelId"，经 AgentTask.model 透传，executor 以 task.model
   优先于构造期默认）；timeoutMs（单次尝试超时，超时不硬杀底层会话——与
   run 控制同一诚实语义）；retries 对超时同样生效（每次尝试独立计时）。
   声明式 agent 步开放可选键 model/timeoutMs/retries（校验逐一指名；
   非 agent 步带选项键 = unknown key 拒绝）。tier 体系仍缓发。
   测试 +10（全量 237/237）；E2E：声明式带三项选项实跑 completed、产物落盘。
5. ~~**组合子补齐：pipeline / race / judgePanel**（M）~~ ✅ **已完成（2026-10-05，
   随 0.5.0 发布）**——代码式三原语落地（v2 语义适配）：`pipeline`（条目并发 ×
   阶段链串联，onFailure fail-fast/continue 与 sequence 同构）；`race`
   （首个成功即胜出、败者不再等待——无法硬杀 LLM 调用与 run 控制同一诚实
   语义；全败聚合抛 WorkflowRaceError，不塌缩 null）；`judgePanel`
   （N 评委 × 候选并发打分 0-10，文本解析（结构化输出待 P1-6），解析失败
   =该评委失败计入统计不进均分，全部候选无有效评分明确抛错）。测试 +13
   （全量 250/250）。**声明式嵌套流程（pipeline/race 进 JSON）为新增缺口**：
   resumeSequence 仅支持 sequence 前缀恢复，嵌套形状需先设计断点语义
   （记录在「后续缺口」）。
6. ~~**结构化输出**（M，有前置调研）~~ ✅ **以 shim 形态完成（2026-10-05，随 0.5.0
   发布）**——前置调研结论：**OpenCode v2 会话 API 无原生结构化输出**
  （`@opencode/schema` 2.0.22 的 `PromptInput.Prompt` 仅
   text/files/agents/skills，v1 的 `format: "json_schema"` → `info.structured`
   链路在 v2 不存在）。落地：`agent(prompt, { schema })` shim——prompt 追加
   JSON 契约指令 + `extractJson` 解析（兼容围栏包裹）+ 复用 `validateArgs`
   校验 + **校验在重试环内**（违规输出与执行失败同等可被 retries 重试）；
   结果挂 `result.structured`。文档如实标注「prompt 约束 + 校验兜底，
   非宿主级保证」。上游若补原生能力，executor 层换实现、调用面不变。
   测试 +6（全量 256/256）。

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
11. ~~**verify 增强：lens 多视角 + threshold 投票**（S）~~ ✅ **已完成（2026-10-05，
    随 0.5.0 发布）**——`passThreshold`（(0,1] 投票阈值，缺省 1 = 全票/旧行为）
    + `lenses: [{ name, criteria }]`（多视角：一个视角一个评审员、各按专属
    标准评，覆盖 reviewers/criteria；与 threshold 组合成视角投票）。
    声明式 verify 步与代码式 `verify()` 同步支持；协议失败（解析重试耗尽）
    与语义否决的既有分离不变。测试 +8（全量 264/264）；E2E：声明式
    lenses+threshold 实跑 completed、双视角真实评审员、产物落盘。
12. ~~**Skills 打包分发**（S）~~ ✅ **已完成（2026-10-05，随 0.5.0 发布）**——
    `skills/workflow-authoring`（需求澄清 → 声明式 JSON 构造 → workflow_define
    落盘注册 → 试跑验证，含必守纪律与报错速查表）与 `skills/workflow-optimize`
    （metrics/journal 诊断 → 单主题改动 → 升版重定义 → 同参重跑 → 对比报告）
    两个 agent skill 随 npm 包分发（package.json files += "skills"；启用 =
    opencode.json `skills` 数组直连包内目录，零拷贝）。结构校验测试 +2
    （frontmatter/命名/描述长度，全量 266/266）；E2E：skills 数组挂载 →
    主 agent 加载技能并遵循（定义的流程 prompt 含技能要求的递归防护句）→
    workflow_define 落盘 → 试跑 completed、产物在。

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
