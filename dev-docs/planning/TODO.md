# TODO

## 你侧操作项（Owner: Michael）

### 【BLOCKING v0.5.0】npmjs Trusted Publishing 表单重存 + 勾选「Allow npm dist-tag」（2026-10-08 升级为 blocker）

**目标形态（账号所有者拍板）**：只走 CI——「推 v* tag → GitHub Actions
OIDC 自动发布」，**不做本地发布**。仓库/CI 侧四项不变量已全部核对通过
（workflow 文件名 publish.yml / job 无 environment / repository.url 匹配 /
publishConfig public），且 OIDC 交换成功、PUT 到达 registry——**repo 侧
没有剩余动作，唯一缺口在 npmjs 账号侧的这张表单**（2026-10-08 05:59Z
rerun 探针复测：同一 PUT-404）。

**为什么紧急**：v0.5.0 tag 已推、CI OIDC publish 第 5 次 PUT-404。考古证明
**CI OIDC 从未成功过**（0.3.0/0.3.2/0.4.0 全是本地 publish 发的；此前
「表单修正后 rerun ✅」「72h 冻结」均为误诊，详见
`dev-docs/experience/npm-trusted-publishing发布排坑.md` 坑G）。TP 表单
是当前唯一嫌疑（另一个不可区分候选：恢复码再次使用触发真冻结——若最近
用过恢复码，需等 72h 且**绝不能再用**）。

**步骤**（npmjs.com → 包 `@mickorz/opencode-agentic-workflow` → Settings → Trusted Publishers）：

1. 逐字段核对既有条目（保存不做校验，填错静默通过）：

   ```text
   Provider:             GitHub Actions
   Organization or user: mickorz
   Repository:           opencode-agentic-workflow
   Workflow filename:    publish.yml        ← 只填文件名，不是 .github/workflows/publish.yml
   Environment:          留空               ← job 没声明 environment 就必须空着
   Allowed actions:      ☑ npm publish      ← 2026 起独立选项，默认可能只允许 stage publish
   ```

2. 勾选新增的 **`Allow npm dist-tag`**（2026-09-30 npm 变更，默认关；
   顺手勾上，未来 beta/rc 通道才可用）
3. 保存（re-save）；若字段本就全对仍失败 → **删除条目重建**（旧条目可能
   带不可见坏状态）
4. 弄好后告知，或自行执行：

   ```bash
   gh run rerun 37733685262 --failed   # v0.5.0 的失败 run，tag/版本不动
   ```

   之后所有版本回归目标形态：`npm version <patch|minor> && git push
   --follow-tags`，tag 上去即自动发布，无需任何手动步骤。

**详细排障**：`dev-docs/experience/npm-trusted-publishing发布排坑.md`
（E404 = 认证/表单不匹配；E422 = repository.url 不一致；CLI 侧要求 npm ≥ 11.21.0 / 12.2.0）

### 人工验收（待发布通后执行）

面板渲染 + 安装器交互路径手动验收——清单已备好：
`dev-docs/planning/手动验收-面板与安装器.md`（P-1…P-8 面板 / I-1…I-9 安装器）

## 已清空

- 功能开发队列：v1-parity backlog 全部闭环（最后两项：P2-10 Installer CLI、
  P2-13 Open Session 回放，见 `v1-parity-backlog.md`）
- 0.5.0 发布：**进行中**——tag `v0.5.0` 已推，等 TP 表单修复后 rerun（见上）
