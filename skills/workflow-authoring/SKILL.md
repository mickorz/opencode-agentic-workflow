---
name: workflow-authoring
description: >
  编写与自定义 opencode-agentic-workflow 代码流程（JS 模块）时加载。当用户想
  定义/创建一个 workflow、把某个重复流程自动化、给现有流程加步骤或参数、
  或遇到流程装载报错与版本冲突时使用。覆盖：需求澄清、flows 目录 JS 模块
  编写、装载注册、workflow 工具试跑验证的完整链路。
---

# workflow-authoring（代码流程编写）

把用户的流程需求变成可复用的代码 workflow：**对话澄清 → 写 flows 目录
JS 模块 → 保存即用（未知 id 自动重扫注册）→ `workflow` 工具试跑**。

> v0.6.0 起声明式 JSON 流程已移除（`workflow_define` 工具同步下线），
> 自定义流程只有代码形态。历史 JSON 用 `@mickorz/opencode-agentic-workflow/core`
> API 改写（文末有映射表）。

## 第一步：澄清需求（缺什么问什么，别猜）

1. **目的**：这个流程产出什么？（文档/代码/评审结论/检查报告）
2. **步骤**：大致几步、每步谁做（子 agent / 人工审批 / 语义评审 / 文件断言）
3. **参数**：除了主题 topic，还要哪些输入？（受众、语言、深度、评审标准…）
4. **完成标准**：最后一步之后怎么判断成功？

## 第二步：写 JS 模块（flows 目录）

**动笔要快**：位置就是项目根下 `flows/`（缺省自动装载），或
`opencode.json` 插件 options 里 `workflows: ["<路径>"]` 显式指定的位置——
**不需要探测插件装在哪、npm 全局有什么**（探索超过两步还没开始写文件，
路线就错了）。扩展名 `.mjs` 推荐（`.js`/`.cjs` 也支持；引用核心 API 的
`.cjs` 会明确报错）。

```js
// flows/release-notes.mjs
import {
  defineWorkflow, agent, checkpoint, verify, assert, fileExists,
} from "@mickorz/opencode-agentic-workflow/core"

export default defineWorkflow({
  id: "release-notes",
  version: "1.0.0",
  description: "一句话说明（进工具清单，给未来的你/agent 看）",
  argsSchema: {
    type: "object",
    properties: {
      topic: { type: "string", description: "主题" },
      audience: { type: "string", description: "受众" },
    },
    required: ["topic"],
  },
  stepNames: ["draft", "review", "gate"],   // 静态声明：journal/resume 依赖步骤序号稳定
  async run(args, ctx) {
    const state = await ctx.runSteps([     // runSteps = journal 记录 + resume 前缀跳过的统一入口
      async () => ({
        draft: (await agent(
          `针对 ${args.topic} 为 ${args.audience ?? "团队"} 写初稿…` +
          "。禁止调用 workflow / workflow_metrics 工具。完成后只回复 done。",
          { model: "glm/glm-5.3-flash", timeoutMs: 300000, retries: 1 },
        )).output,
      }),
      async () => ({ review: (await verify(args.topic, { criteria: "要点完整且有结论", reviewers: 2 })).passed ? "ok" : "ng" }),
      async () => { await checkpoint(`「${args.topic}」初稿已生成，批准？`) },
    ])
    return { output: `定稿：${state.draft}` }
  },
})
```

**核心 API**（全部从 `@mickorz/opencode-agentic-workflow/core` 导入；
装载器会自动把该裸说明符重写为本插件实例——用户目录无需 npm 安装本包）：

- `agent(prompt, opts?)` → `{ output, structured? }`；opts：`model`
  （"providerID/modelId"）/ `timeoutMs` / `retries` / `retryDelayMs` /
  `schema`（JSON-Schema 结构化输出）
- `checkpoint(message)`：人工审批门——拒绝即抛错中断；headless 传
  `checkpointMode: "auto-approve"`
- `verify(artifact, { criteria?, reviewers?, passThreshold?, lenses? })` →
  `{ passed, verdicts }`：语义评审；lenses = 多视角各一票
- `assert(() => fileExists("out.md"), "out.md")`：确定性断言（另有
  `commandSuccess` / `isFile` / `isDirectory`）
- 组合子：`pipeline`（条目并发 fan-out）/ `race`（竞速首胜）/ `parallel` /
  `sequence` / `fallback` / `retry` / `phase`
- `ctx.runSteps([...])`：编排入口——每个元素一个步骤函数，返回的部分
  state 会累积合并；journal 记录 + resume 跳过已完成前缀都由它管

**必守纪律（违反 = 事故）**：

1. 每个 `agent` prompt **必须以「禁止调用 workflow / workflow_metrics 工具」
   收尾**——子 agent 递归调工作流会自饿死并发信号量
2. `args` 里用到的参数都要在 `argsSchema.properties` 声明；`topic` 恒有
   （工具自动传）
3. 改动已注册流程的步骤结构（stepNames 数量/顺序/语义）= **必须升
   version**（1.0.0 → 1.1.0）；旧 journal 的 resume 依赖精确版本解析
4. `id` 不得用内置名：smoke / reliable / artifact / feature-development
5. 模块只能用 ESM 语法导出（`export default` 或 `export const definition`）；
   `.mjs` 里**不能有 TypeScript 注解**
6. **模块顶层只放 import / 常量 / 函数 / 导出**——不要在顶层跑数据处理
   （建索引、初始化表等）。顶层的立即执行代码在文件后部常量初始化之前
   运行会触发 TDZ 报错（`Cannot access 'X' before initialization`）；
   索引/缓存一律放函数里惰性构建
7. **不要探索插件安装位置 / npm 全局目录**——flows 模块运行在插件进程
   内：Node 内置模块（node:fs 等）可用，**用户目录与全局的 npm 包
   require/import 不到**（解析链上没有）。本地确定性计算需要数据
   （拼音表/映射表/词表）时，**把数据直接内嵌进 .mjs 文件**（大表放
   文件底部，配惰性索引）；库能力做不到的部分交给 `agent` 步

## 第三步：即时试跑（无需重启）

保存文件后**直接调用 `workflow` 工具**——未知 flow id 会触发一次 flows
目录增量重扫，刚写的模块当场注册运行（v0.6.1 起；v1「定义即注册」的
代码形态对位）：

- 成功：工具正常执行，输出带 `[<id>@<version> runId=…]`
- `workflow not found` 且附 `flows load errors` 清单：文件写了但没注册
  上——按指名的错误修文件再试
- **边界（如实）**：只有**新文件**能被重扫拾取；**改动已装载文件**
  （含升 version）需重启生效（Node ESM 缓存按路径，重导返回旧模块）。
  编辑既有流程后用 resumeRunId 前先重启

## 第四步：试跑验证

调用 `workflow` 工具：`flow=<id>, topic=<真实小主题>, checkpointMode=auto-approve`
（headless 必传）。关注：

- 步骤是否全 completed；失败步的报错（参数缺失/文件路径/评审否决）
- 产物是否落盘、内容是否符合预期
- 有 `background: true` 需求时用 `workflow_control status` 轮询

试跑通过后向用户报告：流程 id、参数用法（含 args 清单）、一句话示例。

## JSON → JS 迁移映射

| 旧 JSON 步骤 | 代码写法 |
|------|------|
| `{ agent: "提示 {{topic}}" }` | `agent(\`提示 ${args.topic}\`)` |
| `{ checkpoint: "批准？" }` | `await checkpoint("批准？")` |
| `{ verify: { artifact, criteria } }` | `await verify(artifact, { criteria })` |
| `{ fileExists: "out.md" }` | `await assert(() => fileExists("out.md"), "out.md")` |
| `{ pipeline: "模板 {{item}}", items }` | `await pipeline(items, [async (item) => (await agent(\`模板 ${item}\`)).output])` |
| `{ race: ["A", "B"] }` | `race([() => agent("A"), () => agent("B")])` |
| `"output": "{{steps.draft}}"` | run 末尾 `return { output: state.draft }` |

## 常见报错速查

| 报错 | 原因与修法 |
|------|-----------|
| `failed to import (...Cannot find package...)` | 模块导入了用户目录解析不到的包；只用 `@mickorz/opencode-agentic-workflow/core` 与 Node 内置模块，数据需求内嵌文件 |
| `Cannot access 'X' before initialization` | 顶层立即执行代码跑在文件后部常量之前（TDZ）——索引/初始化移进函数惰性构建 |
| `imports ".../core" but .cjs cannot be specifier-rewritten` | `.cjs` 引用核心 API——改名 `.mjs` |
| `module must export a workflow` | 缺 `export default defineWorkflow({...})` |
| `workflow.run must be a function` | 定义缺 `async run(args, ctx)` |
| `JSON workflows were removed in v0.6.0` | flows 目录里还有 .json——按上面映射表改写成 JS |
| `workflow not found` + `flows load errors` 清单 | 文件没注册上：按指名错误修文件（语法/形状/保留 id/解析失败）直接重试，无需重启 |
| 改了已注册流程但不生效 | 已装载文件的修改（含升 version）需重启；新文件才能被重扫即时拾取 |
| `id "..." is reserved by a built-in` | 换个 id |
| `duplicate <id>@<version>` | 同版本已从别的文件装载——删一处或升 version |
| verify 返回 `passed: false` | 评审语义否决——改产物质量或放宽 criteria，不是 bug |
