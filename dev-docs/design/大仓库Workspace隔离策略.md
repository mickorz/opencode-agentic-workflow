# 大仓库 Workspace 隔离策略（WorkspaceProvider 演进方向）

**日期**：2026-10-04 ｜ **状态**：P3 Backlog（**不改当前默认行为**）｜ 来源：架构评审
**关联**：`src/workspace/`（现有抽象）、`dev-docs/planning/P3-candidates.md`（Backlog 条目）

## 结论先行

1. 当前 `git-worktree` 默认**保持不变**——中小型 repo / coding workflow 下它是最安全的
2. `WorkspaceProvider` 抽象已把路留好：Core 不知道 Git，未来新增 Provider 无需改 Workflow Core
3. 大仓库策略是**真实需求出现后才启动**的 P3 候选，触发条件见文末

## 成本辨析：worktree 到底贵在哪

**Git worktree 不复制 `.git` 历史对象库**——多 worktree 共享同一 object database，
「仓库历史很大」通常不是问题。真正变重的是：

```text
checkout 出来的工作树文件本身
node_modules / Unity Library/ / Unreal Intermediate+DerivedDataCache
构建产物 / 大量二进制资源
每个 worktree 重复执行依赖安装（npm install / Unity import）
```

所以超大 Unity/游戏仓库下，`1 workflow = 1 full worktree` 确实可能很贵。

## 目标形态：按项目选择隔离策略

```text
Workflow
  ↓
WorkspaceProvider（现有抽象，Core 不感知实现）
  ↓
┌─────────────────────────┐
│ GitWorktreeProvider     │  现有
│ SparseWorktreeProvider  │  候选
│ SharedWorkspaceProvider │  候选
│ (off)                   │  候选
└─────────────────────────┘
```

### 模式 1：`worktree`（现状默认）

适合：中小 repo、coding workflow、需要真正文件隔离、agent 大量改代码。最安全。

### 模式 2：`sparse-worktree`

workflow 只涉及部分目录时（如 Unity 只碰 `Assets/Scripts/Login`、`Assets/Configs`、
`ProjectSettings`、`Packages`），不必 checkout `Assets/Art|Audio|Maps|Textures`。

```ts
isolation: {
  mode: "sparse-worktree",
  paths: ["Assets/Scripts", "Assets/Configs", "ProjectSettings", "Packages"]
}
```

底层 = `git worktree` + `git sparse-checkout`，保留独立 branch / cwd / 修改 /
resume / cleanup 全部语义，磁盘占用明显下降。**预计是大型项目最实用的方案。**

### 模式 3：`shared`（只读共享）

不修改文件的 workflow（需求分析 / 代码审查 / 项目检索 / 知识库构建 / PRD /
架构分析）根本不需要 worktree：

```ts
workspace: { mode: "shared", access: "read-only" }
```

研究/审查/分析类 agent 直接共享主仓库；进一步可演进为**步骤级策略**：

```text
Requirement Agent  → shared/read-only  ← 主仓库
Implementation     → isolated          ← worktree
```

比「整个 workflow 一个 worktree」更合理。

### 模式 4：`off`

私人项目 / CI 临时环境 / Docker 临时容器 / 用户自备 sandbox——再套 worktree
是多余开销。

## 缓存分离层（大型游戏仓库）

真正不能每个 worktree 复制/重新生成的是 `Library/`、`node_modules/`、
build cache。WorkspaceProvider 未来支持：

```ts
cache: { strategy: "shared" }
```

```text
                shared cache（依赖/模型/包/编译缓存）
                    │
         ┌──────────┼──────────┐
         ▼          ▼          ▼
     worktree A worktree B worktree C   ← Git 文件隔离
```

与 CI 系统的缓存分层同构：**Git 文件隔离，缓存共享。**

## Workspace Scope（比 worktree 更贵的是 agent 的扫描）

超大 repo 真正昂贵的往往是启动后的 `grep 全仓 / 生成 index / npm install /
Unity import / compile`。未来引入：

```ts
workspace: {
  scope: ["Assets/Scripts/Login", "Assets/Scripts/Common", "Assets/Configs/Login"]
}
```

一个 scope 同时影响：**sparse checkout、agent cwd、search scope、RAG scope、
file permission、observability**——与「降低 context / 降低 find-grep 成本」
是同一件事。

## 终态形态

```text
Workflow
   ↓
Workspace Policy（步骤级）
   ↓
┌─────────────────────────┐
│ analysis → shared RO    │
│ coding   → sparse tree  │
│ testing  → same tree    │
└─────────────────────────┘
             │
             ▼
        shared caches
```

比「每个 workflow 无脑 full worktree」成熟得多。

## Backlog 触发条件（真实需求出现才启动）

```text
1. worktree 创建/checkout 明显慢（真实用户反馈）
2. 单 run 磁盘占用过高
3. Unity / 大型 monorepo 项目实际采用
```

在触发之前：不重构、不改默认、不预写 Provider 空壳。
