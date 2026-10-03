# Workflow Gallery

> 一组可运行示例，回答「opencode-agentic-workflow 到底能拿来干嘛」。
> 每个示例目录自带 `opencode.json`，`cd` 进去、装好依赖、重启 OpenCode 即可运行。

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

## 运行方式（以 01 为例）

```bash
cd examples/01-coding-reliable
npm install          # 首次；file: 链接是指向仓库根的 symlink，重新 build 即自动生效
# 重启 OpenCode（在本目录启动），插件自动加载
```

> 02+ 未落地前不要创建空目录占位——Gallery 条目随实际示例一起提交
> （纪律见 `dev-docs/planning/P3-candidates.md`：Gallery/Hub 不预设）。
