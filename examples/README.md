# Workflow Gallery

> 一组**面向读者**的可运行示例，回答「opencode-agentic-workflow 到底能拿来干嘛」。
> 每个示例目录自带 `opencode.json`，装好依赖、在本目录启动 OpenCode 即可运行。

## 学习路线

```text
先理解：为什么 workflow 比单 Agent 可靠        -> 01
再理解：为什么 workflow 可以组织多个 Agent      -> 02（规划中）
最后理解：为什么它能用于生产环境               -> 03+（规划中）
```

## 示例索引

| # | 目录 | 演示内容 | 核心能力 |
|---|------|----------|----------|
| 01 | [coding-reliable](./01-coding-reliable/) ⭐ | 一句话需求 → 隔离 worktree 实现 → 测试验证 → reviewer 审查 → 人工审批 → 分支交付 | 全家桶：reliability 语义 + worktree 隔离 + durable journal |
| 02 | multi-agent-feature-design（规划） | 需求分析后多路并行（客户端/服务端/UI…）再汇总 | parallel 编排与上下文隔离 |
| 03 | crash-resume（规划） | 长链路中途杀进程，精确恢复续跑 | journal + resume |
| 04 | human-checkpoint（规划） | 深度交互审批/驳回/改写循环 | interactive checkpoint |
| 05 | observability（规划） | metrics/trace 查询与成本核算 | observability |

## 示例规范（examples/ 目录约定）

> 本目录是**读者第一接触面**：每个条目都必须能独立跑通、自解释。
> 开发中的试验品放 `dev-examples/`，不要放这里（见根目录 CLAUDE.md）。

1. **命名**：`NN-slug/`——两位序号 + kebab-case 主题（如 `01-coding-reliable/`）。
   序号即学习路线顺序，新建示例递增分配，不复用已删条目的序号。
2. **每个示例必备文件**：

   | 文件 | 必要性 | 说明 |
   |------|--------|------|
   | `README.md` | 必须 | 演示什么、怎么运行、会看到什么、证据落在哪里、失败怎么办 |
   | `opencode.json` | 必须 | 可直接运行的插件配置；读者只改 model/prices 即可跑 |
   | `package.json` | 视需 | 有 npm 依赖时提供；插件用 `file:../..` symlink 到仓库 dist |
   | `.gitignore` | 视需 | 忽略运行产物（journal/trace/node_modules/*.out） |

3. **准入门槛**：只收录**已合入 main 并注册进插件**的 workflow；
   不建空目录占位——条目随真实示例一起提交（纪律见 P3-candidates）。
4. **可运行性**：从全新 clone 出发可跑通（需要先在仓库根执行
   `npm install && npm run build` 生成 dist；npm 发布新版后可切换为包名引用）。
5. **索引同步**：新增/变更示例必须同步更新上面的索引表（含核心能力列）。
6. **语言与路径**：面向读者的表述；不出现本机绝对路径与开发期临时配置。
