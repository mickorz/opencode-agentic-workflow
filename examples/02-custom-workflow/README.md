# 02 · Custom Workflow —— 15 分钟写出你自己的流程

> 这个示例里**没有一个内置流程**：`flows/digest.json` 是一个 40 行的声明式
> JSON 文件，插件启动时读它、注册它——你的流程与内置流程享受完全相同的
> journal / trace / resume / 审批覆盖机制。
>
> 需要插件 **≥ 0.5.0**（发布中；发布前可把 opencode.json 里的 package 换成
> 相对路径 `../../dist/plugin`，并在仓库根 `npm install && npm run build`）。

## 演示什么

- **声明式装载**：`opencode.json` 里的 `"workflows": ["flows"]` 指向流程目录
- **步骤原语**：`agent`（子 agent 写文件）→ `fileExists`（存在性断言）→
  `checkpoint`（审批门，模板里引用了 `{{topic}}`）；`digest.json` 三步走完
- **模板系统**：`{{topic}}` / `{{args.x}}` / `{{steps.<name>}}`
- **嵌套组合（`notes-duo.json`）**：`subflow` 步骤把另一个已注册流程
  `note.json` 当作步骤调用——**同一个子流程复用两次**（正题 + 复盘），
  子流程输出直接进 `{{steps.<name>}}` 模板

## 运行

在本目录：

```bash
# 方式一：交互 TUI（把 checkpoint.mode 改成 "interactive" 可体验弹窗审批）
opencode

# 方式二：headless 一句话
opencode run --model glm/glm-5.3-flash \
  "调用 workflow 工具：flow=digest, topic=任选一个主题, checkpointMode=auto-approve（这个参数必须传）"

# 嵌套版（subflow）
opencode run --model glm/glm-5.3-flash \
  "调用 workflow 工具：flow=notes-duo, topic=任选一个主题, checkpointMode=auto-approve"
```

## 会看到什么

| 证据 | 位置 | 预期 |
|---|---|---|
| 产物 | `digest.md` | 真实生成在你眼前（本目录，非临时目录） |
| journal | `.agw/journal/<runId>.json` | `completed`，steps = `draft → file → gate`，**步名就是 JSON 里的 name** |
| 审批 | `.agw/trace/events.jsonl` | `checkpoint.completed … approved: true` |

嵌套版（notes-duo）会多出**三份 journal**：一份父 run（steps =
`main → retro → gate`）+ 两份子 run——子 run 的 JSON 里有
`"parentRunId": "<父 runId>"` 与 `"depth": 1`（lineage），产物为
`note-main.md` + `note-retro.md` 两个文件。

## 改造练习（10 分钟）

1. 给 `draft` 后面加一步语义评审：
   `{ "name": "review", "verify": { "artifact": "{{steps.draft}}", "criteria": "要点围绕主题且无空章节" } }`
2. 自定义参数：加 `"args": { "type": "object", "properties": { "topic": {...}, "audience": {...} }, "required": ["topic"] }`，
   prompt 里用 `{{args.audience}}`（调用工具时传 `args={"audience":"…"}`——参数直达 prompt）
3. 把 `digest.json` 改成嵌套版：`{ "name": "draft", "subflow": "note", "args": { "topic": "{{topic}}", "file": "digest.md" } }`
   ——组合既有流程，一行都不用写 prompt
4. 升级契约：增删/重排步骤后把 `version` 升到 1.1.0（resume 依赖精确版本）

## 进阶：一个字都不用手写

直接在对话里说「帮我定义一个 workflow：……」，主 agent 会调用
`workflow_define` 工具把需求变成合规 JSON——**校验 → 立即注册 → 落盘**
到 `flows/`，当场可运行，之后每次启动自动装载。试试：

> 帮我定义一个 workflow：id 为 compare，先让 agent 针对 {{topic}} 写对比分析存成
> compare.md（记得加禁止递归那句），再断言文件存在。然后跑一下 topic=React vs Vue。

格式完整参考：[`docs/workflow-authoring.md`](../../docs/workflow-authoring.md) 的
「零代码自定义 workflow」章。

## 失败怎么办

- 流程文件写错（键名/结构）：启动日志有 `custom workflow file skipped: <原因>`，
  其余流程不受影响，改好文件重启 OpenCode 即可
- 模板变量拼错：对应步骤 failed，journal 的报错会指名 `{{xxx}}` 与可用变量
- 其他排查见 [`docs/troubleshooting.md`](../../docs/troubleshooting.md)
