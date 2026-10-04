# 外部用户测试计划（Adoption 第 5 项）

**启动**：2026-10-04 ｜ **对象**：5–10 个未参与开发的人 ｜ **基线**：npm 0.3.2
**前置已验证**：外部路径全真模拟通过（全新目录 + 包名形式 + README 原样命令 →
OpenCode 缓存解析 0.3.2 → smoke 全链完成）

## 目标与判定指标

| 指标 | 判定 | 记录字段 |
|---|---|---|
| A1 安装成功 | 包名配置 → workflow 工具出现 | 耗时 / 是否卡住 |
| A2 第一个 workflow 跑通 | smoke completed，拿到汇总报告 | 耗时 / 报告是否完整 |
| A3（加分）看懂核心价值 | 能说出"这和单 agent 对话有什么不同" | 用户原话 |
| A4 信号（拐点） | 跑通后主动问"怎么写自己的 workflow" | 出现与否（触发 Backlog「自定义 workflow 装载」评估） |
| 摩擦点 | 任何卡顿/困惑/报错 | 现象 / 原话 / 猜因 / 严重度 |

**完成判定**：≥5 人完成 A1+A2 且摩擦清单归档（进 P3-candidates Watching 或
Troubleshooting，按性质分流——与五连坑分类法一致）。

## 测试者脚本（可直接整段发给测试者）

> 脚本已入库（`scripts/tester/`），两种分发方式任选：
> ```bash
> # 方式A：克隆/下载后本地跑
> bash scripts/tester/step1-smoke.sh && bash scripts/tester/step2-flagship.sh
> # 方式B：不克隆直接跑（bash 进程替换）
> bash <(curl -fsSL https://raw.githubusercontent.com/mickorz/opencode-agentic-workflow/main/scripts/tester/step1-smoke.sh)
> bash <(curl -fsSL https://raw.githubusercontent.com/mickorz/opencode-agentic-workflow/main/scripts/tester/step2-flagship.sh)
> ```
> 两个脚本自带看门狗与结果核验（step2 会搭最小 git 演示项目、journal 状态打印、
> 交付分支提示）；模型不是 glm 时用 `PROVIDER=… MODEL=…` 环境变量覆盖。
> 以下手工版内容与脚本等价，供阅读理解：

> **测试 opencode-agentic-workflow（约 5 分钟）**
>
> 前置：已安装 OpenCode V2（`opencode` 命令可用、模型能正常对话）、Node 20+。
>
> **第 1 步**：随便建一个空目录，在里面创建 `opencode.json`，内容（model 换成你在用的）：
> ```json
> {
>   "plugins": [
>     {
>       "package": "@mickorz/opencode-agentic-workflow",
>       "options": {
>         "model": { "providerID": "glm", "id": "glm-5.3-flash" },
>         "agent": "build"
>       }
>     }
>   ]
> }
> ```
>
> **第 2 步**：在目录里运行：
> ```bash
> opencode run --model glm/glm-5.3-flash \
>   "调用 workflow 工具：flow=smoke, topic=Rust 内存安全。完成后报告输出。"
> ```
> 预期：几分钟后输出一份多角度分析 + 汇总报告。
>
> **第 3 步（可选，进阶）**：在你的某个 git 项目里加配置（再跑旗舰）：
> ```json
> {
>   "plugins": [
>     {
>       "package": "@mickorz/opencode-agentic-workflow",
>       "options": {
>         "model": { "providerID": "glm", "id": "glm-5.3-flash" },
>         "agent": "build",
>         "journalDir": ".agw/journal",
>         "traceDir": ".agw/trace",
>         "isolation": { "mode": "git-worktree" }
>       }
>     }
>   ]
> }
> ```
> 然后描述一个小需求，例如：
> ```bash
> opencode run "调用 workflow 工具：flow=feature-development（必须是这个 flow），topic=<一句话小需求>"
> ```
> 预期：分析→实现→测试→评审→审批全链，产物在 `agw/<runId>` 分支。
>
> **卡住了？** 先看 https://github.com/mickorz/opencode-agentic-workflow → docs/troubleshooting.md

## 反馈模板（每人一份，回传给作者即可）

```text
【环境】OS / opencode 版本 / 用的模型：
【A1 安装】成功？耗时？卡在哪：
【A2 smoke】成功？耗时？报告完整吗：
【A3 一句话】这和直接跟 AI 对话的区别是：
【A4】跑通后你想写自己的 workflow 吗？想用来做什么：
【摩擦点】（现象 / 你当时以为是什么问题 / 怎么解决的）：
【其他】任何吐槽：
```

## 已知预期行为（测试者可能误报，提前记录）

- 首次运行会从 npm 下载插件（OpenCode 自身缓存），需要网络
- feature-development 的 check 阶段会跑 `npm install`（几分钟属正常）
- 项目原本没有 lockfile 时，check 会新建 `package-lock.json` 并进入交付
  分支（合并时留意即可；主 agent 也会提醒。已在 Watching 跟踪）
- 交互审批弹窗只在 TUI 出现；`opencode run` 无 TUI 会 5 分钟超时拒绝
  （headless 测旗舰请加 `"checkpoint": {"mode": "auto-approve"}`，
  测试脚本 step2 已默认如此）
- 失败 run 会保留 worktree + `agw/<runId>` 分支（设计行为，供 resume/取证）

## 节奏与渠道

1. 作者把「测试者脚本」发给 5–10 人（同事/朋友/OpenCode 社区）
2. 收回反馈模板 → 逐条登记到下方摩擦清单
3. 摩擦分流：环境/文档类 → 当场修 Troubleshooting；产品信号 → P3-candidates Watching
4. 全部回收后：本文件归档结论，进度文档同步，决定下一步（P3 立项 or 继续收集）

## 摩擦清单（回填）

| # | 测试者 | 现象/原话 | 分类 | 处置 |
|---|---|---|---|---|
| （待回填） | | | | |
