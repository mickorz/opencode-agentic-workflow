# opencode-agentic-workflow

Agentic workflow engine for OpenCode V2.

架构分层：

```text
Workflow Core (agent / parallel / sequence / phase)
        |
  AgentExecutor (抽象接口)
        |
  OpenCodeV2Executor (唯一允许触碰 OpenCode API 的位置)
        |
  ctx.session (OpenCode V2 Plugin Context)
```

## 状态

P0（v0.1.0）：在 OpenCode V2 上执行最基本的 multi-agent workflow。

## 开发

```bash
npm install
npm run build        # tsc 构建
npm run typecheck    # 类型检查
npm test             # node:test + tsx
```

开发过程文档见 `dev-docs/`。
