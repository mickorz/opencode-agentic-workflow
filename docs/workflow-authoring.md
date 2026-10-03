# Workflow Authoring Best Practices

> 写给要编写或修改 `WorkflowDefinition` 的人。
> 规则全部来自真实事故（titlecase 旗舰首跑五连坑，见
> `dev-docs/experience/titlecase-feature-run五连坑.md`）与内置 workflow 的实践。
>
> ⚠️ 当前限制：npm 包只导出插件入口，自定义 workflow 尚无装载机制
> （Backlog：见 `dev-docs/planning/P3-candidates.md`）。本指南现阶段适用于
> 本仓库贡献者；SDK 化后适用于所有 author。

## 通用结构纪律

1. **步骤状态用累积链**：每步返回 `{ ...prev, 新字段 }`——resume 跳过 completed
   步骤后，后续步骤与最终报告能从 journal 完整重建（参考 `reliable` / `feature-development`）。
2. **stepNames 是版本契约**：增删/重排步骤必须升 `version`；resume 依赖精确版本解析。
3. **state 必须 JSON 可序列化**：journal 逐步落盘 state，函数/循环引用会断链。
4. **子 agent prompt 必须禁止递归**：写明「禁止调用 workflow / workflow_metrics 工具」，
   否则嵌套调用 + 并发信号量 = 自饿死（既有事故）。
5. **工具/enum 失败必须原样失败**：workflow 描述里写清「未知 flow 直接报错」，
   防止主 agent 擅自降级替代（五连坑前置坑 0：请求 feature-development 被换成 reliable 跑完）。

## 检查者不得污染被检现场

**规则**：check 命令的副作用必须在「固化」之前清理。

- check 默认会跑 `npm install`（worktree 无 node_modules）→ 可能重写
  `package-lock.json` 等锁文件 → 这类噪声**不属于交付物**
- 固化 commit 前恢复锁文件（`feature-development` v1.1.0 的做法），并留
  `keepLockfileChanges` 类逃生门给「需求本身改依赖」的场景
- 固化提交范围最小化：能用显式路径清单（implement agent 的输出本就带变更
  文件清单）就不要 `git add -A` 全量扫入
- 固化命令要幂等：`git add -A && (git diff --cached --quiet || git commit ...)`——
  check 步骤崩溃后 resume 重跑不会卡在 "nothing to commit"

## 评审输入要「重要优先」

**规则**：verify 的 artifact 组装必须有排序/折叠策略，截断不能把核心内容挤出窗口。

事故：365 行 lockfile 排在 diff 前部，`MAX_DIFF_CHARS` 截断恰好切掉了排在末尾的
真正实现文件——reviewer 根本没看到代码，只能拒绝。

- 源码/测试文件放前，lockfile/生成物折叠为一行统计
- 截断提示要写明「已截断」，不要静默

## 派生字段不要跨步骤缓存

**规则**：能从现场现算的数据（diffStat、commitSha、HEAD 状态），在使用点同源现算，
不要引用上一步 journal 里的快照。

事故：外部 amend 修正 commit 后 resume，verify 的 diff 是现算的（干净），
`diffStat` 却还是 journal 里的旧值（含 lockfile +365）——两者矛盾，reviewer
合理拒绝；报告还指向已不存在的 commit。

journal 只存「步骤产出」，不存「下游还能再算的东西」。

## 交付物与审批解耦

**规则**：实现完成即固化为可取回的产物（分支 commit）；人工门失败不得埋葬已完成的工作。

- checkpoint 只是「是否接受」，不是「是否保留」——报告必须给出取回路径
  （分支名 / commit sha / cherry-pick 命令）
- run 失败 ≠ 产物消失：worktree 按策略清理，**分支保留**是交付语义的一部分

## resume 的输入契约是 journal 快照

**规则**：resume 不会感知 worktree/git 的外部修正。任何绕过 workflow 的救火
（amend、手改文件）都要同步校正 journal 对应步骤的 output/input，否则下游步骤
吃到的还是旧世界。

推论：workflow 作者应尽量让步骤「自愈」——衍生数据现算（上一条）、命令幂等、
状态可重建——把外部手术的需求压到最低。

## 待 Runtime 层解决的（不在 author 掌控内，已入 Watching）

- reviewer 非法 JSON 输出无单点重试（verify 原语层）
- checkpoint 外部审批注入通道（headless/对话场景）
- journal / 外部变更一致性的系统解法

## 检查清单（新 workflow 合入前过一遍）

```text
[ ] 步骤状态累积链 + JSON 可序列化
[ ] stepNames/version 纪律（结构变更已升版）
[ ] 子 agent prompt 已禁止递归调用工具
[ ] check 命令副作用已清理（lockfile 等），固化幂等
[ ] verify artifact 有重要优先排序 + 截断可见提示
[ ] 衍生字段（sha/diffStat 等）使用点现算
[ ] 失败路径上产物可取回（分支/commit 已固化）
[ ] 单测覆盖：全链成功 / 关键失败路径 / 幂等重跑
```
