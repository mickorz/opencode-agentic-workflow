# v1 对 v2：TUI 显示功能对比与补齐清单

**日期**：2026-10-09　**对比对象**：
- **v1** = `opencode-dynamicworkflows` 0.11.2（`~/Desktop/WorkProjects/opencode-dynamicworkflows`，@opencode-ai/plugin 1.18.x + @opentui/solid 全功能 TUI）
- **v2** = `opencode-agentic-workflow` 0.6.4（本仓库，@opencode/plugin 2.x + 行式面板）

**结论摘要**：v1 有 **4 个 UI 面**（侧边栏树 / 输入框状态条 / 全屏工作流路由 / 节点详情
Inspector），v2 只重建了其中 1 个面的简化版（session.panel 行式面板，另新增 checkpoint
弹窗）。缺口共 **19 项**，已逐一核对 v2 宿主 API（`@opencode/plugin` 2.0.22 类型）：
**全部可补**——sidebar.content / prompt.footer / router / keymap / ctx.theme /
session.panel fullscreen 均已开放。缺口的根因不是宿主限制，是 v2 迁移时
「TUI 等于重写」（v1 仓库 V2_MIGRATION_ANALYSIS.md §5.8 原话）只做了最小集。

---

## 1. 架构对照（缺口的根因）

| 维度 | v1 | v2 当前 |
|------|----|---------|
| 渲染技术 | @opentui/solid + solid-js 全功能组件（box/scrollbox/颜色/鼠标/焦点） | solid-js 但只用 `<box><text>` 摆纯文本行 |
| 数据通道 | **同进程直读**：宿主 store 镜像 + 快照文件 + journal 文件（TUI 自己 1s 轮询 + 4 事件桥） | **RPC/事件流**：server 侧 ProgressBoard → snapshot RPC 初始同步 + PROGRESS_EVENT 增量 + detail/session RPC 按需 |
| 路由 | `api.route.register` 两条全屏路由（工作流列表 + 节点详情） | 未用（v2 有 `ctx.ui.router`） |
| 键位 | `api.keymap.registerLayer` focus 作用域层（j/k/Enter/Esc/left/right） | 仅一条 global 命令（/workflow 开面板） |
| 主题 | `api.theme.current` 四色调（success/warning/error/muted）上色 | **完全无色**（默认前景色一路到底） |
| 插件拓扑 | 单插件双入口（server+tui 同包 exports["./tui"]） | 同样双入口（agentic-workflow + agentic-workflow-tui）✓ |

> v2 的 RPC 分离是**架构升级**（TUI 崩不垮 server、旧 server 可降级），保留；
> 缺的是显示层没有把 v2 API 用满。

---

## 2. v1 四个 UI 面特性清单（源码：v1 `src/tui/plugin.tsx` 932 行）

### 2.1 侧边栏进度树（sidebar_content slot，order:350，L866-877）

| 特性 | 细节 | 源码位 |
|------|------|--------|
| 多 run 树同显 | 每棵 run 一块，独立折叠 | L356-377 |
| 树折叠开关 | 标题行点击 ▶/▼（嵌套用 ▸/▾），按 会话\|run 缓存 | L215-233, L253-257 |
| 标题行信息 | `name (done/total \| N running) \| X.Xk tok \| runId` | workflow-store L328-334 |
| phase 分组行 | 分组标题 + **分组耗时**（running 递增/完成定格） | L281-295 |
| 子流程分组行 | 粗体标题 | L261-269 |
| 组合节点分组行 | `[Sequence]`/`[Fallback]`/`[Race]` 粗体中括号 | L271-279 |
| 节点行 | 状态图标（○待/◐跑/●成/■败）**按主题色上色** + label + 重试进度 `(2/3)` + 运行时长带超时上限 `10s/1m` + token（9.9K 大写缩写）+ `·缓存` 回放标记 | L56-67, L296-320 |
| 错误行 | 失败节点下方 `↳ error`（muted） | L321-332 |
| 嵌套子 run | 子代理会话触发的 run 递归挂触发节点下（缩进一级） | L333-346 |
| 节点点击 | 鼠标点节点 → 节点详情路由 | L301-310 |
| 实时刷新 | 全局单 1s 轮询 + 4 事件桥（30ms 去抖）+ viewKey 差分 | L104-213 |

### 2.2 输入框右侧状态条（session_prompt_right slot，L852-864）

- 每个运行中 workflow 一行：`◐ workflow name done/total · N running`（warning 色）
- 打字时可见后台进度——不需要开任何面板

### 2.3 全屏工作流路由（/workflow 命令 + WORKFLOW_ROUTE，L398-564）

| 特性 | 细节 |
|------|------|
| 全屏接管 | 100% 宽高 + 主题背景色 |
| 头部摘要条 | `Workflow N 个 run` + 每 run 一枚状态片（name status · done/total · N running · N failed） |
| 多树平铺 + 深度缩进 | 嵌套子 run 按 depth 递增缩进 |
| **键盘导航** | j/k（up/down）跨树选择，选中行 `▸` 标记 +背景高亮 |
| 滚动跟随 | 选中越屏 scrollChildIntoView |
| Enter 进节点详情 | 节点行带 `[Enter 详情]` 标记 |
| Esc/q 返回 | 记录来源路由，返回原处（session/home） |
| 底部键位提示行 | `j/k 上下选择 · Enter 节点详情 · Esc 返回` |

### 2.4 节点详情 Inspector（NODE_DETAIL_ROUTE，L573-850）——即 nodeview

| 区域 | 内容 |
|------|------|
| 状态头 | 图标 + **粗体 label** + status + `第 N 次执行`（attempt>1）+ `缓存回放` 标记 |
| 执行元数据 | `agent explore · model xxx · 1m02s · 12.3K tok (in 9.9K / out 2.4K)` |
| 标识符行 | `session ses_xxx · run runId · exec xxx` |
| **prompt 预览** | 截 512 字节 |
| **Result 正文** | scrollbox 滚轮滚动 + 自动折行；三空态（error/pending/empty）+ `（快照预览，journal 未写入完整结果）` 来源徽标 + **截断提示含原始大小**（`Result truncated, original size: 12.3 KB`） |
| 数据双通道 | 快照信号（1s 轮询）+ journal 按需读（diff 守卫 + 状态翻转立即重读）；快照被清后由 journal 元数据**合成节点视图**（历史 run 仍可看） |
| 键位 | `Enter/o` Open Session 跳子会话 · `left/right` 切相邻 agent 节点 · `Esc/up/q` 返回 |

---

## 3. v2 当前面板特性清单（src/plugin/tui.tsx 264 行 + progress-view.ts 336 行）

| 已有 | 细节 |
|------|------|
| session.panel 面板 | /workflow 命令 + 新 run running 时自动弹出（手动关闭尊重） |
| run 列表 | 最多 50 条；顶层一行 `▶ id@version  时长`；最新 1 条展开步骤 |
| 步骤行 | `·/▶/✓/✗/–` 图标 + 名 + 时长 |
| subflow 血缘 | 子 run 缩进 `↳` + `⇢ subflow` 标记（depth≤3）——**run 级**嵌套（与 v1 的 agent 会话级嵌套模型不同） |
| `── detail` 区 | 最新 run：头行（图标 id@version · status · 时长）+ runId/parent/depth/args + 逐步骤（图标 名 时长 · **X tok · model**）+ 输出/错误预览（3 行折行） |
| `── session` 区 | 最新 run 最后一个带会话步骤的**消息回放**（❯ 问 / · 答，24 行预算）——v1 没有的内嵌形态 |
| checkpoint 弹窗 | ui.dialog.confirm 批准/拒绝——**v2 新增**（v1 走 permission 体系） |
| 空态 | `(no runs yet — start one with workflow_start)` |
| 数据面 | snapshot RPC + PROGRESS_EVENT 全量快照流 + detail/session RPC（runId@status 去重 + 竞态守卫） |

---

## 4. 缺口对照表（v1 有 → v2 现状 → 补齐可行性）

| # | v1 特性 | v2 现状 | v2 宿主 API | 数据面 | 批次 |
|---|---------|---------|-------------|--------|------|
| 1 | **主题色/状态色** | 无色 | `ctx.theme: ResolvedTheme` ✓ | 无需 | **A** |
| 2 | run 头行 token 合计 | 无（token 只在 detail 区） | — | 快照 steps 需加 usage（事件面扩展） | **A** |
| 3 | 头行 running 计数 `N running` | 无 | — | steps.status 可算 ✓ | **A** |
| 4 | 每步 tokens/model 进列表行 | 只在 detail 区 | — | 同 #2 | **A** |
| 5 | 粗体标题/分组 | 无 | `<b>` ✓ | 无需 | A |
| 6 | 输入框状态条 | 无 | `prompt.footer(.status)` slot ✓ | 现有事件流即可 | **B** |
| 7 | 侧边栏常驻树 | 无（只有 panel） | `sidebar.content` slot（带 sessionID）✓ | 现有事件流（按 session 过滤需 run↔session 关联，先全量紧凑树） | **B** |
| 8 | 全屏工作流视图 | 无 | `ui.panel` 支持 `"fullscreen"` presentation ✓ / `ui.router` ✓ | 现有 | **C** |
| 9 | 键盘导航 j/k/Enter/Esc | 无 | `ctx.keymap` 响应式层 ✓ | 现有 | **C** |
| 10 | 选中高亮 + 滚动跟随 | 无 | box 背景/scrollbox ✓ | 现有 | C |
| 11 | **节点详情 Inspector** | 无（detail 区是纯文本块） | 路由或全屏面板 ✓ | detail RPC 已含 output/error/usage/model ✓ | **C** |
| 12 | Inspector：in/out token 拆分 | 无 | — | detail usage 三元组已有，拆开显示即可 ✓ | C |
| 13 | Inspector：prompt 预览 | 无 | — | **journal 未记 prompt**——需 recorder/journal 扩展 | D |
| 14 | Inspector：attempt 次数 | 无 | — | journal 未记 attempt（retries 存在但未落盘） | D |
| 15 | Inspector：Open Session 跳转会话 | 内嵌回放（不同取舍，保留） | — | — | 不补 |
| 16 | 重试进度 `(2/3)` / 超时上限 `10s/1m` / `·缓存` | 无 | — | 同 #14（D 批数据面） | D |
| 17 | phase 分组行 + 分组耗时 | 无（steps 平铺） | — | v2 无 phase 概念（stepNames 平铺）——**语义差异，不补**，用步骤时长对位 | 不补 |
| 18 | `[Sequence]/[Fallback]/[Race]` 组合节点分组 | 无 | — | v2 JS 流程里组合原语在 run() 内部，不经 stepNames——**语义差异，不补** | 不补 |
| 19 | v1 式 agent 会话级嵌套树 | run 级 subflow 嵌套 | — | 模型不同（v2 step=业务步，v1 node=agent 调用）；session 区已给回放 | 不补 |

**判定汇总**：可补 16 项（A 批 5 / B 批 2 / C 批 5 / D 批 3 + 数据面），语义差异不补 3 项。

---

## 5. 补齐排期（建议）

> **进度**：批次 A+B 已随 **0.7.0** 发布（commit a72f652）——主题四档语义色、
> 头行 N running + token 合计、步骤行 token/模型后缀、prompt.footer 状态条、
> sidebar 紧凑树。**0.7.1 补 home.footer.status 主页常驻行**（宿主 2.0.26 实测：
> sidebar/prompt.footer/session.panel 全是会话作用域，主页唯一挂载点是
> home.footer——坑见 `dev-docs/experience/宿主2.0.26会话作用域slot-主页无挂载点.md`）。
> 剩余：批次 C（0.8.0，全屏视图须走 ui.router 全局路由而非 session.panel
> fullscreen）、批次 D（0.9.0）。

- **批次 A（信息密度 + 上色，先做）**：#1-#5。改动集中在 progress-view.ts（行模型
  从 `string[]` 升级为带 tone/粗体的结构行）+ tui.tsx 渲染 + 事件面 steps 加
  `usage`/`model`（RunProgressSnapshot 扩展 + RPC parse + server 侧 board/recorder
  发射）。纯显示增强，风险低。
- **批次 B（两个新 slot）**：#6 prompt.footer 状态条（running runs 单行摘要）、
  #7 sidebar.content 紧凑树。都是「不开面板也能看见」的常驻可见性。
- **批次 C（全屏 + 导航 + Inspector）**：#8-#12。session.panel fullscreen 或
  router 注册全屏视图；keymap focus 层 j/k/Enter/Esc；节点详情=step 粒度
  （detail RPC 数据已够），布局按 v1 Inspector 三段式（状态头/元数据/正文）。
- **批次 D（数据面补全）**：#13-#16。journal schema 加 prompt 摘要 / attempt /
  timeout 上限，detail RPC 透出。动持久化格式，需迁移兼容（旧 journal 无新字段
  要能读）。

每批独立发版，A/B 可合并为 0.7.0，C 为 0.8.0，D 为 0.9.0。

---

## 6. 附：本次核对过的 v2 宿主能力证据

`@opencode/plugin` 2.0.22 `dist/tui/context.d.ts`：
- L150-180 `SlotMap`：`prompt.footer(.status/.file)`、`session.composer.top`、
  `session.panel`、`sidebar.content`、`sidebar.footer`（各带 input 类型）
- L137 `PanelPresentation = "panel" | "fullscreen"`
- L393 keymap 响应式层（组件/响应式上下文内创建）
- L418-435 `ui.dialog/toast/router/panel`
- L487-492 `ctx.theme: ResolvedTheme` + `themeMode`
