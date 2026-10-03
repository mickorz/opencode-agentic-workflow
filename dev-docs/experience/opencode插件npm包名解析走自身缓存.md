# OpenCode 插件 npm 包名解析走自身缓存（项目 node_modules 无效）

**日期**：2026-10-04
**阶段**：v0.3.x Adoption（examples/ 旗舰示例联调）

## 问题现象

examples/01-coding-reliable 配置 `"package": "@mickorz/opencode-agentic-workflow"`
（项目 node_modules 里有 `file:../..` symlink 指向仓库最新 dist），重启 OpenCode 后：

- smoke 可跑（说明插件加载成功）
- 但 `flow=feature-development` 报 `Expected "smoke" | "reliable" | "artifact"`——
  工具 enum 里没有新注册的旗舰 workflow

即：**加载到的插件代码是 registry 上的 0.3.0，而不是项目 node_modules 里指向的
本机最新 dist**。

## 排查过程

1. 本仓库 `dist/plugin/index.js` 含旗舰注册（grep 命中 2 处）→ dist 是新的
2. `~/.config/opencode/node_modules` 无 @mickorz → 不是全局 config 安装
3. 搜缓存目录，命中 `~/.cache/opencode/npm/@mickorz/opencode-agentic-workflow@latest/<时间戳>/`
   - 其内 `package.json` 为 `{"dependencies": {"@mickorz/opencode-agentic-workflow": "0.3.0"}}`
   - 即 OpenCode 自己按 registry 安装了一份钉死版本的插件，插件代码从**这里**加载

## 根因

OpenCode V2 对 **npm 包名形式**的 `"package"` 配置：

```text
包名（如 @scope/pkg）
  -> 安装到 ~/.cache/opencode/npm/<pkg>@latest/<时间戳>/node_modules/<pkg>
  -> 按 registry 当前 latest 版本解析（不是项目 node_modules！）
```

时间戳目录（如 `1791045613149`）在服务启动解析插件时生成/复用；项目目录里的
node_modules（包括 file: symlink）**完全不参与**包名形式的解析。

由此推论：此前「全新用户安装测试」中验证的其实是「opencode 缓存安装 registry
版本可用」，而**不是**「从项目 node_modules 解析」——当时两者不可区分
（registry 与本地同为 0.3.0），本次才真正区分开。

## 解决方案

- **开发期 / 未发布能力**：`"package"` 改用**相对路径**形式，如
  `"../../dist/plugin"`（相对项目目录解析，已实测可用：探针配置成功路由到
  feature-development 并触发 isolation 守卫）。仓库重新 build 即生效。
- **发布后**：examples 切回包名引用即可（读者拿到的 registry 版本含对应能力）。
- **缓存刷新**：`rm -rf ~/.cache/opencode/npm/@<scope>`，下次启动重新按
  registry 解析（删除时若有 opencode 服务在跑可能因并发写入报
  "Directory not empty"，重试即可）。

## 预防 / 注意事项

1. 任何「npm 包名形式插件」联调前，先确认 registry 版本是否包含目标能力；
   本机 dist 的改动对包名形式无效。
2. examples/ 规范已改为：示例目录统一用 `../../dist/plugin` 相对路径 +
   仓库根 build；包名引用仅在 npm 发布后启用（examples/README.md）。
3. dev-examples/ 规范同步：联调配置一律相对路径，禁止包名形式
   （dev-examples/README.md）。
4. Adoption 摩擦点台账 M3 已记录（dev-docs/progress/执行进度.md）：
   插件版本滞后于本地构建是「装了但功能不在」类困惑的根源，README 必须写明。
