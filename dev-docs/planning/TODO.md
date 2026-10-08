# TODO

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

面板渲染 + 安装器交互路径手动验收——清单已备好：
`dev-docs/planning/手动验收-面板与安装器.md`（P-1…P-8 面板 / I-1…I-9 安装器）

## 已清空

- 功能开发队列：v1-parity backlog 全部闭环（最后两项：P2-10 Installer CLI、
  P2-13 Open Session 回放，见 `v1-parity-backlog.md`）
- 0.5.0 发布：**✅ 完成（2026-10-08 08:57Z）**——CI OIDC 链路验证通过，
  含 P2-14 代码流程 + 坑H 全部修复；后续发布仅 `npm version` + push tag
