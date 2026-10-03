# opencode run 无响应挂起：预检模型 + 看门狗超时的验收实践

日期：2026-10-03 ｜ 环境：macOS（无 timeout 命令）、opencode v2.0.22

## 问题现象

`opencode run` 在以下情况会**永久无响应**（无输出、不退出）：

1. 子会话卡在工具执行（如递归 workflow 死锁、等待永远不会到来的权限批准）；
2. `session.wait()` 等待的会话永远不进入空闲态；
3. 模型 API 限流时的部分重试路径。

直接裸跑验收命令会把终端/CI 卡死，且无法区分「慢」和「死」。

## 解决方案

**第一层：模型预检。** 跑完整工作流前，先用最小 prompt 确认模型可用（30–60s 超时）：

```zsh
(opencode run --model glm/glm-5.3-flash "只回复 ok" 2>&1 | tail -2) & pid=$!
( sleep 60; kill $pid 2>/dev/null ) & wd=$!
wait $pid; kill $wd 2>/dev/null
```

预检不过（限流/配额耗尽）就直接换模型或终止验收，不要进入完整流程——
每次完整 workflow 失败也会烧掉 3+ 个子会话的配额。

**第二层：看门狗超时。** macOS 没有 `timeout`（coreutils 的 `gtimeout` 也未必装），
统一用「后台运行 + sleep 后 kill」的看门狗模式包住 opencode run：

```zsh
(opencode run --model <model> "<完整验收提示>" 2>&1 | tail -60) & pid=$!
( sleep 480; kill $pid 2>/dev/null ) & wd=$!   # 8 分钟看门狗
wait $pid; rc=$?; kill $wd 2>/dev/null; echo "exit=$rc"
# exit=143(SIGTERM) = 看门狗击杀 = 挂起，进入诊断流程
```

**挂起后的诊断顺序：**

1. `GET /api/session` 找 outcome 为空的会话（卡住的）；
2. `GET /api/session/{id}/context` 看 assistant 的 tool part：
   `executed: false` + `state.status: "running"` = 卡在工具执行，input 能看到它调了什么；
3. `finish: "error"` + `error.type: "provider.quota"` = 模型配额问题，不是代码问题。

## 预防/注意事项

- `exit=143` 且零输出 = 看门狗击杀，不要重跑，先查 API 定位卡点。
- 任何「会创建子会话/长任务」的验收都必须带超时；重跑前先确认上次失败根因。

## 2026-10-03 补充：看门狗杀不干净 + 极端模型延迟

**坑 1：子壳 PID 模式杀不掉 opencode 本体。**
`(opencode run ... | tail -N) & pid=$!` 里 `$pid` 是子壳，`kill $pid`
只杀子壳，opencode 进程变孤儿继续跑（实测又跑了 15+ 分钟，还把 journal 写完了）。
同时 `tail` 抓着管道，`wait` 表现不稳定，可能拖到外层超时。

正确姿势——**直接 PID + 输出落文件 + 杀进程树**：

```zsh
opencode run --model <model> "<提示>" > run.out 2>&1 & pid=$!
( sleep 600; pkill -P $pid 2>/dev/null; kill $pid 2>/dev/null ) & wd=$!
wait $pid; rc=$?; kill $wd 2>/dev/null; tail -25 run.out
```

要点：不套子壳/管道；`pkill -P $pid` 先杀子进程再杀本体；输出进文件，
进程死了文件还在。

**坑 2：预检通过 ≠ 延迟正常。** 同一天预检 3 秒返回 ok，随后同模型的
单次 agent 调用耗时 **15.6 分钟**（服务端排队/限流重试）。预检只验证
「可用性」，不验证「延迟」。完整 workflow 的看门狗要按最坏情况给
（4 agent 链 ≥ 20 分钟），或干脆不依赖 stdout——**journal + traceDir
落盘文件天然免疫进程被杀**，事后取证优先读它们：

- `<journalDir>/<runId>.json`：步骤状态/时间戳/累积状态（被杀的 run 停在 running/failed）；
- `<traceDir>/events.jsonl`：事件流（agent.started 有 time，可直接算每步耗时）；
- 主会话工具结果原文：`sqlite3 ~/.local/share/opencode/opencode.db
  "SELECT data FROM session_message WHERE data LIKE '%<runId>%'"`
  （含失败文本与恢复提示，比 stdout 可靠）。

**意外的正面结论：** durable 设计让「被杀的 run」不再是废数据——
journal 里 completed 的步骤在恢复时直接跳过（跨目录/跨服务共享
journalDir 即可 resume），等于每次挂起事故都是一次免费的 durability 演练。
