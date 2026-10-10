# TODO

## Agent 侧待办（已确认要做，暂缓——2026-10-09 用户指示「先保存，后面再做」）

1. **批次 C（目标 0.9.0）**：全屏工作流视图 + j/k/Enter/Esc 键盘导航 +
   节点 Inspector（v1 nodeview 本体；detail RPC 数据已够用）。
   清单：`dev-docs/research/v1-v2-TUI显示功能对比与补齐清单.md` §5
2. **批次 D（目标 0.10.0）**：journal 记 prompt 摘要 / attempt / timeout 上限，
   Inspector 信息补全（重试进度 `(2/3)`、超时 `10s/1m`、缓存回放标记）。
   动持久化格式，需旧 journal 兼容
3. ~~**小事**：testworkflow 的 `keyword-report.mjs` 汇总行 `undefined` 变量引用
   bug~~（**已消除 2026-10-10**：用户清空 testworkflow/flows 全部 `.mjs`，
   文件不存在，问题随之消失）
4. **批次 E（并入 0.9.0，随批次 C 发版）**：装载器单形态化——移除
   `.mjs` / `.cjs` / defineWorkflow 模块的装载路径，放入 flows 即
   fail-loud 并指引改写为 js 脚本；同步更新 loader 测试与 README
   （用户决策 2026-10-10「mjs 形态直接删除」的代码层落地；breaking）

> 前置 ✅ 已解决（0.7.1，2026-10-09）：「重启后面板没默认打开」根因是宿主
> 2.0.26 的会话作用域 slot（主页零挂载），非插件故障。已补 `home.footer.status`
> 主页常驻行并 PTY 无头验证。坑与证据：
> `dev-docs/experience/宿主2.0.26会话作用域slot-主页无挂载点.md`。
> **批次 C 设计修正**：全屏视图走 `ui.router` 全局路由（session.panel
> fullscreen 是会话作用域，主页进不去）。
> **0.8.0 已被占用**（2026-10-09）：v1 脚本（opencode-dynamic-workflows
> 魔法全局 + 顶层 return）原生装载——用户产品决策「我就是要使用 v1 的 js
> 不要给我改成 mjs」。实现 `src/workflows/legacy-script.ts` + recorder
> `appendStep` 动态步骤；dist E2E：v1 examples 的 smoke-test.js 逐字原样
> 放 flows/ 跑通，journal `smoke_test@1.0.0 · completed · 3 步`。
> **2026-10-10 用户决策升级：「流程唯一形态 = v1 js 脚本」**——skill
> （workflow-authoring）重写为单形态（不再教 .mjs / defineWorkflow，
> 选型段删除）；testworkflow 存量 8 个 `.mjs` 随 flows 目录清空删除。
> 装载器对 .mjs/.cjs/defineWorkflow 的技术支持暂留至 0.9.0 一并移除
> （用户已拍板，见 Agent 侧待办 #4）；
> 新 skill 需发版（npm 0.8.3+）并重启 opencode 刷新包缓存后才到达用户会话。

## 你侧操作项（Owner: Michael）

### ~~【BLOCKING v0.5.0】npmjs TP 条目删除重建 + 推新 tag~~ ✅ **已解决（2026-10-08 08:57Z，0.5.0 上架）**

**结局**：TP 条目经 `npm trust` CLI 重建（login → list 空 → 直接创建，权限
publish + stage publish）→ 移 `v0.5.0` tag 重推 → run `37753094523` 全绿
（32s）→ **provenance 签名出现（OIDC 真实走通）** → registry 0.5.0 latest，
bin 完好。CI-only 发布链路端到端验证通过；TP 条目完成首次成功发布，
**已转「validated」，永久豁免 48h 过期**（除非改仓库/身份）。

今后发布就两条命令，无需任何手动步骤：

```bash
npm version <patch|minor> && git push --follow-tags
```

踩坑全记录：`dev-docs/experience/npm-trusted-publishing发布排坑.md`（坑A–H）。

### 人工验收（已解锁——0.5.1 起面板可用，见下方修复记录）

> **0.5.0 → 0.5.1 修复（2026-10-08 晚）**：0.5.0 的 TUI 入口在真实宿主里
> **从未加载成功过**（`Keymap.Provider is missing`，坑见
> `dev-docs/experience/tui插件keymap与peer打包.md`）——E2E 全走
> `opencode run`（role=server），从未覆盖 role=cli。0.5.1 修复
> keymap 挂载点 + opentui/solid-js 改 peer 打包。**P 组用例请在 0.5.1
> 上执行**；I-1 记录的安装体验不受影响。
>
> **0.5.2（2026-10-09）**：TUI 面板对齐 v1 默认行为——新 run 启动自动打开
> （每 runId 一次；手动关闭后本 run 不再打扰）。
>
> **0.6.0（2026-10-09）产品决策**：声明式 JSON 流程 + `workflow_define`
> 下线，自定义流程只留代码（JS 模块）形态；顺带修复 `<pkg>/core` 裸说明符
> 在用户目录解析不了的 P2-14 文档债（装载器重写为插件自身绝对路径），
> 并给 flows/ 目录零配置缺省装载。坑与决策：
> `dev-docs/experience/声明式JSON下线与core裸说明符解析坑.md`。
> **P 组后续用例在 0.6.0 上执行**；旧 JSON 流程需改写为 .mjs（skill 内
> 有映射表）。

面板渲染 + 安装器交互路径手动验收——清单已备好：
`dev-docs/planning/手动验收-面板与安装器.md`（P-1…P-8 面板 / I-1…I-9 安装器）

## 已清空

- 功能开发队列：v1-parity backlog 全部闭环（最后两项：P2-10 Installer CLI、
  P2-13 Open Session 回放，见 `v1-parity-backlog.md`）
- 0.5.0 发布：**✅ 完成（2026-10-08 08:57Z）**——CI OIDC 链路验证通过，
  含 P2-14 代码流程 + 坑H 全部修复；后续发布仅 `npm version` + push tag
