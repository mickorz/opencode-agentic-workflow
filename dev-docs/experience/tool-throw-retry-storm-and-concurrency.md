# 工具抛错引发主 Agent 重试风暴，耗尽模型配额

日期：2026-10-03 ｜ 环境：opencode v2.0.22 + 免费档模型

## 问题现象

端到端验收时，workflow tool 因模型限流（429）抛错。主 agent 收到工具错误后**反复重试调用工具**：单次 `opencode run` 内重试约 10 次，多轮验证后子会话计数器达到 `workflow#91`——约 22 轮 × 4 个子会话，把免费档配额全部打光，后续所有模型（含更换 provider 的免费模型）都返回 `FreeUsageLimitError`。

## 排查过程

- 主会话输出里出现连续多行 `> build · <model>` 与同一工具调用反复执行。
- `GET /api/session` 列出大量 `outcome: failed` 的 workflow 子会话，编号连续递增。
- 子会话 context 显示 assistant `finish: "error"`、`error.type: "provider.quota"`。

## 根因

1. 工具 `execute` 抛错时，主 agent 把它当作「可重试的瞬时错误」，无上限地重新调用工具。
2. 每次 workflow = 3 并行子会话 + 1 汇总，全部命中限流也照样消耗配额（429 前的请求已计费/计数）。
3. 并发无上限：parallel 直接 `Promise.all`，叠加主会话请求超过 API 并发限制。

## 解决方案

1. **工具错误改返回文本，不抛错**：catch 后返回 `[agentic-workflow] workflow failed: <msg>`，主 agent 看到结果即停止重试并向用户报告。
2. **加并发信号量**：`withConcurrencyLimit(executor, 3)`（src/runtime/semaphore.ts），超限任务 FIFO 排队；当前模型 API 最多支持 3 并发。
3. 参数校验失败同样返回错误文本，避免校验类错误也被重试。

## 预防/注意事项

- 给 agent 暴露的工具，任何「环境性失败」（限流/网络/配额）都不要以异常抛出——主 agent 的重试策略不可控。
- 免费档配额是全局限的，换模型 ID 不一定能绕开（同一 provider 共享配额）。
- 验收脚本要控制重试次数：一次 run 失败后先查 `GET /api/session` 的 outcome 与 error，确认根因再重试，不要盲跑。
