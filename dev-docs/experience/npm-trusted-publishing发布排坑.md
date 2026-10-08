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

## 最终可用的发布流（✅ 已验证——2026-10-08 08:57Z 0.5.0 经 CI OIDC 上架）

```text
本地: npm version <patch|minor> && git push --follow-tags
CI:  checkout@v6 → setup-node@v7(node24, 无 registry-url, no cache)
     → 清理 .npmrc 占位 _authToken → npm ci → 版本一致性校验
     → typecheck → test → build → npm publish --access public（OIDC）
验证: run 日志出现 "Signed provenance statement"（坑H 判别法）
      + registry dist-tags latest 指向新版本（传播延迟 ~1min）
TP:  条目已 validated（首次成功发布完成）——豁免 48h 过期，勿改仓库/身份
```

## 产物核验

- `npm view` dist-tags.latest = 0.3.2 ✓
- registry 包内 `dist/quality/verify.js` 含 ReviewerProtocolError ×7（坑3修复随包发布）✓
- `dist/workflows/feature-development.js` = v1.1.0 ✓

## 坑 G：CI OIDC 零成功——「已验证」是本地发布伪装的（v0.5.0 复发案，2026-10-08）

**症状**：v0.5.0 tag push → CI `npm publish` 第 4 次 PUT-404（同坑F 文案）。
按坑F 处置等「72h 冻结」到期后照旧失败——冻结理论塌了。

**考古证据**（`npm view … time --json` × `gh run list --workflow=publish.yml`）：

- `gh run list --status=success` = **0 条**：CI OIDC 从未成功过
- 0.3.2 上架 `19:01:22Z`，而 v0.3.2 的 CI run `19:02:33Z` 才启动（晚 71s）——
  「表单修正后 rerun ✅ published 0.3.2」实为**本地 publish**，rerun 从未成功
- 0.4.0 上架 `08:18:57Z`，CI run `07:55Z` 已失败（23 分钟前）——坑F 的
  「冻结期内任何发布路径都可能被拒」直接被本地发布成功证伪：**当时就没有
  冻结，是 TP 表单一直没修好**，0.4.0 同样走了本地
- v0.5.0（10-08）与 v0.4.0（10-04）失败 run 环境逐项一致（node v24.21.0 /
  npm 11.19.0 / setup-node@v7）——workflow 侧无漂移，坐实 registry 侧

**判别要点**（坑F 判别链第 1 条仍成立且是关键）：

- 报错 URL 是 `PUT https://registry.npmjs.org/@scope%2fpkg` → 换到的凭证
  无发布权限（表单 Allowed actions / 冻结 / 条目字段错）
- 坑F 的教训升级：**误诊的代价是三天**——「冻结」叙事让 v0.5.0 发布在
  错误的假设上排队。排障时 `npm view time` 与 run 时间戳对账（上架时间
  是否落在某个 run 的执行窗口内）应作为第一步，别信任何「已验证」旧文
- 剩余两个不可从 CI 日志区分的候选（都需账号侧处理）：
  1. TP 条目 `Allowed actions` 未含 `npm publish`（坑D 修复后被再次编辑
     弄丢，或 npm 新 UI 重存时重置）
  2. 恢复码再次使用 → 冻结真生效（只有账号本人知道）

**处置**（0.5.0 卡在此，tag 不动；**只走 CI，不做本地发布**——账号所有者
拍板：后期发布形态就是「推 tag → GitHub Actions 自动发布」，本地兜底移除）：

1. npmjs.com 核对/重存 TP 表单（字段清单见 `planning/TODO.md`，
   含 `Allowed actions: ☑ npm publish` 与 `Allow npm dist-tag`）
2. `gh run rerun 37733685262 --failed`（版本号/tag 都不动）
3. 仍 404 且确认没碰过恢复码 → 删 TP 条目重建（npm 保存不校验，
   旧条目可能带不可见的坏状态；重建按字段清单逐项填）

> ⚠️ 坑G 的处置计划（rerun 37733685262）已作废——见坑H 第 4 条。

## 坑 H：三凶叠加定案 + 误诊链补完（v0.5.0 深挖，2026-10-08）

外部分析提示 + 逐条核实（npm 官方文档 / GitHub Changelog / setup-node
issue 实录 / run 37733685262 日志），定案如下。**此前坑G 留下的「表单
不匹配 vs 冻结」二选一是个假二元——真凶在仓库侧就有一个，且日志里
一直有证据没被读出来。**

### H-1：setup-node 的 registry-url 占位行——npm 从未尝试过 OIDC（本源）

- setup-node 只要配 `registry-url` 就向 `$RUNNER_TEMP/.npmrc` 写
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` 占位行，
  **v7 也没修**（v7 只移除了占位 NODE_AUTH_TOKEN 环境变量导出，
  actions/setup-node#1551；lynxor/dfab87f 实测 v7 仍写该行）
- 环境变量未设置 → npm 运行时把占位符展开为**空字符串** → npm 11
  读到 `_authToken=` 即认定「已配置凭证」→ **跳过 OIDC 交换** →
  空凭证直接 PUT → npmjs 对未认证写（存量 scoped 包）回 **E404**
  （故意伪装成包不存在，防探测私有包存在性）
- **日志铁证**（run 37733685262）：打包 → PSA notice → `Publishing to
  registry.npmjs.org` → 275ms 后 E404，**全程无 provenance 签名、无
  oidc 交换痕迹**。此前「OIDC 交换成功后 PUT 404」的记录是**误读**
  （把 PSA/成功记忆脑补成了交换成功）——坑A 判别链第 2 条的判据
  本来就能排除此案，没人去日志里数这几行
- 顺带证伪坑B 的旧结论：当时「去掉 registry-url 没用」大概率是因为
  同时存在别的凶（TP 表单 48h 过期，见 H-2）或改完没触发新 run——
  **正确形态是：npmjs 发布段不配 registry-url（npmjs 是默认 registry）**
- 修复：去掉 registry-url + publish 前防御性 sed 清 `_authToken` 行
  （azu/setup-npm-trusted-publish 同款）；已提交 publish.yml

### H-2：TP 配置 48h 过期规则（2026-10-02 生效）——表单怎么改都没用

- npm 官方 + GitHub Changelog：**新建的 Trusted Publishing 配置必须在
  48h 内完成一次成功发布**才算验证；过期后条目**仍显示在设置页但彻底
  失效**；**普通编辑不重置窗口**，只能删除重建（重建重新计时 48h）
- 本包 TP 条目创建于 10-03 前后、CI 零成功 → **条目早已过期**。
  这解释了坑G 之后「表单字段看着全对」的僵局——看着对，但它是尸体
- 另注意（官方文档）：2026-05-20 后新建的配置**必须显式勾选**至少一个
  Allowed action（`npm publish` / `npm stage publish`）；npm 保存时
  **不校验**配置与仓库身份的匹配，错了也存得进去
- 处置（账号侧，只能本人做）：npmjs.com 删除旧 TP 条目 → 重建：
  repo `mickorz/opencode-agentic-workflow`、workflow `publish.yml`、
  Environment 留空、☑ npm publish（+ ☑ Allow npm dist-tag）→ **48h 内
  推 tag 完成首次成功发布**。CLI 等价：`npm trust github
  @mickorz/opencode-agentic-workflow --file publish.yml
  --repo mickorz/opencode-agentic-workflow --allow-publish -y`

### H-3（顺带凶）：bin 路径带 `./` 前缀 → npm 11 打包时整个删除

- run 日志另一条被忽略的 warning：`bin[opencode-agentic-workflow]
  script name ./dist/cli/index.js was invalid and removed`
- npm 11 对 bin 值校验收紧：`"./dist/cli/index.js"` 的 `./` 前缀非法，
  publish 时**不是修正而是整条删除**——0.5.0 即使发布成功也是**无 bin
  的残包**（安装器 CLI 全废）。0.4.0 无 bin 字段所以此前从未暴露
- 修复：`npm pkg fix` 规范为 `dist/cli/index.js`（已应用，dry-run 复验
  无警告）。教训：**带 bin 的版本发布前必须 `npm publish --dry-run`
  过一遍警告**，auto-correct 类 warning 一律当 blocker 处理

### H-4：`gh run rerun` 不会使用 main 上的新 YAML

- GitHub Actions 重跑用**原 commit 的工作流定义**——改完 publish.yml
  后 rerun 旧 run 仍是旧行为（还会再踩 H-1）。坑G 的 rerun 计划作废
- 正确触发：修复合入 main 后**推新 tag**。v0.5.0 未发布过 → 允许把
  v0.5.0 tag 移到修复后的 commit（「永不重打已发布版本的 tag」红线
  只约束已发布版本）重推触发；或直接升版
- 判别补充：以后看失败 run 先 `grep -c "provenance\|oidc" 日志`——
  零命中 = 根本没走 OIDC（先查 .npmrc/registry-url），有签名仍 404
  才往表单/权限方向查

### 汇总：为什么 4 次全败

| 时间 | 主凶 |
|---|---|
| 10-03（0.3.1×3 / 0.3.2） | H-1 占位行（当时 v4/v6 + registry-url）+ 表单字段错（坑D） |
| 10-04（0.4.0） | H-1 + 坑F 冻结（本地发布救场） |
| 10-08（0.5.0） | H-1（v7 + registry-url 仍写占位行）+ H-2 条目已过期；若发布成功还会撞 H-3 |

三凶独立存在、逐个都能单独挡死发布——单变量排查永远修不完。
修复后首跑若仍 404：按坑G 判别要点区分（URL 形态 + 有无 oidc 痕迹）。

### 坑H 结局（2026-10-08 08:57Z）：CI OIDC 首次成功，0.5.0 上架

修复落地序列（全部当日完成）：

1. `npm login`（本机 token 过期是 trust 命令 401 的原因；坑F 教训下走
   浏览器正常 2FA，未碰恢复码）
2. `npx -y npm@latest trust list` → 空（旧尸体条目已不在，省一步 revoke；
   本机 npm 11.9 无 trust 子命令，npx 拉最新即可，Node 25 警告无害）
3. `npx -y npm@latest trust github … --allow-publish -y` → 条目创建
   （权限实际给了 publish + stage publish 两个）
4. 移 tag（`git tag -f v0.5.0 main && git push -f origin v0.5.0`，未发布
   版本允许移）→ run `37753094523` 32s 全绿
5. 成功判别三件套全中：`Signed provenance statement`（OIDC 真实走通，
   此前 5 连败日志里从未出现）→ registry `latest: 0.5.0`（传播延迟约
   1 分钟，别急着重试）→ `bin` 字段完好（坑H-3 修复端到端生效）

TP 条目就此 **validated**——永久豁免 48h 过期（除非更改仓库/身份）。
