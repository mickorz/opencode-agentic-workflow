---
name: workflow-authoring
description: >
  编写与自定义 opencode-agentic-workflow 声明式流程时加载。当用户想定义/创建一个
  workflow、把某个重复流程自动化、给现有流程加步骤或参数、或遇到 workflow_define
  版本冲突与校验报错时使用。覆盖：需求澄清、声明式 JSON 构造、workflow_define
  落盘注册、workflow 工具试跑验证的完整链路。
---

# workflow-authoring（声明式流程编写）

把用户的流程需求变成可复用的声明式 workflow：**对话澄清 → 构造 JSON →
`workflow_define` 落盘注册 → `workflow` 工具试跑**。全程无需人工编辑文件。

## 第一步：澄清需求（缺什么问什么，别猜）

1. **目的**：这个流程产出什么？（文档/代码/评审结论/检查报告）
2. **步骤**：大致几步、每步谁做（子 agent / 人工审批 / 语义评审 / 文件断言）
3. **参数**：除了主题 topic，还要哪些输入？（受众、语言、深度、评审标准…）
4. **完成标准**：最后一步之后怎么判断成功？

## 第二步：构造声明式 JSON

```json
{
  "id": "kebab-case-短名",
  "version": "1.0.0",
  "description": "一句话说明（进工具清单，给未来的你/agent 看）",
  "args": {
    "type": "object",
    "properties": {
      "topic": { "type": "string", "description": "主题" },
      "audience": { "type": "string", "description": "受众" }
    },
    "required": ["topic"]
  },
  "steps": [
    {
      "name": "draft",
      "agent": "针对 {{topic}} 为 {{args.audience}} 写初稿…。禁止调用 workflow / workflow_metrics 工具。完成后只回复 done。",
      "model": "glm/glm-5.3-flash",
      "timeoutMs": 300000,
      "retries": 1
    },
    { "name": "review", "verify": { "artifact": "{{steps.draft}}", "criteria": "要点完整且有结论" } },
    { "name": "gate", "checkpoint": "「{{topic}}」初稿已生成，批准？" },
    { "name": "file", "fileExists": "out.md" }
  ],
  "output": "定稿：{{steps.draft}}"
}
```

**步骤五类**（每步恰好一个步骤键）：`agent`（子 agent）、`checkpoint`（人工
审批门）、`verify`（语义评审；可加 `threshold` 投票与 `lenses` 多视角）、
`fileExists`（文件存在断言，相对项目根）、`subflow`（嵌套另一个已注册
workflow；`"subflow": "flow-id"` + 可选 `args` 对象（原始值或模板）；需要
journalDir；嵌套深度上限 3；子 run 的输出进 `{{steps.<名>}}`，子 run 失败按
普通步骤失败处理）。

**必守纪律（违反 = 事故）**：

1. 每个 `agent` prompt **必须以「禁止调用 workflow / workflow_metrics 工具」
   收尾**——子 agent 递归调工作流会自饿死并发信号量
2. 模板变量只有 `{{topic}}`、`{{args.x}}`、`{{steps.<前步名>}}`；未知变量 =
   该步失败（fail-loud，绝不静默空串）
3. `args` 里声明过的参数才能在 prompt 里引用；`topic` 恒有（工具自动传）
4. `agent` 步可选 `model`（"providerID/modelId"）/ `timeoutMs`（正数毫秒）/
   `retries`（非负整数）——只在 agent 步合法
5. 改动已注册流程的步骤内容 = **必须升 version**（1.0.0 → 1.1.0）；旧版本
   journal 的 resume 依赖精确版本解析
6. `id` 不得用内置名：smoke / reliable / artifact / feature-development

## 第三步：workflow_define 落盘注册

调用 `workflow_define` 工具，输入刚构造的 `workflow` 对象。结果语义：

- 成功：返回 `defined <id>@<version>` 与落盘路径，**立即可用**（无需重启）
- 「already defined (identical)」：内容相同，幂等成功，直接用
- 「already registered with DIFFERENT content」：同版本不同内容——升 version
  再 define
- 校验报错：逐字段指名，按报错修 JSON 再试

## 第四步：试跑验证

调用 `workflow` 工具：`flow=<id>, topic=<真实小主题>, checkpointMode=auto-approve`
（headless 必传）。关注：

- 步骤是否全 completed；失败步的报错（模板变量/文件路径/评审否决）
- 产物是否落盘、内容是否符合预期
- 有 `background: true` 需求时用 `workflow_control status` 轮询

试跑通过后向用户报告：流程 id、参数用法（含 args 清单）、一句话示例。

## 常见报错速查

| 报错 | 原因与修法 |
|------|-----------|
| `must have exactly one of agent/checkpoint/verify/fileExists/subflow` | 一步给了两个步骤键，或忘了给 |
| `subflow step "..." requires the journalDir` | subflow 需要插件配置 journalDir（lineage 落盘）；配置后重试 |
| `subflow nesting too deep` | 嵌套超 3 层；拍平组合方式 |
| `template variable {{...}} is not provided` | 调用没传该参数，或 args 没声明 |
| `already registered with DIFFERENT content` | 升 version 再 workflow_define |
| `id "..." is reserved by a built-in` | 换个 id |
| verify 步 `fail` | 评审语义否决——改产物质量或放宽 criteria，不是 bug |
