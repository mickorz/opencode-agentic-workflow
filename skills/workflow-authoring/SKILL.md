---
name: workflow-authoring
description: >
  编写与自定义 opencode-agentic-workflow 代码流程（JS 模块）时加载。当用户想
  定义/创建一个 workflow、把某个重复流程自动化、给现有流程加步骤或参数、
  放入 v1（opencode-dynamic-workflows）时代的 .js 脚本、或遇到流程装载报错
  与版本冲突时使用。覆盖：需求澄清、flows 目录 JS 模块编写（含 v1 脚本
  legacy 直接装载）、装载注册、workflow 工具试跑验证的完整链路。
---

# workflow-authoring（代码流程编写）

把用户的流程需求变成可复用的代码 workflow：**对话澄清 → 写 flows 目录
JS 模块 → 保存即用（未知 id 自动重扫注册）→ 自己调 `workflow` 工具试跑
→ 汇报结果**。

## 零语法契约（本 skill 的服务边界）

**用户永远只说需求，不说工具语法。** `flow=` / `topic=` /
`checkpointMode=` 这些参数全部由你（agent）组织：

- 用户说「创建一个 workflow js：需求是 xxx」→ 你走完澄清、写文件、
  **立即自己调用 workflow 工具试跑**（topic 从需求里取一个小而真实的
  样例，checkpointMode 用 auto-approve）、把运行结果汇报给用户——
  一口气做完，中途不要把工具参数丢回给用户
- 用户以后想再跑：说人话即可（「用拼音口诀流程，词：知识库」/
  「再跑一次发布说明，主题换成 y」）——由你翻译成工具参数
- 需求已明确就别问；有真歧义才问，且一次问全

> v0.6.0 起声明式 JSON 流程已移除（`workflow_define` 工具同步下线），
> 自定义流程只有代码形态。历史 JSON 用 `@mickorz/opencode-agentic-workflow/core`
> API 改写（文末有映射表）。**v0.8.0 起 v1 脚本（魔法全局 + 顶层 return）
> 原生装载，不改写**（见「v1 脚本（legacy）直接装载」节）。

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

## 第三步：立即试跑 + 汇报（无需重启，你自己跑，不是让用户跑）

保存文件后**你直接调用 `workflow` 工具**——未知 flow id 会触发一次 flows
目录增量重扫，刚写的模块当场注册运行（v0.6.1 起；v1「定义即注册」的
代码形态对位）。参数自己组织：`flow=<id>, topic=<从需求取的小而真实样例>,
checkpointMode=auto-approve`（headless 必传）。关注：

- 步骤是否全 completed；失败步的报错（参数缺失/文件路径/评审否决）
- 产物是否落盘、内容是否符合预期
- `workflow not found` 且附 `flows load errors` 清单：文件写了但没注册
  上——按指名的错误修文件再试
- 有 `background: true` 需求时用 `workflow_control status` 轮询
- **边界（如实）**：只有**新文件**能被重扫拾取；**改动已装载文件**
  （含升 version）需重启生效（Node ESM 缓存按路径，重导返回旧模块）。
  编辑既有流程后用 resumeRunId 前先重启
- **新开聊天 ≠ 重启进程**：skill 每次会话从磁盘重读，**插件随 opencode
  进程加载一次就冻结**。重扫没拾取、available 里连老文件都缺 = 宿主
  进程是老的：看报错里的 `plugin v…`，与安装版本不符就提示用户
  **完全退出 opencode 再启动**（新开聊天无效）

试跑通过后**用自然语言向用户汇报**（不要贴工具语法）：

```
流程已创建并试跑通过：pinyin-mnemonic（中文词 -> 拼音首字母 -> 记忆口诀）
试跑：知识库 -> ZSK，口诀「知识三点连成库」
以后想用，直接说：「用拼音口诀流程，词：xxx」
```

## v1 脚本（legacy）直接装载

**用户给了 opencode-dynamic-workflows（v1）时代的 .js 脚本？原样放进
flows/ 目录即可，绝不改写。** 识别条件：文件含 `export const meta = {...}`
且不含 `defineWorkflow`。装载后与 v2 流程同权（同一 workflow 工具调用、
journal、TUI 面板、metrics）。

```js
// flows/smoke-test.js —— v1 脚本原样
export const meta = { name: 'smoke_test', description: '最小冒烟' }

phase('Scan')
const info = await agent('列出当前目录下的文件')

phase('Echo')
const results = await parallel([
  () => agent('说明工作流编排'),
  () => agent('说明确定性重放'),
])
return { info, results }
```

可用全局（19 个，v1 全集）：`agent(prompt, {label, timeoutMs, retries,
retryDelayMs, schema, model, isolation, agentType, tier})`（返回字符串；
schema 时返回解析对象）、`parallel` / `pipeline` / `sequence` / `fallback` /
`race`、`check(cond, msg)`、`fileExists(p)`（同步）/ `commandSuccess(cmd)`、
`phase` / `log` / `args` / `setConcurrency` / `verify` / `judgePanel` /
`retry` / `checkpoint(msg, {label, default})`（返回 boolean）/
`workflow(ref, args)`（子流程，ref 三形态：注册名 / 脚本路径
`'./x.js'` / 对象 `{scriptPath, label}`；返回子流返回值本体——对象可直取
字段）/ `console`。

**失败语义（v1 对位）**：v1 默认**一切未知错误可恢复**（AGENT_FAILED）——
parallel/pipeline 塌缩 `null`、sequence 停止返 `null`、fallback/race 换
候选；顶层 `agent()` 失败（超时/schema 耗尽等）也塌缩 `null` 继续跑
（登记「阶段失败闸门」——下一 `phase()` 边界或 run 终检触发终止报告；
fallback/race 成功吸收清空闸门）。只有适配层契约错误与 abort 是结构性
（立即上抛，不塌缩）。

**agent 选项**：`isolation: 'worktree'` per-call 独立 worktree（结束自动
拆除，非 git 目录响亮降级共享目录）；`agentType` / `tier` 响亮警告后降级
（v2 无调用级对位）；未知选项键 fail-loud。

与 v1 的已知差异（fail-loud，不静默）：
- `setConcurrency(n)`：v2 并发由 executor 统一管理——警告后忽略
- `phase()` 只进日志与事件（v2 TUI 无阶段分组；步骤行 = 叶子调用）
- resume = 整体重跑（v1 脚本无静态步骤序，无前缀跳过）
- **chain 式工具嵌套**（子 agent 调 workflow 工具的 scriptPath）不被
  支持——v2 工具拒绝 run 内调用（防信号量自饿死）；嵌套用 `workflow()`
- meta.name（snake_case）即 flow id；固定 version 1.0.0
- 脚本内不能有 static `import` / 除 meta 外的 `export`（装载期明确报错）

**选型**：新流程默认写 v2 `.mjs`（类型清晰、argsSchema 进工具 hint、
resume 支持步骤跳过）；v1 脚本直接放进来跑，或用户明确要 v1 风格时才写
v1 形态。

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
| `legacy script ... cannot use static import` | v1 脚本里写了 import——全局是注入的；需要导入就转 v2 .mjs |
| `legacy scripts may only contain export const meta` | v1 脚本多余的 export——去掉或转 v2 .mjs |
| `meta.name must be a non-empty snake_case string` | v1 meta.name 形状不对（如含 `-`）——改成 snake_case |
| `workflow not found` + `flows load errors` 清单 | 文件没注册上：按指名错误修文件（语法/形状/保留 id/解析失败）直接重试，无需重启 |
| 改了已注册流程但不生效 | 已装载文件的修改（含升 version）需重启；新文件才能被重扫即时拾取 |
| `id "..." is reserved by a built-in` | 换个 id |
| `duplicate <id>@<version>` | 同版本已从别的文件装载——删一处或升 version |
| verify 返回 `passed: false` | 评审语义否决——改产物质量或放宽 criteria，不是 bug |
