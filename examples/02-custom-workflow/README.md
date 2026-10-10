# 02 · Custom Workflow —— 15 分钟写出你自己的流程

> 这个示例里**没有一个内置流程**：`flows/digest.js` 是一个 20 行的 v1 js 脚本，
> 插件启动时读它、注册它——你的流程与内置流程享受完全相同的
> journal / trace / resume / 审批覆盖机制。
>
> **v0.9.0 起流程唯一形态 = v1 js 脚本**（`export const meta` + 魔法全局 +
> 顶层 return）。`.mjs` / `.cjs` / defineWorkflow 模块 / JSON 放进 flows 会
> fail-loud 并给出改写指引。

## 演示什么

- **脚本装载**：`opencode.json` 里的 `"workflows": ["flows"]` 指向流程目录
- **步骤原语**：`agent`（子 agent 写文件）→ `check(() => fileExists(...))`
  （存在性断言）→ `checkpoint`（审批门）——`digest.js` 三步走完
- **零 import**：`phase / agent / check / fileExists / checkpoint / args` 都是
  魔法全局，脚本里不写任何 import
- **顶层 return**：返回值即 run 结果（约定带 `output` 文本字段）

## 运行

在本目录：

```bash
# 方式一：交互 TUI（checkpoint 弹窗审批走交互确认）
opencode

# 方式二：headless 一句话
opencode run --model glm/glm-5.3-flash \
  "调用 workflow 工具：flow=digest, topic=任选一个主题, checkpointMode=auto-approve（这个参数必须传）"
```

## 会看到什么

| 证据 | 位置 | 预期 |
|---|---|---|
| 产物 | `digest.md` | 真实生成在你眼前（本目录，非临时目录） |
| journal | `.agw/journal/<runId>.json` | `completed`，steps 含 draft / check / gate |
| 审批 | `.agw/trace/events.jsonl` | `checkpoint.completed … approved: true` |

## 改造练习（10 分钟）

1. 给 `draft` 后面加一步语义评审：`await verify(digest.md 的内容, "要点围绕主题且无空章节")`
2. 自定义参数：`args` 是工具调用时传入的对象，prompt 里直接 `${args.audience}` 拼接
   （调用时传 `args={"audience":"…"}`）
3. 组合既有流程：`const note = await workflow('./other-flow.js', { topic: args.topic })`
   ——subflow 一行搞定（参考 `dev-examples/local-dev/flows/sentence-demo.js`）
4. 并行与容错：`parallel([...])` / `fallback([...])` / `retry(fn, 3)` 都是全局函数

完整 API 与形态规范：随包分发的 `skills/workflow-authoring/SKILL.md`。

## 失败怎么办

- 流程文件写错：启动日志有 `custom workflow file skipped: <原因>`，
  其余流程不受影响，改好文件重启 OpenCode 即可
- `.mjs` / JSON 放进 flows：装载错误信息自带改写指引（v0.9.0 移除形态）
- 其他排查见 [`docs/troubleshooting.md`](../../docs/troubleshooting.md)
