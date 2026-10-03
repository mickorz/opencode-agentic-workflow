# titlecase 旗舰首跑五连坑（feature-development TUI 实战）

**日期**：2026-10-04 ｜ **阶段**：v0.3.x Adoption（examples/01 手动验收）
**载体**：`examples/01-coding-reliable` ｜ 三次 run：`htn39z0s` / `0pnf8bzb` / `cp2tz6hy`
**取证**：journal ×3 + 保留 worktree ×2 + 分支 diff——全部为文件级一手证据

## 全景

```text
Run1 htn39z0s  reliable@1.0.0     坑1→坑2：被降级成 reliable，checkpoint 5 分钟无应答超时拒绝
Run2 0pnf8bzb  feature-dev@1.0.0  坑3：365 行 package-lock 噪声进 diff，reviewer 正确驳回
Run3 cp2tz6hy  feature-dev@1.0.0  坑5 中跑通全链，唯 checkpoint 再超时（坑2 复现）；交付物已落分支
全程          坑4：失败 run 不清理，3 worktree + 3 挂牌分支堆积
```

---

## 坑 1：npm 包名缓存 → 旗舰不在 enum，主 agent 擅自降级跑 reliable

- **现象**：`flow=feature-development` 报 `Expected "smoke" | "reliable" | "artifact"`；
  主 agent 自行决定「改用 reliable 执行」并跑完——**任务被静默替换**。
- **根因**：npm 包名形式插件按 registry 0.3.0 经 OpenCode 自身缓存解析
  （详见 `opencode插件npm包名解析走自身缓存.md`，摩擦点 M3）。
- **放大器**：主 agent 的「贴心降级」把配置错误变成了错误的执行——跑了不该跑的
  链路还烧了 token，用户若不注意就接受了错误结果。
- **解法/预防**：已修（相对路径引用）；**教训：工具枚举拒绝时应原样失败，
  不得由主 agent 擅自替代**——workflow 工具描述已含「Do NOT call from inside」
  类约束，但「enum 失败禁止降级」还没有约束，考虑在工具描述加一句。

## 坑 2：interactive checkpoint 无 TUI 应答 → 挂 5 分钟才安全失败（两次）

- **现象**：Run1 与 Run3 均死于
  `checkpoint rejected: ... (no interactive reply within 300000ms (no TUI attached?))`。
- **机制**：InteractiveCheckpointGate 超时 onTimeout=reject（设计上的安全失败），
  但代价是**每次 5 分钟死寂**，且用户不知道它在等谁。
- **待确认**：TUI 侧审批框到底弹没弹过？（若从未弹 → TUI 侧 `./tui` 入口在
  相对路径插件形态下是否被 TUI 宿主加载，是新的未知数；若弹了没看见 → 纯 UX。）
- **解法/预防**：短期 examples 改 auto-approve 跑通为先；交互门配更短超时
  （`checkpoint.timeoutMs`）；根治 = 进度可视化（Watching 第 3 条），让
  「正在等你审批」可见。

## 坑 3：check 的 npm install 重写 package-lock.json，`git add -A` 把 365 行噪声扫进交付 diff

- **现象**：Run2 verify 被驳回，reviewer 原话「diff 混入了大量与需求无关的内容」；
  实际交付物本身（titlecase.ts +11 / 单测 +33）完全合格。
- **证据**：`git show --stat` —— `package-lock.json | 365 ++++---`，
  与交付物同一 commit `9905e43`。
- **根因链**：worktree 无 node_modules → check 默认命令跑 `npm install` →
  本机 npm 与 lockfile 版本差异触发重写 → 固化步骤 `git add -A` 无差别扫入。
  Run3 未复现（install 未改写 lock）——**噪声是否出现不确定**，危害更甚。
- **解法方向**（待落）：固化前恢复锁文件噪声
  （`git restore -- package-lock.json`），并以 args 开关
  `keepLockfileChanges` 保留真实依赖变更；或默认命令换 `npm ci`（不重写 lock，
  但要求 lock 存在且同步）。
- **教训**：**「确定性检查」自身的副作用必须被清理**——check 不只是验证者，
  它会污染它所检验的工作区。

## 坑 4：失败 run 不清理 worktree——三连败后 3 目录 + 3 挂牌分支堆积

- **现象**：`<repo>-worktrees/` 下 3 个残留 worktree；`git branch` 中 3 个
  `agw/*` 带 `+`（仍被 worktree 占用，直接 `git branch -D` 会失败）。
- **根因**：CleanupPolicy 默认 on-success 是**设计决策**（失败现场保留取证 +
  可 resume 重附着），不是 bug——但没有任何提示与回收路径，用户只看到「垃圾堆积」。
- **解法方向**：resume 成功后按策略补清理（现有能力可达）；或提供清理命令/文档
  （`git worktree remove <dir> && git branch -D agw/<runId>`）。
  与 Watching「取消 workflow」同族（运行生命周期管理缺口）。

## 坑 5：全程黑盒——链路机械上全部跑通，体验上一次都没「看着跑过」

- **现象**：Run3 实际完成了 analyze→implement→check（真跑 npm test）→verify
  （2 reviewer 通过）——**机械链路是通的**；但 TUI 只有一个不透明的工具块，
  5+ 分钟无任何进度反馈，checkpoint 又是 5 分钟死寂，用户全程只能干等或来问。
- **根因**：TUI 进度渲染未开发（Watching 第 3 条，本坑为其补了实证）。
- **教训**：**可观测性落盘 ≠ 可观测性可见**——trace/metrics/journal 都在写，
  但运行中没有一条通路到达用户眼前；对 Adoption 而言，「看得见」先于「更强」。

## 意外收获：交付物其实已经成功

Run3 分支 `agw/run_1791048661145_cp2tz6hy`（commit `a6f9b11`）上躺着一份
**干净的已验证实现**：titlecase.ts（+17）+ 单测（+32），check 与 verify 双通过。
唯一失败的是人工门超时。取回方式：

```bash
git cherry-pick a6f9b11   # 或 merge 该分支
```

——旗舰 workflow 的第一次真实交付，死于「没人开门」，不是「没造出来」。

## 五坑共同心法

1. **插件环境假设三兄弟**（缓存/版本/解析基准）每次配置变更都要重验证（坑 1）
2. **等待必须有边界和可见性**：5 分钟静默超时是安全阀，不是交互设计（坑 2/5）
3. **检查者不能污染被检现场**（坑 3）
4. **失败语义要配套清理语义**：保留现场取证 ≠ 无限期堆积（坑 4）
5. **交付物与审批解耦**：实现完成应可取回，人工门失败不应埋葬已完成的工作（坑 2 尾注）
