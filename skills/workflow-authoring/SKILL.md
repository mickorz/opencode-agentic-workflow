---
name: workflow-authoring
description: >
  编写与自定义 opencode-agentic-workflow 流程时加载。当用户想定义/创建一个
  workflow、把某个重复流程自动化、给现有流程改逻辑或加参数、放入 .js 脚本、
  或遇到流程装载报错与版本冲突时使用。覆盖：需求澄清、flows 目录 .js 脚本
  编写、装载注册、workflow 工具试跑验证的完整链路。唯一流程形态：js 脚本
  （export const meta + 魔法全局 + 顶层 return）；不创建 .mjs。
---

# workflow-authoring（流程编写 · 唯一形态：js 脚本）

把用户的流程需求变成可复用的 workflow：**对话澄清 → 写 flows 目录 .js
脚本 → 保存即用（未知 id 自动重扫注册）→ 自己调 `workflow` 工具试跑 →
汇报结果**。

> **唯一流程形态 = js 脚本**（用户产品决策，2026-10-10）：文件开头
> `export const meta = {...}`，正文用注入的魔法全局（`agent` / `parallel` /
> `phase` / `verify` / `checkpoint` / `workflow` …），结尾顶层 `return`。
> **零 import。不创建 `.mjs` / `.cjs`，不写 defineWorkflow ESM 模块**；
> 遇到旧 `.mjs` 流程：删除或改写成 js 形态。

## 零语法契约（本 skill 的服务边界）

**用户永远只说需求，不说工具语法。** `flow=` / `topic=` /
`checkpointMode=` 这些参数全部由你（agent）组织：

- 用户说「创建一个 workflow：需求是 xxx」→ 你走完澄清、写文件、
  **立即自己调用 workflow 工具试跑**（topic 从需求里取一个小而真实的
  样例，checkpointMode 用 auto-approve）、把运行结果汇报给用户——
  一口气做完，中途不要把工具参数丢回给用户
- 用户以后想再跑：说人话即可（「用五句话流程，主题：晨跑」/
  「再跑一次发布说明，主题换成 y」）——由你翻译成工具参数
- 需求已明确就别问；有真歧义才问，且一次问全

## 第一步：澄清需求（缺什么问什么，别猜）

1. **目的**：这个流程产出什么？（文档/代码/评审结论/检查报告）
2. **步骤**：大致几步、每步谁做（子 agent / 人工审批 / 语义评审 / 文件断言）
3. **参数**：除了主题 topic，还要哪些输入？（受众、语言、深度、评审标准…）
4. **完成标准**：最后一步之后怎么判断成功？

## 第二步：写 .js 脚本（flows 目录）

**动笔要快**：位置就是项目根下 `flows/`（缺省自动装载），或
`opencode.json` 插件 options 里 `workflows: ["<路径>"]` 显式指定的位置——
**不需要探测插件装在哪、npm 全局有什么**（探索超过两步还没开始写文件，
路线就错了）。文件名 kebab-case（`five-sentences.js`）；`meta.name` 即
flow id，**必须 snake_case**（`five_sentences`）。

```js
// flows/release-notes.js —— js 脚本完整示例
export const meta = { name: 'release_notes', description: '为主题生成一段发布说明' }

phase('起草')
let draft = await agent(
  `针对「${args.topic}」写 5 句以内的发布说明，只输出正文。禁止调用 workflow / workflow_metrics 工具。`,
  { label: '起草', timeoutMs: 300000, retries: 1 },
)

phase('评审')
const verdict = await verify(draft, { reviewers: 2, threshold: 0.5, lens: ['要点完整', '有明确结论'] })
if (verdict.real === false) {
  phase('修订')
  draft = await agent(
    `修订以下发布说明，补齐结论：\n${draft}\n禁止调用 workflow / workflow_metrics 工具。`,
    { label: '修订' },
  )
}

const approved = await checkpoint('发布说明已就绪，批准定稿？', { label: 'gate', default: true })
return { output: approved ? draft : `${draft}（未经人工批准）` }
```

**可用全局（19 个，无需导入、直接用）**：

- `agent(prompt, opts?)` → 返回字符串；`schema` 时返回解析对象。
  opts：`label` / `timeoutMs` / `retries` / `retryDelayMs` / `schema` /
  `model`（"providerID/modelId"）/ `isolation: 'worktree'`（per-call 独立
  worktree，结束自动拆除）；未知键 fail-loud
- 组合子：`parallel(thunks)` / `pipeline(items, stages)` /
  `sequence(nodes)` / `fallback(candidates)` / `race(branches)` /
  `retry(thunk, { attempts, until })`
- 质量与断言：`verify(item, { reviewers, threshold, lens })` →
  `{ real, realCount, total, votes }`；`judgePanel(attempts, { judges,
  rubric })` → 最高分候选；`check(cond, msg)`（通过 true；未通过按可恢复
  失败处理）；`fileExists(p)`（同步布尔）/ `commandSuccess(cmd)`（异步布尔）
- `checkpoint(msg, { label, default })` → **boolean**（批准 true / 拒绝
  false，不抛错；无交互 gate 时回落 `default`，没配 default 才报错）
- `workflow(ref, subArgs?)`：子流程。ref 三形态：注册名 `'five_sentences'` /
  脚本路径 `'./x.js'` / 对象 `{ scriptPath, label }`；返回子流返回值本体
  （对象可直取字段）
- `version()` → 版本字符串（如 `'0.8.7'`）——插件运行时版本，诊断/联调用
  （v2 扩展全局）
- 其他：`phase(name)`（阶段标记，进日志与事件）/ `log(...)` / `args` /
  `console`（shim）/ `setConcurrency(n)`（警告后忽略——并发由 executor
  统一管理）

**失败语义**：一切未知错误默认**可恢复**——parallel/pipeline 槽位塌缩
`null`、sequence 停止返 `null`、fallback/race 换候选；顶层 `agent()` 失败
（超时/schema 耗尽等）也塌缩 `null` 继续跑（登记「阶段失败闸门」——下一
`phase()` 边界或 run 终检触发终止报告；fallback/race 成功吸收清空闸门）。
只有装载期契约错误与 abort 是结构性（立即上抛）。**parallel 出 null 槽位
要自己兜底**（见示例外的 `sentences.map(s => s ?? '兜底')` 写法）。

**必守纪律（违反 = 事故）**：

1. 每个 `agent` prompt **必须以「禁止调用 workflow / workflow_metrics
   工具」收尾**——子 agent 递归调工作流会自饿死并发信号量
2. **脚本内禁止 static `import`、禁止除 meta 外的任何 `export`**（装载期
   明确报错）。数据需求（拼音表/词表/映射表）**直接内嵌进 .js 文件**（大表
   放文件底部）；库能力做不到的部分交给 `agent` 步
3. `meta.name`（snake_case）即 flow id，不得撞内置名：`smoke` /
   `reliable` / `artifact` / `feature-development`；version 固定 `1.0.0`，
   无需声明
4. `.js` 里**不能有 TypeScript 注解**（纯 JavaScript）
5. 嵌套子流程只用 `workflow()` 全局；**绝不让子 agent 去调 workflow 工具**
6. `args` 恒有 `topic`（工具自动传）；其他参数直接 `args.xxx` 读，由你
   调用时组织进 args
7. **不要探索插件安装位置 / npm 全局目录**——脚本运行在插件进程内，
   用户目录与全局的 npm 包一概 import 不到（反正也不许 import）
8. journal 动态记叶子步骤（每个 agent / checkpoint / subflow 各一步）；
   resume = 整体重跑（无前缀跳过）

## 第三步：立即试跑 + 汇报（无需重启，你自己跑，不是让用户跑）

保存文件后**你直接调用 `workflow` 工具**——未知 flow id 会触发一次 flows
目录增量重扫，刚写的脚本当场注册运行。参数自己组织：`flow=<meta.name>,
topic=<从需求取的小而真实样例>, checkpointMode=auto-approve`（headless
必传）。关注：

- 步骤是否全 completed；失败步的报错（参数缺失/文件路径/评审否决）
- 产物是否落盘、内容是否符合预期
- `workflow not found` 且附 `flows load errors` 清单：文件写了但没注册
  上——按指名的错误修文件再试
- 有 `background: true` 需求时用 `workflow_control status` 轮询
- **边界（如实）**：只有**新文件**能被重扫拾取；**改动已装载文件**需重启
  生效（Node ESM 缓存按路径，重导返回旧模块）
- **新开聊天 ≠ 重启进程**：skill 每次会话从磁盘重读，**插件随 opencode
  进程加载一次就冻结**。重扫没拾取、available 里连老文件都缺 = 宿主
  进程是老的：看报错里的 `plugin v…`，与安装版本不符就提示用户
  **完全退出 opencode 再启动**（新开聊天无效）

试跑通过后**用自然语言向用户汇报**（不要贴工具语法）：

```
流程已创建并试跑通过：release_notes（为主题生成一段发布说明）
试跑：主题「v0.8.3」→ 5 句发布说明 + 双人评审通过 + 人工批准
以后想用，直接说：「用发布说明流程，主题：xxx」
```

## 旧 JSON → js 迁移映射

| 旧 JSON 步骤 | js 脚本写法 |
|------|------|
| `{ agent: "提示 {{topic}}" }` | `agent(\`提示 ${args.topic}\`)` |
| `{ checkpoint: "批准？" }` | `await checkpoint("批准？")`（返回 boolean，拒绝不抛错） |
| `{ verify: { artifact, criteria } }` | `await verify(artifact, { lens: criteria })`，看 `verdict.real` |
| `{ fileExists: "out.md" }` | `if (!fileExists("out.md")) …`（同步布尔） |
| `{ pipeline: "模板 {{item}}", items }` | `await pipeline(items, [async (item) => agent(\`模板 ${item}\`)])` |
| `{ race: ["A", "B"] }` | `await race([() => agent("A"), () => agent("B")])` |
| `"output": "{{steps.draft}}"` | 末尾 `return { output: draft }` |

## 常见报错速查

| 报错 | 原因与修法 |
|------|-----------|
| `legacy script ... cannot use static import` | 脚本里写了 import——19 个全局是注入的；数据需求内嵌文件 |
| `legacy scripts may only contain export const meta` | 多余的 export——去掉（唯一导出就是 meta） |
| `meta.name must be a non-empty snake_case string` | id 形状不对（如 `five-sentences`）——改 `five_sentences` |
| `JSON workflows were removed in a v0.6.0` | flows 目录里还有 .json——按上面映射表改写成 js 脚本 |
| `.mjs/.cjs workflow files were removed in v0.9.0` / `defineWorkflow ESM module workflows were removed in v0.9.0` | 手滑写成了 `.mjs` / defineWorkflow 模块——改名 `.js` 并改写成 v1 脚本形态（唯一形态，用户产品决策 2026-10-10；错误信息自带改写指引） |
| `workflow not found` + `flows load errors` 清单 | 文件没注册上：按指名错误修文件（语法/形状/保留 id）直接重试，无需重启 |
| 改了已注册流程但不生效 | 已装载文件的修改需重启；新文件才能被重扫即时拾取 |
| `id "..." is reserved by a built-in` | 换个 id（内置：smoke / reliable / artifact / feature-development） |
| `duplicate <id>@1.0.0` | 同名 id 已从别的文件装载——删一处或改名 |
| verify 返回 `real: false` / parallel 出现 `null` 槽位 | 语义否决 / 可恢复失败塌缩（设计行为）——改质量、放宽标准，或代码里对 null 兜底 |
| 新开聊天后 skill 是新的但流程列表是旧的 | 插件随宿主进程加载一次就冻结——完全退出 opencode 再启动 |
