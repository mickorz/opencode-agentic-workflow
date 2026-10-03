# npm 发布链路踩坑：scoped 新包 + 2FA + Trusted Publishing

日期：2026-10-03 ｜ 环境：macOS、node v25.6.1 / npm 11.9.0、账号开启 2FA
关联：`@mickorz/opencode-agentic-workflow@0.3.0` 首发、`.github/workflows/publish.yml`
（复用 v1 `opencode-dynamicworkflows` 的实战流水线）

背景：新 scoped 包首发（bootstrap），本地手动 `npm publish` + 之后的 CI 自动发布。

---

## 坑 1：非交互终端里 `npm publish` 必遇 EOTP（2FA 账号）

### 现象

agent/脚本等非 TTY 环境执行 `npm publish`：

```text
npm error code EOTP
npm error This operation requires a one-time password.
npm error Open this URL in your browser to authenticate:
npm error   https://www.npmjs.com/auth/cli/***
```

且**打印的授权链接是死路**：进程随即退出，浏览器完成授权时对应的发布
进程已不在，认证会话作废。看起来"给了出路"，实际走不通。

### 出路

1. **真 TTY 手动发布**（本项目最终采用）：在交互终端直接 `npm publish`，
   npm 会自动开浏览器完成 web-auth 后继续发布；
2. **带验证码发布**：`npm publish --otp=123456`（验证器 App 的 6 位码，
   30 秒窗口，拿到立刻执行，过期重来一轮）。

### 一般化

发布这类"必须交互确认"的操作，交给 agent 执行前先确认账号是否强制 2FA；
强制 2FA 的，把"手动 TTY 发布"直接写进流程，不要浪费轮次试非交互路径。

---

## 坑 2：发布明明成功了，`npm view` 却持续 404（本地负缓存）

### 现象

时间线（均为真实日志时间戳）：

```text
16:32:12  agent 尝试 publish → EOTP 失败（同时本地缓存了该包名的 404）
16:33:09  人工 TTY publish 成功（PUT 200，exit 0）
16:34:03  npm view → 404 "Not found"        ← 误导：像没发上去
16:34:06  npm view → 仍 404
约 5 分钟后 npm view → 仍 404               ← 已经不是传播延迟能解释
直连 curl registry → 200，packument 完整（latest: 0.3.0）  ← 包明明在线
```

### 真相

**npm 本地缓存（`~/.npm/_cacache`）把"发布前的 404"负缓存住了**。
`npm view` 默认 `prefer-offline` 倾向，命中这份过期 404 就不再回源。
新包名尤其容易触发：首发前几乎必然先 `npm view` 探过名（404 入缓存）。

### 判定与解决

- **判定发布是否真成功，以 `~/.npm/_logs/` 日志为准**：

  ```text
  http fetch PUT 401 https://registry.npmjs.org/@scope%2fpkg   ← 2FA 挑战（正常）
  verbose web auth opening url pair
  http fetch GET 202 .../-/v1/done?authId=***  （×N，轮询等待授权）
  http fetch GET 200 .../-/v1/done?authId=***                  ← 授权完成
  http fetch PUT 200 https://registry.npmjs.org/@scope%2fpkg   ← 发布被接受
  verbose exit 0
  info ok                                                       ← 铁证
  ```

- 验证包是否在线：`npm view <pkg> --prefer-online`（绕过陈旧缓存），
  或直连 `curl -s https://registry.npmjs.org/@scope%2fpkg`（完全绕开 npm）。

### 一般化

**「查询工具的否定结果」永远先怀疑缓存**。404 这类负面应答同样会被缓存；
发布/写入类操作之后立刻做存在性验证，必须加 `--prefer-online` 或换独立
通道（curl）。误判"发布失败"会引发二次发布、版本混乱等连锁反应。

---

## 坑 3：Trusted Publishing 无法铸造包的第一个版本（npm/cli#8544）

### 现象

想用 GitHub Actions OIDC（无长期 token）发布**全新包**：npmjs 上包还不存在，
包页的 Settings → Trusted Publisher 无处可配——这是个先有鸡还是先有蛋的问题。

npm 明确不支持 OIDC 首发新包（npm/cli#8544；PyPI 已解决，npm 未跟进）。
有第三方工具（`npx setup-npm-trusted-publish <pkg>`）发 dummy 包占名再配 TP，
但会污染版本历史。

### 正解（本项目采用，一次性三步）

```text
1. npm login && npm publish        ← 手动首发 0.3.0，包"出生"
2. npmjs.com 包页 → Settings → Trusted Publisher → 登记仓库/工作流
3. 之后全自动：npm version patch → git push --follow-tags → CI 发布
```

Trusted Publisher 登记值（与 .github/workflows/publish.yml 头部注释一致）：

```text
Organization or user: mickorz
Repository:           opencode-agentic-workflow
Workflow filename:    publish.yml
```

**配置与实际运行身份不匹配时，CI 发布报 E404**（即使包存在）——
v1 流水线注释里的实战教训，登记时逐字核对。

### 一般化

零信任/tokenless 自动发布对"存量包"友好，对"首版"有 bootstrap 成本；
新项目规划发布方案时，把"首发必须手动一次"计入流程，而不是事后发现。

---

## 坑 4：OIDC 发布的硬版本要求（继承 v1 实战，未亲自踩）

- **npm ≥ 11.5.1 才支持 OIDC**；Node 22 自带的 npm 达不到 → CI 必须
  `node-version: 24`（Node 22 下 OIDC 发布必失败，报 404，极具迷惑性）；
- `setup-node` 必须 `package-manager-cache: false`——防 npm 缓存投毒
  窃取 OIDC 短期凭证（npm 官方建议）；
- tag 触发发布前加**tag 与 package.json 版本一致性校验**，防手滑发错版本。

以上已固化在 `.github/workflows/publish.yml`，照抄即可，不要"优化"掉。

---

## 坑 5：本地手动 publish 的 dist 陷阱（gitignored 产物 + files 白名单）

### 现象

`dist/` 在 `.gitignore` 里（不入库），`package.json` 又是 `files: ["dist"]`。
干净 checkout 后直接 `npm publish`，prepublish 阶段没有构建的话会发出
**没有 dist 的空包**——入口 main/exports 全部 404，用户装到的是废包。

### 解法

```json
"scripts": { "prepublishOnly": "npm run build" }
```

本地手动发布、CI 发布双保险（CI 里也显式 build，双跑无害）。

### 一般化

**产物目录既不入库、又是唯一发布内容时，构建必须挂在发布钩子上**，
不能依赖"发布前记得构建"的人肉纪律。

---

## 发布验证清单（下次照做，5 分钟）

```bash
# 1. 发布成功证据（不信 view 信日志）
tail -20 $(ls -t ~/.npm/_logs/*.log | head -1)      # 找 PUT 200 + exit 0

# 2. 包在线验证（绕负缓存）
npm view <pkg> --prefer-online version dist.fileCount

# 3. registry 侧完整性抽检（零成本安装面测试）
cd $(mktemp -d) && npm pack <pkg> --silent
tar tzf <pkg>-<ver>.tgz | grep -E "dist/(plugin/)?index\.(js|d\.ts)$|LICENSE|README"

# 4. CI 自动发布链路（TP 配好后）
npm version patch && git push --follow-tags
gh run watch    # 盯流水线：版本校验 → typecheck → test → build → publish
```
