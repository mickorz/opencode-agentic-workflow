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
