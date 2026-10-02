# OpenCode V2 插件本地加载与 session API 要点

日期：2026-10-03 ｜ 环境：opencode v2.0.22、@opencode/plugin 2.0.22

## 问题现象

1. opencode.json 配 `"plugins": [{"package": "<绝对路径>/dist/plugin/index.js"}]`，插件不加载，日志报：
   `configured plugin path must be a directory`
2. 配置指向正确目录后 `opencode plugin list` 仍显示旧路径/不显示，误以为配置无效。
3. `session.prompt()` 拿不到 assistant 回复（V1 习惯：prompt 响应即最终消息）。

## 排查过程

- `~/.local/share/opencode/log/opencode.log` 里找到 WARN 确认「路径必须是目录」。
- 后台服务有配置缓存，`opencode service restart` 后才反映新配置。
- 读 @opencode/client 生成类型确认 V2 session API 契约。

## 根因

1. V2 `plugins[].package` 本地路径**必须是目录**（目录内含入口 js），不能直接指到 .js 文件。
2. `opencode plugin list` 读的是服务缓存的快照，配置变更需重启服务。
3. V2 `session.prompt()` 是 **inbox 异步投递模型**：返回 `SessionInboxUser`（用户消息入队），不含 assistant 内容。

## 解决方案

```jsonc
// opencode.json（目录路径）
{ "plugins": [{ "package": "/abs/path/dist/plugin", "options": { ... } }] }
```

或用 `.opencode/plugins/xxx.js` 自动发现（文件内 re-export 插件 default）。

取子会话结果的正确姿势（executor 内）：

```ts
await session.prompt({ sessionID, text })   // 投递
await session.wait({ sessionID })           // 等会话空闲
const messages = await session.context({ sessionID }) // 读消息
// 从后往前找 type === "assistant"，拼接 content 里 type === "text" 的 parts
```

## 预防/注意事项

- **CLI 的 `--model` 不会传导给 `session.create()` 创建的子会话**；子会话用默认 agent 的默认模型。要在 create 时显式传 `model: { providerID, id }` / `agent`。
- API 路由带 `/api` 前缀：`GET /api/session/{id}/context`（不带前缀会返回 Web UI HTML）。
- assistant 消息可能 `finish: "error"` 且 `content: []`（如限流），要检查 `message.error` 并带出错误信息。
- 插件 `ctx.options` 类型是 `Readonly<Record<string, any>>`，可用来传 model/agent/concurrency 配置。
