我对照了 OpenCode v2 最新官方插件文档和 v1→v2 migration 文档。先给你一个核心判断：

> **V2 最大的变化不是“多几个 Hook”，而是插件从“挂钩 OpenCode 生命周期”升级成了“拿到一套接近完整 OpenCode Server 能力的扩展 Context”。**

官方自己对 `ctx` 的定义就是：**V2 plugin context 本质上既是 OpenCode server client，又是 plugin extension API**。[OpenCode](https://opencode.ai/v2/docs/build/plugins/?utm_source=chatgpt.com)

所以对你的 `opencode-agentic-workflow` 来说，很多 V1 里需要自己维护的基础设施，现在可以考虑交给 OpenCode。

---

# 一、先看总体变化

| 能力 | V1 Plugin | V2 Plugin | 对 Agentic Workflow 的价值 |
|---|---|---|---|
| Plugin 生命周期 | 返回 object/hooks | `Plugin.define + setup(ctx)` | ⭐⭐⭐ |
| Session 操作 | 主要依赖 client | **一等 `ctx.session` Domain** | ⭐⭐⭐⭐⭐ |
| 创建 Session | 可以绕 client | **官方直接支持** | ⭐⭐⭐⭐⭐ |
| 切 Agent | 较弱/间接 | **`switchAgent()`** | ⭐⭐⭐⭐⭐ |
| 切 Model | 较弱/间接 | **`switchModel()`** | ⭐⭐⭐⭐⭐ |
| Prompt 注入 | `chat.message` 等 hook | **正式 prompt hook** | ⭐⭐⭐⭐ |
| 修改 LLM Context | experimental hooks | **正式 context hook** | ⭐⭐⭐⭐⭐ |
| 控制 Tool | hooks | **Transform + Hook + Reload** | ⭐⭐⭐⭐⭐ |
| Permission | `permission.ask` | **规则 + hook + reply API** | ⭐⭐⭐⭐⭐ |
| Plugin Storage | 自己存文件为主 | **`ctx.storage`** | ⭐⭐⭐⭐⭐ |
| Agent Registry | 配置/间接 | **`ctx.agent.transform`** | ⭐⭐⭐⭐⭐ |
| Skill Registry | 文件系统为主 | **`ctx.skill.transform/reload`** | ⭐⭐⭐⭐ |
| MCP | 配置为主 | **Plugin Domain** | ⭐⭐⭐⭐ |
| Worktree | 自己实现较多 | **官方 Domain / SDK** | ⭐⭐⭐⭐⭐ |
| VCS | 较弱 | **Plugin Domain** | ⭐⭐⭐⭐ |
| Event Stream | 单一 event callback | **async event subscription** | ⭐⭐⭐⭐⭐ |
| RPC | 无标准插件 RPC | **正式 Plugin RPC** | ⭐⭐⭐⭐⭐ |
| TUI Extension | 很有限/自己折腾 | **CLI Plugin 独立体系** | ⭐⭐⭐⭐⭐ |
| Remote Server | 不够完整 | **Client/Server 架构原生支持** | ⭐⭐⭐⭐⭐ |
| Tool Registry | tool map | **动态 add/update/remove** | ⭐⭐⭐⭐⭐ |
| Provider/Model | provider hook | **独立 Provider + Model Domain** | ⭐⭐⭐⭐ |
| Cleanup | dispose hook | `setup()` 返回 cleanup | ⭐⭐⭐ |
| 插件隔离 ID | 弱 | **stable plugin ID** | ⭐⭐⭐⭐ |

但这里要注意：

**“V2 支持更多”不意味着 V1 完全做不到。**

很多事情 V1 可以通过 client、私有 API、文件操作或者 workaround 实现；V2 的提升在于：

> **变成正式、类型化、一等、可组合的 Plugin API。**

这对你的项目尤其重要。

---

# 二、最大的提升：Session 变成真正的一等 API

这个我认为是 **`opencode-agentic-workflow` 最值得利用的变化**。

V2 Plugin 可以直接：

```ts
const session = await ctx.session.create({
    title: "Implement Login"
})
```

然后：

```ts
await ctx.session.prompt({
    sessionID,
    text: "实现登录模块"
})
```

甚至直接切换 Agent：

```ts
await ctx.session.switchAgent({
    sessionID,
    agent: "build"
})
```

切换 Model：

```ts
await ctx.session.switchModel({
    sessionID,
    model: {
        providerID: "anthropic",
        id: "claude-sonnet-4-6"
    }
})
```

还可以：

```ts
ctx.session.context()
ctx.session.generate()

ctx.session.command()
ctx.session.synthetic()

ctx.session.rename()

ctx.session.interrupt()

ctx.session.wait()
```

这是官方直接暴露出来的 Session Domain。[OpenCode](https://opencode.ai/v2/docs/build/plugins?utm_source=chatgpt.com)

---

## 对你意味着什么

你现在 V1：

```text
agent()
   ↓
创建 sub-session
   ↓
发送 prompt
   ↓
监听 completion
   ↓
读取结果
```

V2 可以自然变成：

```text
agent()
   ↓
AgentExecutor
   ↓
ctx.session.create()
   ↓
ctx.session.switchAgent()
   ↓
ctx.session.switchModel()
   ↓
ctx.session.prompt()
   ↓
ctx.session.wait()
   ↓
ctx.session.context()
```

这非常契合你的：

```js
agent("修改登录代码", {
    agent: "build",
    model: "claude-sonnet"
})
```

---

# 三、Agent 本身变成 Plugin 可修改的 Domain

V2 不只是“调用 Agent”。

插件现在可以参与 **Agent Registry**。

官方把很多东西都划成 Domain：

```text
ctx.agent
ctx.provider
ctx.model

ctx.command
ctx.integration

ctx.mcp
ctx.reference
ctx.skill
ctx.tool

ctx.vcs
ctx.websearch
ctx.worktree
```

插件可以通过：

```ts
transform(editor => {})
```

修改这些 Registry。[OpenCode](https://opencode.ai/v2/docs/build/plugins/migrate-v1?utm_source=chatgpt.com)

例如未来你的 workflow 可以动态注册：

```text
RequirementAgent
      │
      ├─ UIAgent
      ├─ ClientAgent
      ├─ ServerAgent
      └─ QAAgent
```

甚至某个 Workflow 启动的时候动态注入一组 Agent，然后结束时 dispose。

这比 V1：

```text
workflow 调已有 agent
```

进一步变成：

```text
workflow
   │
   ├── 定义 agent
   ├── 修改 agent
   ├── 选择 agent
   └── 执行 agent
```

对于 Agentic Workflow Framework 很关键。

---

# 四、Context Hook 正式化了

你之前很关心：

> 如何减少上下文污染。

V2 在这一块非常值得研究。

以前 V1 使用：

```text
experimental.chat.system.transform
experimental.chat.messages.transform
```

V2 正式归到了：

```ts
ctx.session.hook("context", event => {

})
```

插件可以在 **真正发送模型请求前** 修改：

```text
system
messages
tools
options
```

比如：

```ts
await ctx.session.hook("context", event => {

    event.system.push({
        type: "text",
        text: "你现在是代码审核 Agent"
    })

    delete event.tools.write

    event.options.temperature = 0.2
})
```

而且官方区分了：

```text
prompt
context
compaction
generate
title
```

不同模型请求生命周期。[OpenCode](https://opencode.ai/v2/docs/build/plugins/?utm_source=chatgpt.com)

---

# 五、这对 Context Engineering 特别重要

你的 Workflow 可以真正加入：

```text
Context Policy Layer
```

例如：

```text
Workflow
   │
   ▼
Agent Node
   │
   ▼
Context Builder
   │
   ├─ System Prompt
   ├─ Relevant Docs
   ├─ Previous Node Result
   ├─ Skills
   └─ Allowed Tools
   │
   ▼
LLM
```

以后：

```js
agent("实现登录", {
    context: {
        inherit: false,
        include: [
            "requirement",
            "previous_result"
        ]
    }
})
```

可以在 `context hook` 上实现。

这个能力和你的 **主 Context 不污染 / 子 Session 隔离** 路线非常匹配。

---

# 六、Permission 能力提升非常大

这是另一个我认为你应该重点利用的。

V1 更像：

```text
permission.ask
```

V2 已经形成比较完整的 Permission Domain：

```ts
ctx.permission.list()

ctx.permission.get()

ctx.permission.reply()

ctx.permission.rules()
```

还可以：

```ts
ctx.permission.hook("evaluate", ...)
```

插件甚至能够在 OpenCode 原始规则判定之后进一步：

```text
allow
ask
deny
```

官方还明确支持：

```ts
await ctx.permission.rules({
    sessionID,

    permissions: [{
        action: "edit",
        resource: "/project/**",
        effect: "deny"
    }]
})
```

而且 **子 Session 创建时会继承当时的 Session permission rules**。[OpenCode](https://opencode.ai/v2/docs/build/plugins?utm_source=chatgpt.com)

---

# 七、这正好解决你以前研究的 Agent 权限隔离

你之前自己做：

```text
Agent A

read:
 /docs/**

write:
 /src/client/**
```

Agent B：

```text
read:
 /docs/**

write:
 /src/server/**
```

V2 可以考虑设计：

```js
agent("实现客户端", {

    permissions: {

        read: [
            "docs/**",
            "src/client/**"
        ],

        edit: [
            "src/client/**"
        ],

        deny: [
            "src/server/**"
        ]
    }
})
```

Workflow Runtime：

```text
agent()
   ↓
create session
   ↓
permission.rules(session)
   ↓
prompt()
```

这比 V1 时代你自己维护 sandbox 权限机制更 Native。

---

# 八、Plugin Storage 是非常实用的新能力

V2 正式提供：

```ts
ctx.storage.set()

ctx.storage.get()

ctx.storage.remove()

ctx.storage.scan()
```

而且：

> Storage 自动按照 **Plugin ID 隔离并持久化**。 [OpenCode](https://opencode.ai/v2/docs/build/plugins/?utm_source=chatgpt.com)


例如：

```ts
await ctx.storage.set(
    "workflow/run-123",
    {
        status: "running"
    }
)
```

之后：

```ts
await ctx.storage.get(
    "workflow/run-123"
)
```

---

# 九、你的 Journal / Resume 应该重新评估

你 V1 自己有：

```text
journal

resume

run state

workflow state
```

V2 不一定意味着全部删除，但可以重构成：

```text
Workflow Persistence
          │
          ▼
     StorageAdapter
          │
    ┌─────┴─────┐
    ▼           ▼
OpenCode      File
Storage       Storage
```

默认：

```text
OpenCodeStorageAdapter
```

使用：

```text
ctx.storage
```

这样：

```text
RunState
NodeState
CheckpointState
ResumeState
```

都有原生存储方案。

---

# 十、Tool 不再只是“注册一个 Tool”

V1 通常：

```ts
return {
    tool: {
        workflow: tool(...)
    }
}
```

V2：

```ts
ctx.tool.transform(editor => {

    editor.add()

    editor.update()

    editor.remove()

    editor.namespace()

})
```

还可以：

```ts
ctx.tool.reload()
```

以及：

```ts
ctx.tool.list()
```

再结合：

```ts
ctx.tool.hook(
    "execute.before"
)

ctx.tool.hook(
    "execute.after"
)
``` :chatgpt-content-reference{index="6"}


---

# 十一、这意味着你可以做 Dynamic Toolset

例如：

```text
Coding Agent
```

只给：

```text
read
grep
edit
bash
workflow
```

Research Agent：

```text
read
grep
websearch
```

Review Agent：

```text
read
grep
```

你的：

```js
agent(...)
```

以后甚至可以支持：

```js
agent("Review implementation", {

    tools: {
        allow: [
            "read",
            "grep"
        ]
    }

})
```

这就是：

> **Per-Agent Capability Isolation**

和 Permission 再组合：

```text
Agent
 │
 ├── Agent
 │
 ├── Model
 │
 ├── Context
 │
 ├── Tools
 │
 └── Permissions
```

这已经比 V1 动态工作流的 Agent Node 强很多。

---

# 十二、Skill 变成正式 Plugin Domain

这个对你也非常重要。

V2 可以：

```ts
ctx.skill.list()

ctx.skill.transform()

ctx.skill.reload()
```

插件能够：

```text
add skill
update skill
remove skill
reload skills
``` :chatgpt-content-reference{index="7"}


以后可以出现：

```js
agent("生成 UI", {

    skills: [
        "fairygui",
        "ui-requirement"
    ]

})
```

Workflow Engine 不只是：

```text
派 Agent
```

而是：

```text
Agent
 +
Skills
 +
Tools
 +
Context
 +
Model
```

组合成一个临时 Worker。

---

# 十三、MCP 也进入插件扩展 Domain

官方 migration 文档明确列出：

```text
ctx.mcp
```

可以参与 Transform。[OpenCode](https://opencode.ai/v2/docs/build/plugins/migrate-v1?utm_source=chatgpt.com)

因此你的 Agent Node 最后很可能应该抽象成：

```text
AgentNode

├── agent
├── model
├── skills
├── tools
├── mcp
├── context
├── permissions
└── worktree
```

也就是：

```js
agent("制作登录 UI", {

    agent: "general",

    model: "...",

    skills: [
        "fairygui"
    ],

    mcp: [
        "unity",
        "figma"
    ],

    tools: [...],

    permissions: {...}

})
```

这个已经明显从：

> Sub-Agent 调度器

升级成：

> Agent Runtime Orchestrator。

---

# 十四、Worktree 成了原生能力

V2 SDK 官方提供：

```ts
opencode.worktree.create()

opencode.worktree.refresh()

opencode.worktree.remove()
```

并且 Plugin 可以通过：

```text
ctx.worktree.transform
```

注册自定义 Worktree strategy。[OpenCode](https://opencode.ai/v2/docs/build/sdk?utm_source=chatgpt.com)

这对你的：

```text
parallel()
```

非常重要。

以前：

```text
parallel

Agent A ──┐
Agent B ──┼── 同一个目录
Agent C ──┘

→ 文件冲突
```

以后 Native Architecture 可以是：

```text
parallel

        ┌─ Worktree A → Agent A
        │
Root ───┼─ Worktree B → Agent B
        │
        └─ Worktree C → Agent C

                ↓

             Merge
```

你 V1 已经有 worktree isolation，这部分非常值得研究能否大幅减少自实现代码。

---

# 十五、Event 模型也明显加强

V1：

```text
event callback
```

V2：

```ts
for await (
   const event
   of ctx.event.subscribe()
) {

}
```

成为正式 Server Event Stream。[OpenCode](https://opencode.ai/v2/docs/build/plugins/migrate-v1?utm_source=chatgpt.com)

这意味着你的 Observability：

```text
Workflow Run
    │
    ├── Session Created
    ├── Prompt
    ├── Tool Start
    ├── Tool End
    ├── Permission
    ├── Model
    ├── Session Idle
    └── Session Complete
```

都可以用更统一的 Event 驱动。

---

# 十六、V2 新的 Plugin RPC 非常值得你重视

这个我认为是 **V2 最容易被低估的新能力之一**。

V2 插件可以正式注册：

```ts
ctx.rpc.register(...)
```

定义：

```text
Methods
Errors
Events
```

然后：

```text
另一个 Plugin
TUI
外部 Client
HTTP Client
```

都能调用。

例如你的：

```text
opencode-agentic-workflow
```

可以暴露：

```text
workflow.run

workflow.stop

workflow.resume

workflow.status

workflow.list

workflow.node

workflow.trace
```

还可以发：

```text
workflow.started
workflow.node.started
workflow.node.completed
workflow.failed
workflow.completed
```

官方明确支持插件自定义 RPC method 和 event，并且可以经 HTTP/Client/Plugin 调用。[OpenCode](https://opencode.ai/v2/docs/build/plugins/rpc/?utm_source=chatgpt.com)

---

# 十七、这会彻底改善你的 TUI 架构

你 V1 的 TUI：

```text
Workflow Plugin
       │
       └──── hack / shared state ─── TUI
```

V2 可以变成：

```text
        Agentic Workflow Plugin
                 │
                 │ RPC
                 │
       ┌─────────┼──────────┐
       ▼         ▼          ▼
      TUI      Desktop      Web
```

比如：

```text
workflow.status(runId)
```

任何前端都能调用。

这对你未来做：

```text
AI工作台
```

其实很关键。

---

# 十八、CLI / TUI Plugin 独立成正式体系

V2 明确有：

> Server Plugin

和：

> CLI Plugin

CLI Plugin 有自己的：

```text
context.client
context.data
context.ui
context.theme
```

而且可以监听 typed events：

```ts
context.data.on(
    "permission.asked",
    ...
)
```

还能连接 **Remote OpenCode Server**。[OpenCode](https://opencode.ai/v2/docs/build/plugins/cli/?utm_source=chatgpt.com)

所以你 Workflow Tree：

```text
Workflow
├─ Phase Research
│  ├─ Agent A ✓
│  ├─ Agent B ...
│  └─ Agent C ✓
│
└─ Phase Build
   └─ Agent D
```

以后最好直接：

```text
Server Plugin
       │
       │ RPC/Event
       ▼
CLI Plugin
       │
       ▼
Workflow Tree
```

而不是 Runtime 和 TUI 强耦合。

---

# 十九、Server / Client / Plugin 三层终于统一了

V2 的整体架构实际上是：

```text
                OpenCode Server
                       │
          ┌────────────┼─────────────┐
          │            │             │
        Plugin        CLI         Desktop
          │            │             │
          └────────────┼─────────────┘
                       │
                    Client API
```

官方甚至支持：

```ts
OpenCode.create({
    plugins: [...]
})
```

也就是说可以直接：

> Embed OpenCode 到你自己的应用。 [OpenCode](https://opencode.ai/v2/docs/build/sdk?utm_source=chatgpt.com)


这意味着你的：

```text
opencode-agentic-workflow
```

未来理论上不仅是 OpenCode CLI 插件。

还能：

```text
Desktop AI Workbench

        │

OpenCode SDK
        │
Agentic Workflow Plugin
        │
Workflow Engine
```

这和你之前想做的 **AI 工作台** 非常吻合。

---

# 二十、Provider / Model 控制也比 V1 清晰很多

V2 分开：

```text
ctx.provider
ctx.model
```

可以：

```text
增加 provider
修改 provider

过滤 model
修改 model
限制 model
```

官方甚至给出了：

```ts
ctx.model.transform(editor => {

    editor.list("anthropic")
      .forEach(model => {

        if (!model.capabilities.tools)
            editor.remove(...)

    })
})
``` :chatgpt-content-reference{index="14"}


你的 Workflow 未来就可以真正做：

```text
Model Routing
```

例如：

```text
Research
    ↓
cheap model

Coding
    ↓
strong coding model

Verify
    ↓
different provider

Judge
    ↓
strong reasoning model
```

---

# 二十一、Shell 本身也可以 Hook

V2：

```ts
ctx.shell.hook(
    "create.before",
    event => {}
)
```

能够调整：

```text
command
cwd
timeout
shell
env
``` :chatgpt-content-reference{index="15"}


这对 Workflow 很适合：

```text
Agent A
   ↓
cwd = Worktree A

Agent B
   ↓
cwd = Worktree B
```

还可以统一：

```text
Timeout
Environment
Sandbox Environment
```

---

# 二十二、Plugin 生命周期和 Hot Reload 更规范

V2：

```ts
Plugin.define({

    id: "...",

    setup(ctx) {

        ...

        return () => {
            // cleanup
        }
    }
})
```

Plugin ID 同时：

```text
标识插件
Storage Namespace
Diagnostics Identity
```

而 Hook / Transform registration：

```text
Plugin unload
     ↓
自动 dispose
```

官方 Plugin 系统还支持插件管理：

```bash
opencode plugin add
opencode plugin list
opencode plugin check
opencode plugin update
opencode plugin remove
```

并支持 npm、Git、local package 等来源。[OpenCode](https://opencode.ai/v2/docs/plugins?utm_source=chatgpt.com)

这个对你以后发布插件明显比 V1 更标准。

---

# 二十三、我认为最重要的变化其实可以归纳成 7 个

如果只看你的项目，我会把 V2 带来的价值收敛成：

```text
                    OpenCode V2
                         │
      ┌──────────────────┼────────────────────┐
      │                  │                    │
      ▼                  ▼                    ▼
Session Runtime     Capability System    Extension System
      │                  │                    │
      │                  │                    │
  session            permissions             RPC
  context            tools                   events
  agent              skills                  TUI
  model              MCP                     storage
  generate           worktree                client
```

对应你的 V2 项目：

```text
               Agentic Workflow Engine
                        │
      ┌─────────────────┼──────────────────┐
      │                 │                  │
      ▼                 ▼                  ▼
  Execution          Isolation         Observability
      │                 │                  │
   Session          Permission            RPC
   Agent            Toolset              Events
   Model            Worktree             Trace
   Context          Skills               TUI
```

---

# 二十四、所以你的 Agent Node 可以重新设计了

V1：

```js
agent(
    "修改登录模块",
    {
        agentType: "general",
        model: "xxx"
    }
)
```

V2 我建议最终演进成：

```js
agent("修改登录模块", {

    agent: "build",

    model: {
        provider: "anthropic",
        model: "claude-sonnet"
    },

    context: {
        inherit: false,
        include: [
            "requirement",
            "previous"
        ]
    },

    skills: [
        "game-client-development"
    ],

    tools: {
        allow: [
            "read",
            "grep",
            "edit"
        ]
    },

    permissions: {
        read: [
            "docs/**",
            "src/client/**"
        ],

        write: [
            "src/client/**"
        ]
    },

    worktree: true,

    timeout: "10m",

})
```

这时候一个 `agent()` Node 实际上代表：

```text
                 Agent Node

                     │
        ┌────────────┼───────────────┐
        │            │               │
        ▼            ▼               ▼
      Model        Context         Agent
        │            │               │
      Skills       Tools        Permissions
        │            │               │
        └────────────┼───────────────┘
                     │
                 Worktree
                     │
                     ▼
                  Session
```

我认为这才应该是 **`opencode-agentic-workflow` 与旧 `opencode-dynamicworkflows` 最大的架构区别**。

---

# 二十五、哪些旧能力我建议“不要直接搬”

你的 V1 里这几个应该优先重新评估：

| V1 自研能力 | V2 可利用 | 建议 |
|---|---|---|
| Sub-session 管理 | `ctx.session` | **重写** |
| Permission isolation | `ctx.permission` | **重写** |
| Tool 注入 | `ctx.tool` | **重写** |
| Context 修改 | session hooks | **重写** |
| Plugin state | `ctx.storage` | **尽量替换** |
| Worktree | native worktree | **重新评估/减少自研** |
| Event tracking | event stream | **重写** |
| TUI communication | Plugin RPC | **重写** |
| Skill management | `ctx.skill` | **改 Native** |
| MCP integration | `ctx.mcp` | **改 Native** |
| Model routing | model/provider domain | **改 Native** |
| Workflow DSL | 你的核心资产 | **保留** |
| parallel/sequence/race | 你的核心资产 | **保留** |
| verify/check/checkpoint | 你的核心资产 | **保留** |
| Journal/Resume semantics | 你的核心资产 | **保留设计，换 Storage 底层** |
| Scheduler | 你的业务能力 | **保留** |

---

## 最后给你一个非常重要的定位变化

V1 的核心可以描述为：

```text
Dynamic Workflow

= 调度多个 Sub Agent
```

而 V2 新项目更适合定义为：

```text
Agentic Workflow

= Workflow Control Flow
+ Session
+ Agent
+ Model
+ Context
+ Skills
+ Tools
+ MCP
+ Permissions
+ Worktree
+ Verification
+ HITL
+ Persistence
+ Observability
```

所以我现在反而更认可你把新项目独立命名成：

**`opencode-agentic-workflow`**

而不是 `opencode-dynamicworkflows-v2`。

因为 OpenCode V2 提供的这些一等扩展能力，已经足够让你把项目从“**Workflow 调度插件**”往真正的“**Agent Runtime Orchestration Framework**”推进一层。

对，这其实是你现在新开 `opencode-agentic-workflow` 的最好时机。

你在 v1 里自己补的很多东西，本质上是在“填 OpenCode 平台能力的空缺”，例如：

- Agent 读写目录白名单 / 权限隔离
- 子 Agent 独立上下文
- 上下文裁剪、避免主会话污染
- Tool 可用范围控制
- Worktree 隔离
- Session 生命周期管理
- 执行状态、事件、可观测性
- Workflow 状态持久化

到了 v2，这些已经明显开始变成 OpenCode 原生能力，所以新版最重要的原则应该是：

> **不要把 v1 自研基础设施原样搬过去，而是保留 Workflow 语义，把基础能力尽量下沉给 OpenCode v2。**

可以把两代架构理解成：

```text
V1

opencode-dynamicworkflows
├─ Workflow DSL
├─ Agent orchestration
├─ Permission          ← 自己补
├─ Context             ← 自己补
├─ Session             ← 自己封装
├─ Worktree            ← 自己补
├─ State / Journal     ← 自己做
├─ Observability       ← 自己做
└─ TUI
```

到了 v2：

```text
V2

opencode-agentic-workflow

        Workflow Layer
             │
 ┌───────────┼───────────┐
 ▼           ▼           ▼
Control    Quality     Agent Node
 Flow
 │           │           │
sequence   verify        │
parallel   check         │
race       checkpoint    │
fallback                 │
                         ▼
              OpenCode V2 Runtime
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
       Session       Permission       Context
       Agent         Tool             Storage
       Model         Skill            Worktree
       MCP           Event            RPC
```

这样你真正需要维护的代码量反而可能比 v1 **少很多**。

而且还有一个更大的变化：以前你的 `agent()` 主要表示“启动一个子 Agent”，新版可以让它代表完整的 **Agent Execution Environment**：

```js
agent("实现登录模块", {
  agent: "coding",
  model: "xxx",

  context: {
    inherit: false
  },

  permissions: {
    read: ["docs/**", "src/client/**"],
    write: ["src/client/**"]
  },

  skills: ["unity-client"],

  tools: ["read", "grep", "edit"],

  worktree: true
})
```

也就是说，一个 Node 不只是：

```text
Task + Model
```

而是：

```text
Task
+ Agent
+ Model
+ Context
+ Permissions
+ Tools
+ Skills
+ MCP
+ Workspace
```

这也是我觉得 **Agentic Workflow** 这个名字比 **Dynamic Workflow** 更适合新版的原因。

另外，有几个你以前特别想解决的问题，在 v2 里应该直接列成新版的核心设计目标：

```text
01 Agent Capability Isolation
   每个 Agent 独立权限 / Tools / Skills / MCP

02 Context Isolation
   每个 Agent 明确决定继承什么上下文

03 Session Isolation
   每个 Workflow Node 独立 Session

04 Workspace Isolation
   并行 Agent 独立 Worktree

05 Deterministic Control Flow
   sequence / parallel / fallback / race / check

06 Quality Control
   check → verify → checkpoint

07 Observability
   Event + Trace + RPC + TUI

08 Persistence
   Workflow State + Resume + Checkpoint
```

其中 **01、02、03、04、07 的底层能力可以大量依赖 OpenCode v2**；你真正需要持续做强的是 **05、06、08 + Workflow DSL**。

这会让新版的边界清晰很多：

> **OpenCode v2 负责 Agent Runtime，你的项目负责 Agent Workflow Orchestration。**

这个架构边界我建议从 `v0.1.0` 就定死，不然后面很容易再次变成“OpenCode 缺什么，你插件自己实现什么”的大杂烩。