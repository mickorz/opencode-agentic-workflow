# v1 examples 复刻全集（legacy 适配实机验收）

来源：`opencode-dynamicworkflows/examples/sample-project/scripts/`（60 个）
+ `.opencode-workflows/workflows/schedule-test.js` 与
`.opencode/workflows/fff-search-benchmark.js` —— **共 62 个脚本逐字原样复刻**，
零改写（含注释、路径引用、`export const meta` 形态）。

装载：testworkflow 的 `opencode.json` `workflows` 选项指向本目录 4 个入口
（scripts/、scripts/native/、scripts/composite/、workflows/）。
运行时 cwd = testworkflow（docs/ 下 10 个 mdx 为 acceptance/phase-elapsed
的语料，已随复刻放置；testworkflow 已 git init——worktree 隔离真路径用）。

## 分类矩阵（9 类 62 个）

### A. 基础编排（7）
| flow id | 文件 | 验证点 | 预期 | 实测 |
|---|---|---|---|---|
| smoke_test | scripts/smoke-test.js | 3 agent（1+2 并行）、phase、顶层 return | ✅ 完成 | ✅ 完成 [0.8.1] |
| chain_root | scripts/chain-root.js | **v1 工具嵌套形态**（子 agent 调 workflow 工具 scriptPath） | ⚠️ v2 按设计拒绝 run 内工具调用（防信号量自饿死），由 subflow 取代；外层 run 本身完成 | ✅ 完成（外层完成；内层工具调用被拒——已知分歧#1）[0.8.1] |
| chain_middle | scripts/chain-middle.js | 同上（中间层） | ⚠️ 同上 | ❌ 失败（内层被拒→300s 超时→闸门；分歧#1 实证）[0.8.1] |
| chain_leaf | scripts/chain-leaf.js | 被嵌套叶子（单独跑 = 普通 flow） | ✅ 完成 | ✅ 完成（返回缺 docs/plugins.mdx——v1 语料同款缺口）[0.8.1] |
| multi_tree_a | scripts/multi-tree-a.js | 多 run 同树 | ✅ 完成 | ✅ 完成 [0.8.1] |
| multi_tree_b | scripts/multi-tree-b.js | 同上 | ✅ 完成 | ✅ 完成 [0.8.1] |
| schedule_test | workflows/schedule-test.js | 最小单 agent + log | ✅ 完成 | ✅ 完成 [0.8.2] |

### B. 并发与队列（5）
| flow id | 文件 | 验证点 | 预期 | 实测 |
|---|---|---|---|---|
| concurrency_limit_test | scripts/concurrency-limit-test.js | 24 探针并行（信号量缺省 CPU-2） | ✅ 完成 | ✅ 完成 [0.8.1] |
| tui_progress | scripts/tui-progress-test.js | 4 并行 + 1 汇总实时树 | ✅ 完成 | ✅ 完成 [0.8.2] |
| queue_timer | scripts/composite/queue-timer-test.js | 4 慢 agent 排队计时 | ✅ 完成 | ⛔ 未跑成（GLM 5h 滚动配额三轮全撞，无 journal） |
| phase_elapsed_test | scripts/phase-elapsed-test.js | phase 耗时（读 docs 语料） | ✅ 完成（phase 仅日志——v2 面板无阶段分组） | ✅ 完成（phase 进日志）[0.8.2] |
| node_detail_large_result_optimized | scripts/opencode-large-json-parallel-test.js | 大 JSON 分片并行（6×20 条）+ schema | ✅ 完成 | ✅ 完成 [0.8.2] |

### C. 质量 DSL（4）
| flow id | 文件 | 验证点 | 预期 | 实测 |
|---|---|---|---|---|
| quality_demo | scripts/quality-dsl-test.js | judgePanel + verify + checkpoint 全链 | ✅ 完成（checkpoint 需 auto-approve） | ⛔ 未跑成（GLM 5h 滚动配额三轮全撞，无 journal） |
| schema_test | scripts/schema-test.js | 结构化输出 shim | ✅ 完成 | ⛔ 未跑成（GLM 5h 滚动配额三轮全撞，无 journal） |
| tui_checkpoint | scripts/composite/tui-checkpoint-test.js | checkpoint 布尔语义 | ✅ 完成（gate auto-approve → true） | ✅ 完成（gate auto-approve→true）[0.8.2] |
| failure_gate | scripts/composite/failure-gate-test.js | **阶段失败闸门**：1ms 超时 → null + 同 phase tail 照常 → 下一 phase 边界终止 | ❌ 失败（闸门触发，v1 对位） | ❌ 失败=闸门触发 ✓ 预期（tail 照常+边界拦）[0.8.1] |

### D. 失败语义（4）
| flow id | 文件 | 验证点 | 预期 | 实测 |
|---|---|---|---|---|
| tui_failure | scripts/tui-failure-test.js | 全部立即超时 → parallel 塌缩 null → 终检闸门 | ❌ 失败（闸门，v1 对位） | ❌ 失败=塌缩→终检闸门 ✓ 预期 [0.8.2] |
| node_detail_failed | scripts/node-detail-failed-test.js | 失败态节点 | ❌ 失败（设计如此） | ❌ 失败=设计如此 ✓ [0.8.2] |
| node_detail_retry | scripts/node-detail-retry-test.js | 重试多 attempt 后超时塌缩 | ❌ 失败（闸门）或完成（被吸收） | ❌ 失败（timeoutMs:1×retries:3 设计性耗尽→塌缩→闸门）✓ [0.8.2] |
| node_detail_out_of_order | scripts/node-detail-out-of-order-test.js | 乱序完成 | ✅ 完成 | ✅ 完成 [0.8.2] |

### E. 子流程 native（19，workflow() 路径形/对象形）
| flow id | 文件 | 验证点 | 预期 | 实测 |
|---|---|---|---|---|
| deep_parent / deep_child | native/deep_parent.js, deep_child.js | 两层嵌套（child 再引 1_spec） | ✅ 完成 | ✅✅ 完成 [0.8.1] |
| deep_chain / deep_l2 / deep_l3 | native/deep_chain_*.js | 三层链 | ⚠️ 深度上限 3：parent(0)→l2(1)→l3(2) 内再 subflow 视深度 | ✅✅✅ 完成（深度≤3 未触 guard）[0.8.1] |
| self_ref / self_ref_parent | native/self_ref*.js | 自引用递归 → 深度守卫 | ❌ 失败（subflow nesting too deep，v1 事故教训对位） | ❌❌ 失败=深度守卫 ✓ 预期 [0.8.2] |
| error_parent / error_child | native/error_*.js | 子流程业务失败上抛（父 try/catch 自理：parent 完成、child 单跑失败） | ✅ parent 完成 / ❌ child 失败 | ✅ parent 完成 [0.8.1] / ❌ child 失败 ✓ 预期 [0.8.2] |
| mutate_parent / mutate_child | native/mutate_*.js | args 下传与改写（克隆隔离验收：子改 args 不污染父） | ⚠️ 0.8.1 预期失败（克隆缺口）→ 0.8.2 修复复验 | ✅ child [0.8.1]；parent 0.8.1 完成但 counter=999（克隆污染）→ **0.8.2 复验未完成** |
| resume_parent / resume_child | native/resume_*.js | 首跑建 journal（v2 legacy resume=整体重跑） | ✅ 完成（首跑） | ⛔ 未跑成（GLM 5h 滚动配额三轮全撞，无 journal） |
| registry_parent | native/registry_parent.js | workflow('schedule_test') 注册名引用 | ✅ 完成 | ⛔ 未跑成（GLM 5h 滚动配额三轮全撞，无 journal）（flow id=registry_demo） |
| native_pipeline | native/pipeline_parent.js | spec→design→code 三段传值 | ✅ 完成 | ✅ 完成 [0.8.2] |
| native_compare | native/compare_parent.js | 对象形 {scriptPath,label} ×3 并行 | ✅ 完成 | ✅ 完成（3 lane 并行）[0.8.2] |
| native_spec / native_design / native_code | native/1_spec.js, 2_design.js, 3_code.js | 被引用的子流（可独立跑） | ✅ 完成 | ✅✅✅ 完成 [0.8.2] |

### F. 子流程 composite（15，seq/race/fallback 家族）
| flow id | 文件 | 验证点 | 预期 | 实测 |
|---|---|---|---|---|
| composite_seq | composite/seq_parent.js | sequence 传值链 + 子流 | ✅ 完成 | ✅ 完成 [0.8.1] |
| composite_seq_par | composite/seq_parallel_parent.js | seq + 并行子流 | ✅ 完成 | ✅ 完成 [0.8.1] |
| composite_seq_fail | composite/seq_fail_parent.js | 节点抛普通 Error → sequence 停止返 null，run 完成 | ⚠️ 0.8.1 预期失败（错误分类学缺口）→ 0.8.2 修复复验 | ✅ **完成——0.8.2 修复实证**（普通 Error 停止返 null，STOP-CHECK tail 照常） |
| composite_seq_resume | composite/seq_resume_parent.js | 前缀回放（v2 legacy=重跑） | ✅ 完成 | ✅ 完成（首跑+重跑）[0.8.1] |
| composite_race | composite/race_parent.js | race 胜出 + 取消兄弟 | ✅ 完成 | ✅ 完成 [0.8.1] |
| composite_race_fb | composite/race_fallback_parent.js | race 内嵌 fallback | ✅ 完成 | ✅ 完成 [0.8.1] |
| race_slow（被引用子流） | composite/race_slow.js | 慢分支 | ✅ 完成（独立跑） | ✅ 完成（独立跑）[0.8.1] |
| composite_fb_first | composite/fb_first_parent.js | fallback 首选成功 + 吸收闸门 | ✅ 完成 | ✅ 完成（winner=fast，闸门被吸收）[0.8.1] |
| composite_fb_child | composite/fb_child_parent.js | 首选子流失败（普通 Error）→ 次选兜底，run 完成 | ⚠️ 0.8.1 预期失败（分类学缺口）→ 0.8.2 修复复验 | ❌ 失败 [0.8.1] =分类学缺口实证（候选失败上抛）→ **0.8.2 复验未完成** |
| composite_fb_struct | composite/fb_structural_parent.js | **不存在的脚本路径** → fail-loud | ❌ 失败（路径解析 fail-loud，v1 对位） | ❌ 失败=fail-loud ✓ 预期 [0.8.1] |
| composite_par_fail | composite/par_child_fail_parent.js | 子流可恢复失败塌缩 null + 兄弟照常，run 完成 | ⚠️ 0.8.1 预期失败（分类学缺口）→ 0.8.2 修复复验 | ✅ **完成——0.8.2 修复实证**（error_child 子流失败→塌缩 null→run completed，步骤级证据） |
| tui_enhance | composite/tui-enhance-test.js | 重试进度/超时上限（8s 超时×3 重试节点） | ❌ 失败（闸门，验收点之一） | ❌ 失败=8s×3 耗尽→闸门 ✓ 预期 [0.8.2] |

### G. 隔离与生命周期（4）
| flow id | 文件 | 验证点 | 预期 | 实测 |
|---|---|---|---|---|
| worktree_demo | scripts/worktree-test.js | per-call worktree 隔离（创建→执行→git status→拆除） | ✅ 完成（testworkflow 已 git init，真隔离路径） | ✅ 完成（git status 隔离痕迹 ✓）[0.8.2] |
| bg_demo | scripts/background-test.js | 3 并行 + 汇总（v2 background 由工具参数控制） | ✅ 完成（前台跑） | ✅ 完成（前台）[0.8.1] |
| resume_demo | scripts/resume-test.js | 3 顺序 agent 首跑建 journal | ✅ 完成（首跑；legacy resume=整体重跑） | ⛔ 未跑成（GLM 5h 滚动配额三轮全撞，无 journal） |
| tier_fallback_demo | scripts/tier-fallback-test.js | 未配置 tier → 响亮警告 + 回落 run 级模型 | ✅ 完成（警告 + 回落） | ⛔ 未跑成（GLM 5h 滚动配额三轮全撞，无 journal） |

### H. Node Inspector 基准（6）
| flow id | 文件 | 验证点 | 预期 | 实测 |
|---|---|---|---|---|
| node_detail_ab_test | scripts/node-detail-ab-test.js | schema 与 text 双路径 | ✅ 完成 | ✅ 完成 [0.8.2] |
| node_detail_large_result | scripts/node-detail-large-result-test.js | 大结果截断 | ✅ 完成 | ✅ 完成 [0.8.2] |
| node_detail_parallel_labels | scripts/node-detail-parallel-labels-test.js | 20 并行同 label | ✅ 完成 | ⛔ 未跑成（GLM 5h 滚动配额三轮全撞，无 journal） |
| node_detail_nav_test | scripts/node-detail-nav-test.js | 导航 marker（schema） | ✅ 完成 | ⛔ 未跑成（GLM 5h 滚动配额三轮全撞，无 journal） |
| node_detail_running_click | scripts/node-detail-running-click-test.js | 运行中节点 | ✅ 完成 | ✅ 完成 [0.8.2] |
| node_detail_retry / failed / out_of_order | （见 D 类） | | | |

### I. 性能基准（1）
| flow id | 文件 | 验证点 | 预期 | 实测 |
|---|---|---|---|---|
| fff_search_benchmark | workflows/fff-search-benchmark.js | 单 agent 连续 20 次 glob/grep | ✅ 完成（A/B 对照由外层脚本管，此处只验跑通） | ✅ 完成 [0.8.1] |

## 已知不兼容（v2 有意为之，非遗漏）

1. **chain 家族的工具嵌套形态**：v1 让子 agent 调 workflow 工具（scriptPath
   参数）实现嵌套。v2 工具无 scriptPath，且按设计**拒绝 run 内会话的工具
   调用**（防信号量自饿死；P2 决策）——嵌套请用 `workflow()` 全局（→
   ctx.subflow）。chain_root/middle 的内层调用会被拒绝，外层 flow 仍完成。
2. **resume 语义**：v1 按静态调用序前缀跳过；v2 legacy = 整体重跑
   （动态步骤无前缀概念）。
3. **phase 分组**：v1 TUI 按阶段分组显示；v2 面板步骤行 = 叶子调用
   （phase 进日志与事件）——批次 C（0.9.0）补全屏视图。
4. **setConcurrency / agentType / tier**：响亮警告后降级（并发由 executor
   统一管；无调用级 agent 类型与 tier 路由）。

## 运行记录

- 2026-10-09～10：62 flow 全量实机跑批（glm-5.3-flash）。**52 有终态证据**：
  46 符合预期（含 9 个设计性失败全部对位）+ 2 个 0.8.2 修复实证
  （composite_seq_fail、composite_par_fail——步骤级：子流失败→塌缩→run completed）
  + 4 已知分歧（chain 家族×3、out_of_order）；mutate_parent / composite_fb_child
  保留 0.8.1 缺口旧证（0.8.2 复验被中断，缺口行为在单测 378 例已覆盖）；
  10 个因 GLM 5h 滚动配额三轮全撞未跑成（⛔ 行）。跑批运维坑：配额误写
  .done、杀批留僵尸 run 占并发槽（须重启 service 清理）——见经验库。
