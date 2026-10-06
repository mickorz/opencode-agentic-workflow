# P2-10 Installer CLI（npx 安装器）

> 立项 2026-10-07。v1 对照：`opencode-dynamic-workflows` 的
> `npx install/uninstall/update/doctor`（配置合并 + .bak + skills 安装）。
> v2 现状：手改 opencode.json（README 已验证可行）——外部测试者的安装
> 卡点反馈到位，值得把这层自动化。

## 目标

`npx @mickorz/opencode-agentic-workflow <cmd>` 一条命令完成安装 / 升级 /
卸载 / 排查，配置合并保留注释，写前备份，卸载与安装对称。

## 命令与安装方式

| 命令 | 行为 |
|------|------|
| `install`（默认） | 交互式安装；支持 flags 全量指答后转无头模式（可脚本化） |
| `update` | locked：npm update；global/project：清 OpenCode 插件缓存（best-effort）；skills 重新拷贝 |
| `uninstall` | 检测各方式存在性 → 勾选 → 对称移除（配置条目 + 拷贝目录 + locked 时 npm uninstall） |
| `doctor` | 只读排查，[OK]/[WARN]/[FAIL] 清单 |

三种安装方式（v2 语义）：

| 方式 | plugins 条目 | skills 落点 |
|------|--------------|-------------|
| `global` | `~/.config/opencode/opencode.json` += `{package: <pkg名>, options}` | 拷贝到 `~/.config/opencode/skills/<name>`（原生扫描） |
| `project` | `<cwd>/opencode.json` += 同上 | 拷贝到 `<cwd>/.opencode/skills/<name>` |
| `locked` | 先 `npm install <pkg>`；条目 `package: "./node_modules/<pkg>/dist/plugin"` | 零拷贝：config `skills` 数组 += `node_modules/<pkg>/skills`（README 方式一） |

插件 options 由安装器生成最小可用集：`model`（必答，校验
`providerID/modelId` 形）+ `agent`（缺省 `"build"`）+ 可选
`journalDir: ".agentic-workflow/journal"`（持久化开关，默认开——
resume/后台 run/调度都依赖它；相对路径按 v2 语义以项目目录解析）。

## 关键设计

- **JSONC 增量合并**（jsonc-parser modify/applyEdits）：保留用户注释与
  格式，数组整体替换，写前 `.bak`；modify 传 undefined = 删键
- **条目匹配**：plugins 数组元素为对象时看 `package` 字段——包名 /
  `node_modules/<pkg>/dist/plugin` 结尾（locked）；零拷贝 skills 条目按
  `node_modules/<pkg>/skills` 结尾匹配
- **卸载对称原则**（v1 0.2.0 实测教训）：locked 安装无条件 npm install，
  卸载就无条件 npm uninstall，不做默认 No 的可选询问；条目清空的数组
  连键删除；配置只剩 `$schema` 空壳时整文件删除（含 .bak）；本轮改动
  过的 .bak 一并清理；含用户数据的删除（拷贝的 skill 目录）逐个询问
- **无头模式**：`--global/--project/--locked`、`--model <ref>`、
  `--agent <id>`、`--no-journal`、`--no-skills`、`--yes`——必答项齐备即
  跳过交互；非 TTY 且缺必答 → 报错列出缺项（不挂起）
- **skill 拷贝源**：CLI 自身包根 `skills/`（npx 缓存内），不依赖
  OpenCode 是否已下载插件本体
- **update 清缓存 best-effort**：v2 插件缓存路径未官方化，删除失败或
  目录不存在仅 WARN 并提示重启 opencode 重新拉取

## doctor 检查项

Node >= 20（FAIL）；opencode CLI 存在且 major = 2（缺失/不是 v2 → WARN）；
三种安装方式存在性（INFO）；已装条目缺 model/agent（WARN）；journalDir
配置时可写（FAIL 不可写）；git 存在（WARN——worktree 隔离需要）；skills
拷贝目录 / 零拷贝条目存在性（INFO）；已装版本 vs `npm view` 最新（查询
失败 WARN，过期 WARN）。

## 验收标准

1. 单测（node:test + tsx）：config 层纯函数（JSONC 合并/移除/条目匹配/
   空壳判定/零拷贝 skills 条目）+ 无头 install→doctor→uninstall 全链
   （临时目录 + 注入 HOME/cwd，断言配置、.bak、skills 目录、对称清理）
2. 打包验证：`npm pack` 产物含 dist/cli 与 bin；**仓库外**临时目录装
   tarball 后 bin 可跑（不在本仓库内测 npx——父链 node_modules 污染）
3. typecheck + 全量测试绿；README 安装章节、backlog flip、执行进度条目
4. 交互路径人工验收清单列出（非 TTY 自动化只覆盖无头路径）
