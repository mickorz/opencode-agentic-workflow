# feature-dev-e2e —— 招牌 workflow 无人值守联调

feature-development 的 headless e2e 沙盒（checkpoint=auto-approve，
可用 `opencode run` 直接跑，无 TUI 依赖）。

```bash
cd dev-examples/feature-dev-e2e
npm install        # file:../.. -> symlink 到仓库 dist；重 build 即生效
opencode run --model glm/glm-5.3-flash "调用 workflow 工具：flow=feature-development, topic=<需求>"
```

验证点：

- `.agw/journal/`：5 步（analyze/implement/check/verify/checkpoint）completed
- 仓库同级 `<repo>-worktrees/<runId>/`：实现所在 worktree
  （on-success cleanup 后消失，分支 `agw/<runId>` 保留）
- 分支上的 commit：`agentic-workflow(feature-development): <topic>`
- `.agw/trace/metrics.json`：agent 调用数与 token/cost 聚合

与 `examples/01-coding-reliable` 的差异：那边是 interactive 审批的读者体验位，
这边是 auto-approve 的自动化验证位。
