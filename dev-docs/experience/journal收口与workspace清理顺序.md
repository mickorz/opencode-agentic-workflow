# journal 收口与 workspace 清理的顺序纪律（+ 跨仓库 dispose）

日期：2026-10-03 ｜ 关联：P2.7 Worktree Isolation（Commit 19）

## 坑 1：清理顺序错误会让「已删除的 worktree 身份」复活

### 现象

durable resume 的收尾要求：成功 run 清理 worktree 后，journal 里的
`workspace` 字段必须清掉——否则该 run 的**幂等 resume** 会试图 attach
一个已删除的目录。

最初实现把清理放在 `journal.complete()` **之前**：

```text
def.run 完成
→ cleanupWorkspace（dispose + 经 RunJournal.attach 清掉持久化的 workspace 字段）
→ journal.complete()          ← 内存里的 journal 实例 workspace 字段还在！
                                saveRun 时把已删除的身份复活写回
```

`RunJournal` 是包装内存对象的记录器：`cleanupWorkspace` 内部 `attach`
的是**新读出的另一份实例**，清的是那份；而 start 流程持有的原实例随后
`complete()` 再次全量落盘——被清除的字段原地复活。e2e 一旦走到
「成功清理后再 resume」就会报 workspace missing。

### 纪律（修复后的顺序）

**journal 先收口，workspace 清理永远最后做。**

```text
成功：def.run → journal.complete()/settle → cleanupWorkspace
失败：journal.fail()/settleAfterFailure → cleanupWorkspace(仅 always 策略)
```

配套改动：`clearWorkspace()` 定位为**维护性操作，允许在 run 收口后执行**
（不 `assertOpen`）——与 `setWorkspace()`（收口前记录）分开。

### 一般化

凡是「journal 记录 + 外部资源生命周期」的组合（workspace、锁、租约……）：
- 外部资源的**登记**在 journal 收口前（失败也要能找回资源去清理/取证）；
- 外部资源的**注销**在 journal 收口后（且注销必须走新 attach 的实例，
  不能信任任何持有旧内存快照的代码路径随后还会 saveRun）。

## 坑 2：跨目录 resume 时，provider 的 startDir 不是 worktree 所属仓库

### 现象

e2e 双目录模式：H1（创建 worktree，属于 H1 仓库）失败 → H2（**另一个
git 仓库**）resume。H2 的 `GitWorktreeProvider` 用 `startDir=H2` 解析出
的 repoRoot 是 H2 自己——`git -C H2 worktree remove <H1 的 worktree>`
直接报 not a working tree。

attach 不受影响（只做 fs.stat + 在 worktree 内部 rev-parse），坏的是
**成功后的清理**：dispose 抛错 → 被 cleanupWorkspace 吞掉只留日志 →
worktree 残留、journal 字段不清。

### 修复

**worktree 的归属从它自身解析，不从 provider 配置解析：**

```ts
const commonDir = await git(["rev-parse", "--git-common-dir"], root)
const repoRoot = path.dirname(path.resolve(root, commonDir))
```

`--git-common-dir` 在 linked worktree 里返回主仓库 .git 的绝对路径；
主 worktree 场景返回相对的 `.git`（resolve 后同样正确）。解析失败（目录
已不存在）视为已清理——幂等。

### 一般化

跨进程/跨目录 resume 时，**journal 里记录的 path 是唯一事实源**；
任何从「当前环境」推导的路径（cwd、startDir、配置）都可能与当初不一致。
资源操作要自包含（从资源自身定位归属），而不是依赖环境重推导。

## 验证方式

- 单测：跨仓库 dispose（repo A 创建、repo B 上下文 attach+dispose）；
  成功清理后 journal workspace === undefined；清理后幂等 resume 零副作用。
- 真实 e2e：H1 auto-reject 失败（worktree + artifact.md 保留）→ H2
  auto-approve resume（attach 原 worktree、文件存活、仅 checkpoint 重跑）
  → 成功清理（worktree 目录消失、journal 字段清空、分支保留）。
