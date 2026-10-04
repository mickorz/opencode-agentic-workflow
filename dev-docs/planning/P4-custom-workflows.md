# P4 —— 自定义 workflow 装载（声明式 JSON）

**日期**：2026-10-04 立项 ｜ **状态**：实现完成——装载器/插件接线/单测 8 项
（全量 204/204）/ E2E 一次通过（自定义四步流程 release-notes：draft→review→file→gate，
journal 全 completed、真实产物落盘、verify 语义评审跑通、自定义 id 进入工具枚举）。
待办：examples/02 读者向示例 + authoring guide 章节（随下个 commit）。
**动机**：Adoption A4 拐点（用户开始写自己的 workflow）的前置缺口——npm 包
目前只导出插件入口，用户无法注册自己的流程，只能改插件源码重发包。

## 目标

项目目录放置 JSON 声明式 workflow 文件 → 插件 init 自动装载注册 →
经同一 `workflow` 工具调用、同享 journal/trace/metrics/resume/隔离/checkpoint
全部既有机制。

## 非目标（明确不做）

- **代码式装载（.ts/.js）**：需编译链与任意代码执行面，作为 P4.2 escape
  hatch 另行评估；声明式覆盖直线链场景的 80%
- **热加载**：沿用「插件变更需重启 service」的既有心智，不变
- **声明式 parallel/retry/fallback 编排**：v1 仅直线 sequence（复杂控制流
  仍是代码式 workflow 的领地）
- marketplace / 远程分发

## 形态决策：声明式 JSON

理由：零编译链、可静态校验（装载时全量校验，坏文件跳过并警告）、
无任意代码执行（宿主安全）、与 argsSchema（JSON Schema）天然同构。

## 接口设计

插件 options 新增：

```jsonc
"workflows": ["agw.workflows/*.json"]   // 路径数组：.json 文件或目录
                                          //（扫一层 *.json）；相对项目目录
```

文件格式：

```jsonc
{
  "id": "release-notes",              // kebab-case，工具 flow 参数即它
  "version": "1.0.0",                 // 缺省 1.0.0
  "description": "生成发布说明并人工把关",
  "args": { "type": "object", "properties": { "topic": { "type": "string" } }, "required": ["topic"] },
                                      // 缺省 = 仅 topic（工具恒传）
  "steps": [
    { "name": "draft",     "agent": "为 {{topic}} 起草发布说明…" },
    { "name": "gate",      "checkpoint": "{{topic}} 的草稿已生成（{{steps.draft}} 摘要见上），批准发布？" },
    { "name": "artifact",  "fileExists": "release-notes.md" }   // 相对 workspaceRoot
  ],
  "output": "最终产出：{{steps.draft}}"   // 缺省 = 最后一个 agent 步输出
}
```

步骤类型（互斥键，v1 四种，全部映射既有原语）：

| 键 | 原语 | 语义 |
|---|---|---|
| `agent: string` | `agent(prompt)` | 子 agent 执行；输出存入 `steps.<name>` |
| `checkpoint: string` | `checkpoint(msg, {label})` | 人工/策略审批门 |
| `verify: { artifact, criteria?, reviewers?, label? }` | `assertVerify` | 语义评审，否决即失败 |
| `fileExists: string` | `assert(fileExists(p))` | 相对 workspaceRoot 的存在性断言 |

模板变量：`{{topic}}`（= args.topic）、`{{args.x}}`、`{{steps.<name>}}`
（agent 步输出）。未知变量 = 步骤级失败（journal 可见，绝不静默空串）。

## 错误语义

- **装载期**（文件级）：JSON 解析失败/校验失败/注册冲突 → `console.warn`
  + 跳过该文件，不阻断其他文件与内置 workflow（观测/基础设施不能成为
  主链路故障源——既有纪律）
- **运行期**（步骤级）：模板缺变量、verify 否决、checkpoint 拒绝、
  fileExists 不存在 → 对应步骤 failed，走既有 failed/resume 语义

## 验收标准

1. 单测：装载校验（合法/非法全分支）、目录扫描、坏文件跳过、模板解析
   （含未知变量报错）、四类步骤的 run 行为（stub executor + auto gate）
2. `examples/02-custom-workflow/`：读者向示例（npm 包名形式），README
   三分钟可跑
3. E2E：dev-examples 用本机 dist 跑通自定义流程（journal 步名与 JSON 一致、
   checkpoint 正常、fileExists 断言生效）
4. 文档：authoring guide 增「自定义 workflow」章、执行进度 milestone
