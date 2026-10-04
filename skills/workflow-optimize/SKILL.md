---
name: workflow-optimize
description: >
  opencode-agentic-workflow 流程的迭代优化闭环。当用户说某个 workflow 跑得慢/
  贵/老失败、要优化或迭代一个流程、要对比改动前后效果、或想基于 journal 与
  metrics 复盘执行质量时使用。覆盖：metrics/journal 诊断 → 单主题改动 →
  升版重定义 → 同参重跑 → 前后对比报告。
---

# workflow-optimize（流程迭代优化）

一次完整迭代 = **诊断 → 单主题改动 → 升版 → 同参重跑 → 对比报告**。
每次迭代只验证一个假设；收敛或收益递减即停。

## 第一步：诊断（先看数据，别急着改）

1. `workflow_metrics` 工具（format=json）：看累计 token/成本/时长——
   哪个流程贵、哪个模型贵
2. `workflow_control` 工具（action=status）：看 run 列表与单 run 详情——
   失败在哪一步、失败原因（模板变量/评审否决/超时/文件断言）、
   aborted/failed 占比
3. 打开流程 JSON（`workflow_define` 返回的落盘路径）：定位可疑步骤
   （prompt 模糊、timeout 过小、无 retries、verify criteria 过严/过松）

产出一句诊断结论：「X 流程的 Y 步因为 Z 原因导致 W 症状」。

## 第二步：单主题改动（一次只改一个变量）

常见主题（择一）：

- **步骤结构**：拆一步为两步 / 合并冗余步 / 加 fileExists 兜底断言
- **prompt 质量**：明确输出格式、加「只回复 done」收敛输出、消除歧义词
- **调用级选项**：给易超时步加 `timeoutMs`/`retries`；简单步用小 `model`
- **评审校准**：verify 的 `criteria` 写实；多维度用 `lenses`；容错用
  `threshold` 投票（全票制太严时）
- **参数化**：把硬编码值提升为 `args` 参数（提高复用/对比可控性）

## 第三步：升版重定义（版本契约）

改动步骤内容/prompts/args 结构 = **必须升 version**（1.0.0 → 1.1.0）。
调用 `workflow_define` 传入完整新 JSON；registry 同 id 多版本共存、
新 run 自动取最新。**绝不覆写旧版文件**——对比与回滚都靠旧版还在。

只改 description/output 模板等非结构内容？仍建议升版（版本即审计线）。

## 第四步：同参重跑（控制变量）

用与基线**相同的 topic 与 args** 跑新版：`workflow` 工具
`flow=<id>, topic=<基线同款>, checkpointMode=auto-approve`。
复杂流程可加 `background: true` + `workflow_control status` 轮询。

## 第五步：对比报告（向用户交代）

从两版 run 的 journal（workflow_control status 详情）+ metrics 提取：

| 维度 | 旧版 | 新版 | 变化 |
|------|------|------|------|
| 状态/失败步 | … | … | |
| token / 成本 | … | … | |
| 时长 | … | … | |
| verify 结论 | … | … | |

结论必须含：**改了什么、为什么有效/无效、下一步建议或「已收敛」**。
收益递减（<10% 且无质量提升）就停，别为迭代而迭代。

## 边界

- 负责：流程 JSON 的优化迭代与效果对比方法论
- 不负责：插件引擎开发（src/ 的活）、OpenCode 本身配置问题
- 回滚 = 用旧版 JSON 再 `workflow_define` 一个更高版本（内容抄旧版）
