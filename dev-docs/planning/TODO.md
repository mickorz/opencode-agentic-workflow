# TODO

## 你侧操作项（Owner: Michael）

### 【BLOCKING v0.5.0】npmjs TP 条目删除重建（48h 规则）+ 推新 tag（2026-10-08 深挖后改写）

**目标形态（账号所有者拍板）**：只走 CI——「推 v* tag → GitHub Actions
OIDC 自动发布」，不做本地发布。

**2026-10-08 晚间定案**（外部分析提示 + 官方文档核实 + run 日志实锤，
详见排坑文档**坑H**）：此前「repo 侧无剩余动作、只差表单」的判断**错误**。
真凶三个、互相独立、逐一都足以挡死发布：

1. ~~setup-node `registry-url` 占位 `_authToken` 行 → npm 从未走过 OIDC~~
   **✅ 已修**（publish.yml 去掉 registry-url + 防御性 sed 清理；run
   37733685262 日志实证：全程零 OIDC/provenance 痕迹，275ms 内 E404）
2. ~~bin 路径 `./` 前缀被 npm 11 打包删除（0.5.0 会是无 CLI 残包）~~
   **✅ 已修**（`npm pkg fix` → `dist/cli/index.js`，dry-run 复验无警告）
3. **TP 条目已按 48h 规则过期（2026-10-02 npm 新政）→ 只能删除重建**：
   新建配置 48h 内无成功发布即失效，**仍显示在设置页但不可用，普通编辑
   不重置窗口**。本包条目建于 10-03 前后、CI 零成功 → 早已是尸体。
   这解释了「字段核对全对却一直 404」的僵局

**你侧唯一动作**（npmjs.com → 包 `@mickorz/opencode-agentic-workflow`
→ Settings → Trusted publishing）：

1. **删除**现有条目（不要编辑重存——无用）
2. **重建**，逐字段：

   ```text
   Provider:             GitHub Actions
   Organization or user: mickorz
   Repository:           opencode-agentic-workflow
   Workflow filename:    publish.yml        ← 只填文件名（含 .yml 扩展名）
   Environment:          留空               ← job 没声明 environment 就必须空着
   Allowed actions:      ☑ npm publish      ← 2026-05-20 后新建必须显式勾选
   ☑ Allow npm dist-tag                     ← 顺手勾上，未来 beta/rc 通道可用
   ```

   CLI 等价（terminal 里跑，首次需 2FA）：
   `npm trust github @mickorz/opencode-agentic-workflow --file publish.yml --repo mickorz/opencode-agentic-workflow --allow-publish -y`
3. **48h 倒计时立即开始**——弄好后马上告诉我，我推 tag 触发首跑完成验证

**为什么不能 rerun 旧 run**：GitHub Actions 重跑用原 commit 的 workflow
定义，publish.yml 的修复对 rerun 不可见（坑H 第 4 条）。必须推新 tag：
v0.5.0 从未发布过 → 允许把 tag 移到修复后的 commit 重推（含 P2-14 代码
流程 + 两处修复），0.5.0 一次发全；或直接 `npm version patch` 升 0.5.1。

**详细排障**：`dev-docs/experience/npm-trusted-publishing发布排坑.md`
（坑A–H 全链；判别第一步：失败日志 grep `provenance|oidc`，零命中 =
没走 OIDC，先查 repo 侧 .npmrc/registry-url，别先怪表单）

### 人工验收（待发布通后执行）

面板渲染 + 安装器交互路径手动验收——清单已备好：
`dev-docs/planning/手动验收-面板与安装器.md`（P-1…P-8 面板 / I-1…I-9 安装器）

## 已清空

- 功能开发队列：v1-parity backlog 全部闭环（最后两项：P2-10 Installer CLI、
  P2-13 Open Session 回放，见 `v1-parity-backlog.md`）
- 0.5.0 发布：**进行中**——repo 侧三凶已修两（registry-url 占位行 / bin
  路径），剩 TP 条目删除重建（48h 窗口）+ 推新 tag 触发（rerun 无效，见上）
