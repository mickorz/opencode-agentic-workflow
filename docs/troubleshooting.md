# Troubleshooting

> 面向使用者的高频问题。都来自真实踩坑（开发记录见 `dev-docs/experience/`）。

## 改了插件代码但不生效

**症状**：修改/重新构建了本仓库 dist，但 opencode 里行为没变。

**原因**：插件只在 **opencode service 启动时**加载一次，之后代码被缓存。

**解法**：完全退出并重启 opencode（在项目目录重新启动）。

## npm 包名形式的插件「不是我本地的版本」

**症状**：`"package": "@mickorz/opencode-agentic-workflow"`（npm 包名形式），
本地 dist 改了、甚至项目 node_modules 里有新版本，加载的却还是旧版
（例如工具列表里缺新 workflow）。

**原因**：OpenCode 对 **npm 包名形式**的插件走**自己的缓存**，按 registry
版本安装——**项目 node_modules 完全不参与解析**：

```text
~/.cache/opencode/npm/@<scope>/<pkg>@latest/<时间戳>/node_modules/<pkg>
```

**解法**：

- 开发期/试用未发布能力：改用**相对路径**引用本机构建产物
  ```json
  { "package": "<到本仓库的相对路径>/dist/plugin" }
  ```
  （相对路径按项目目录解析；本仓库重新 build 后，重启 opencode 即生效）
- 强制刷新包名形式的缓存：
  ```bash
  rm -rf ~/.cache/opencode/npm/@<scope>
  ```
  然后重启 opencode（若有服务在跑，删除可能报 "Directory not empty"，重试即可）

## 包名形式 vs 相对路径，怎么选

| 场景 | 用什么 | 理由 |
|---|---|---|
| 日常使用已发布版本 | 包名 `@mickorz/opencode-agentic-workflow` | 拿 registry 稳定版 |
| 试用/开发未发布能力 | 相对路径 `…/dist/plugin` | 包名形式永远解析 registry 版本，本地改动无效 |
| 本仓库示例/联调 | 相对路径 `../../dist/plugin` | 同上（examples/ 与 dev-examples/ 的既定约定） |

## checkpoint 卡住 5 分钟然后被拒绝

**症状**：interactive 审批模式下，workflow 到审批步骤后静默约 5 分钟，
报 `checkpoint rejected ... (no interactive reply within 300000ms (no TUI attached?))`。

**原因**：interactive 门等待 TUI 弹窗应答；经 `opencode run` 等无 TUI 的方式
调用时没人应答，300s 超时按 reject 安全失败。

**解法**：

- 交互体验请用 TUI（`opencode` 交互模式启动，弹窗会出现）
- headless / 脚本场景把配置改为
  `"checkpoint": { "mode": "auto-approve" }`

## 失败的 run 留下了 worktree 和分支

**现象**：`<repo>-worktrees/` 目录与 `agw/<runId>` 分支残留，分支带 `+` 标记。

**说明**：这是**设计行为**——失败的 run 保留现场供取证与 resume（cleanup 默认
`on-success`）。分支永远不会被自动删除。

**处理**：

- 想续跑：`resumeRunId="<runId>"`（已完成步骤跳过）
- 想清理：
  ```bash
  git worktree remove <worktrees-dir>/<runId>
  git branch -D agw/<runId>
  ```

## verify 报 "could not be completed: reviewer returned invalid structured output"

**含义**：reviewer 的输出没解析成 JSON（协议失败），**不是评审否决**——
产物没有被判不合格，只是这次评审没完成。

**解法**：直接 `resumeRunId="<runId>"` 重试 verify（completed 步骤跳过，
只重放失败的 verify）。v0.3.1 起解析失败会自动局部重试（默认 2 次），
此类报错已大幅减少；语义否决（`verify failed: ... (#N: 理由)`）才是真的
被拒，需要改产物。

## workflow 中途失败，白跑了吗

没有。journal（配置 `journalDir` 后）记录每步状态与累积 state；失败步骤之后的
内容重跑，**completed 前缀全部跳过**。工具返回的报错里带 `runId`，用
`resumeRunId="<runId>"` 恢复即可。
