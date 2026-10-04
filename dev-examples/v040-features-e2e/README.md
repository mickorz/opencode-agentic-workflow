# v040-features-e2e —— v0.4.0 两项 Blocker 修复的一跑双验沙盒

**故意配置成「坏环境」**：`checkpoint: interactive`（复刻投毒现场的
init 状态）+ **不配隔离**（复刻 workspaceRoot 兜底缺失场景）。
config 本身会让旧版本必死：审批挂 5 分钟被拒 + artifact check 查错目录。
v0.4.0 里一次调用参数即可全链走通。

（此配置组合已在 2026-10-04 E2E A/B 双证；本目录是可复现的固化沙盒。）

## 跑法（在 dev-examples/v040-features-e2e/ 下）

```bash
opencode run --model glm/glm-5.3-flash \
  "调用 workflow 工具：flow=artifact, topic=写一段关于 workspace 抽象的设计笔记, checkpointMode=auto-approve（这个参数必须传）"
```

## 验证点（全绿 = 两项修复同时证明）

- **功能① checkpointMode 覆盖**：
  `.agw/trace/events.jsonl` 里 `checkpoint.waiting` 与
  `checkpoint.completed(approved:true)` **时间戳同毫秒**（interactive 门
  配置下若无参数，会静默 300 秒后被拒——别试，纯浪费五分钟）
- **功能② in-place workspaceRoot**：
  - `artifact.md` 落在**本目录**（修复前会写到 `~/artifact.md` 然后
    check 步骤在 HOME 找不到而失败）
  - journal：`completed` 且 steps 全 `completed`（check 通过 =
    workspaceRoot 解析正确）
  - `cat .agw/journal/*.json | grep -A3 workspace`：身份 `provider: "in-place"`，
    path = 本目录绝对路径
- 全程应 < 1 分钟（interactive 假死场景至少 300s+，对比明显）

## 对照组（可选，验证覆盖的「恢复」语义）

同目录再跑一次，参数换成 `checkpointMode=auto-reject`：
workflow 应在 checkpoint 步骤 failed（拒绝语义生效），journal 状态
`failed`，artifact.md 已写但 check 之后未继续——证明覆盖参数真实驱动
门的行为，而非摆设。

## 结束后

本目录为过程沙盒，验证通过后按 dev-examples 约定可删。
