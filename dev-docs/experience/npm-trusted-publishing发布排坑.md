# npm Trusted Publishing（OIDC 自动发布）排坑记

**日期**：2026-10-04（v0.3.2 成功 ✅）；2026-10-04 下午追加坑 F（v0.4.0 被拒案）
**适用**：`.github/workflows/publish.yml`（tag → CI → npmjs OIDC 发布）

## 症状与排坑路径（5 次尝试）

| # | 状态 | 症状 | 根因 |
|---|---|---|---|
| 1-3 | setup-node@v5 | `E404` + env 有 `NODE_AUTH_TOKEN: XXXXX-XXXXX-XXXXX-XXXXX` | **坑A**（见下） |
| 4a | 去掉 registry-url | `ENEEDAUTH`，npm 不尝试 OIDC | **坑B** |
| 4b | v6 + guard 清空 token | `ENEEDAUTH` 依旧 | **坑C**（v6 没修） |
| 5 | setup-node@v7 + 官方模板 | `E404`（env 干净） | **坑D**：TP 表单不匹配 |
| 5' | 表单修正后 rerun | ✅ published 0.3.2 | — |

## 坑 A：setup-node ≤ v6 注入占位 NODE_AUTH_TOKEN（本源坑）

`registry-url` 存在时 setup-node 写 `.npmrc`（`_authToken=${NODE_AUTH_TOKEN}`）
并**导出字面量占位符** `NODE_AUTH_TOKEN=XXXXX-XXXXX-XXXXX-XXXXX`
（actions/setup-node#1440，v7 才移除）。npm 以为已有凭证 → **跳过 OIDC
trusted-publisher 交换** → 拿假 token 发布 → registry 以 404 拒绝
（scoped 包的 404 = 无权限的伪装形态）。

**识别要点**：
- 日志 env 块出现 `XXXXX-XXXXX-…` 是**字面量**（GitHub 掩码真 secret 用 `***`）
- npm/cli#9088：trusted publishing 失败报**误导性** 404/ENEEDAUTH，都不能按字面理解

**修复**：`setup-node@v7`（从源头不再注入）。

## 坑 B：去掉 registry-url 不是解法

无 registry-url → npm 完全无凭证 → 直接 `ENEEDAUTH`，**也不会**自动 OIDC。
官方模板本来就带 registry-url，别绕。

## 坑 C：v6 仍在注入；手动清空成空字符串也不行

v6 并未修复 #1440（我误判 issue 关闭=已发布到 v6）。guard 把 token 清成
空字符串后依旧 ENEEDAUTH——空串 token 仍占据凭证位，OIDC 不接管。
**结论：不要给旧版打补丁，直接上 v7，删掉 guard。**

## 坑 D：GitHub 侧全对仍 404 = npmjs.com 表单不匹配

OIDC claims 与 Trusted Publisher 配置逐字段精确匹配，任一不符即拒：

```text
Provider:             GitHub Actions
Organization or user: mickorz
Repository:           opencode-agentic-workflow
Workflow filename:    publish.yml        ← 只填文件名，不是 .github/workflows/publish.yml
Environment:          留空               ← job 没声明 environment 就必须空着
Allowed actions:      ☑ npm publish      ← 2026 起独立选项！默认可能只允许 npm stage publish
```

**npm 保存 TP 配置时不做任何校验**（官方文档明示），填错静默保存。
本次最终修复动作 = 表单勾上 `Allowed actions: ☑ npm publish` 后 rerun 即过。

## 坑 E（顺带）：轻量 tag 不会被 --follow-tags 推送

`git tag v0.3.2`（轻量）+ `git push --follow-tags` = **什么都不推**。
`--follow-tags` 只带 annotated tag。用 `git tag -a` 或 `npm version`
（它打的就是 annotated），或显式 `git push origin v0.3.2`。

## 坑 F：恢复码登录 → 72 小时发布冻结（v0.4.0 被拒案，2026-10-04）

**症状**：表单已修好、v0.3.2 成功过、workflow 一字未改，次日 v0.4.0
两次 PUT 均被拒：

```text
npm error 404 Not Found - PUT https://registry.npmjs.org/@mickorz%2f...
npm error 404 The requested resource '...@0.4.0' could not be found
             or you do not have permission to access it.
```

**判别链**（从「又一坑」到根因，全程可复用）：

1. **PUT-404 ≠ 交换-404**：坑 A/D 是 token 交换失败；本例 tarball 已
   打包、OIDC 交换成功、**PUT 发布被拒** = 换到的凭证被判定无发布权限。
   npm 用 404 防探测（社区已有「valid OIDC 被拒无任何日志」的抱怨）。
2. **workflow 侧排除**：与成功 run 逐行 `comm` 对比日志 = 零差异
   （同 node v24.21.0、同触发、同管线）。node/npm 版本必查（setup-node
   不锁版本，小版本漂移是常见变量），本例一致 → 锁定 registry 侧。
3. **npm 状态页**：全绿（按账号策略冻结≠事故，状态页不会显示）。
4. **时间线 + 用户确认**：成功与失败之间账号曾用**恢复码登录**
   （修 TP 表单时）→ 命中 npm 2026-09 起的全账号策略：恢复码登录成功
   → 发布与敏感写入冻结 72h（登录/消费不受影响）。

**处置**：

- 冻结期内任何发布路径（CI OIDC / 本地交互 2FA）都可能被拒；
  交互态报错更明确，值得试一次拿官方文案
- **绝不能再碰恢复码**——再用一次，72h 重新计时
- 到期后 `gh run rerun <id> --failed` 重跑即可（tag/版本不动）
- 改走「npm stage publish + 人工批准」也可绕开冻结（未验证，备选）

**顺带情报**（2026-09-30 npm 变更）：TP 配置新增 opt-in 权限
`Allow npm dist-tag`（默认关）。普通 publish 隐式带 latest 不受影响，
但下次动 TP 表单时建议顺手勾上；CLI 侧要求 npm ≥ 11.21.0 / 12.2.0。

## 误报排除

`npm notice npm tokens that bypass 2FA are being restricted...` 是 npm 给
**所有** publish 打的迁移公告，**不是** classic-token 路径的标志（env 干净
的 OIDC 成功发布里也会出现）。不要围绕它修。

## 最终可用的发布流（已验证）

```text
本地: npm version patch && git push --follow-tags
CI:  checkout@v6 → setup-node@v7(node24, registry-url, no cache)
     → npm ci → 版本一致性校验 → typecheck → test → build
     → npm publish --access public（OIDC，无 token）
修正表单后验证: gh run rerun <id> --failed（无需新版本号）
```

## 产物核验

- `npm view` dist-tags.latest = 0.3.2 ✓
- registry 包内 `dist/quality/verify.js` 含 ReviewerProtocolError ×7（坑3修复随包发布）✓
- `dist/workflows/feature-development.js` = v1.1.0 ✓
