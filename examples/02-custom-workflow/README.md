# 02 · Custom Workflow —— 15 分钟写出你自己的流程

> 这个示例里**没有一个内置流程**：`flows/digest.json` 是一个 40 行的声明式
> JSON 文件，插件启动时读它、注册它——你的流程与内置流程享受完全相同的
> journal / trace / resume / 审批覆盖机制。
>
> 需要插件 **≥ 0.5.0**（发布中；发布前可把 opencode.json 里的 package 换成
> 相对路径 `../../dist/plugin`，并在仓库根 `npm install && npm run build`）。

## 演示什么

- **声明式装载**：`opencode.json` 里的 `"workflows": ["flows"]` 指向流程目录
- **步骤三原语**：`agent`（子 agent 写文件）→ `fileExists`（存在性断言）→
  `checkpoint`（审批门，模板里引用了 `{{topic}}`）
- **模板系统**：`{{topic}}` / `{{args.x}}` / `{{steps.<name>}}`

## 运行

在本目录：

```bash
# 方式一：交互 TUI（把 checkpoint.mode 改成 "interactive" 可体验弹窗审批）
opencode

# 方式二：headless 一句话
opencode run --model glm/glm-5.3-flash \
  "调用 workflow 工具：flow=digest, topic=任选一个主题, checkpointMode=auto-approve（这个参数必须传）"
```

## 会看到什么

| 证据 | 位置 | 预期 |
|---|---|---|
| 产物 | `digest.md` | 真实生成在你眼前（本目录，非临时目录） |
| journal | `.agw/journal/<runId>.json` | `completed`，steps = `draft → file → gate`，**步名就是 JSON 里的 name** |
| 审批 | `.agw/trace/events.jsonl` | `checkpoint.completed … approved: true` |

## 改造练习（10 分钟）

1. 给 `draft` 后面加一步语义评审：
   `{ "name": "review", "verify": { "artifact": "{{steps.draft}}", "criteria": "要点围绕主题且无空章节" } }`
2. 自定义参数：加 `"args": { "type": "object", "properties": { "topic": {...}, "audience": {...} }, "required": ["topic"] }`，
   prompt 里用 `{{args.audience}}`
3. 升级契约：增删/重排步骤后把 `version` 升到 1.1.0（resume 依赖精确版本）

格式完整参考：[`docs/workflow-authoring.md`](../../docs/workflow-authoring.md) 的
「零代码自定义 workflow」章。

## 失败怎么办

- 流程文件写错（键名/结构）：启动日志有 `custom workflow file skipped: <原因>`，
  其余流程不受影响，改好文件重启 OpenCode 即可
- 模板变量拼错：对应步骤 failed，journal 的报错会指名 `{{xxx}}` 与可用变量
- 其他排查见 [`docs/troubleshooting.md`](../../docs/troubleshooting.md)
