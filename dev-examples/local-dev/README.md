# local-dev —— 本地联调环境（免 publish 免 tag）

**用途**：改 `src/` → 本地构建 → 直接测试，跳过「npm version + push tag + CI 发布 +
等缓存刷新 + 重启」的整条发布链。插件通过**相对路径** `../../dist/plugin` 引用
本仓库刚构建的 dist（CLAUDE.md dev-examples 约定；包名形式走宿主 npm 缓存，
本机 dist 对其无效——坑见 `dev-docs/experience/opencode插件npm包名解析走自身缓存.md`）。

## 一次迭代循环

```bash
# 1. 仓库根构建（src 改动后必须）
npm run build

# 2. 杀常驻服务（防附着旧 server 无视本项目 opencode.json——坑见
#    dev-docs/experience/ P3「附着到旧 server」记录；每次联调前都做）
pkill -f "opencode serve" 2>/dev/null

# 3. 进入本目录测试
cd dev-examples/local-dev

#    交互 TUI（面板/subflow 去重/终态瘦身等显示行为看这里）
opencode

#    或 headless 冒烟（CLAUDE.md 看门狗约定适用）
opencode run "用 workflow 工具跑 sentence_demo，args.topic=雨，checkpointMode=auto-approve"
```

## 自带冒烟流

| 文件 | 流程 | 验证点 |
|---|---|---|
| `flows/sentence-demo.js` | `sentence_demo`（父） | legacy js 装载、parallel、顶层 return |
| `flows/sentence-a.js` | `sentence_a`（子） | subflow 路径形引用 `'./sentence-a.js'` |
| `flows/sentence-b.js` | `sentence_b`（子） | 同上 |

跑通后看三处证据：
- `.agw/journal/run_*.json` —— 父 run 步骤 `subflow:sentence_a/b` + 两个子 run
- `.agw/trace/events.jsonl` —— 事件流
- TUI 面板 —— subflow 应**合并为一行**（0.8.5 去重）、终态 run 只留最新 3 条

## 边界与提醒

1. **插件随 opencode 进程加载一次就冻结**：改 src → build 后，必须重启 opencode
   （新开聊天无效；多终端 + 常驻服务场景见
   `dev-docs/experience/新开聊天不重载插件-进程冻结误判.md`）
2. `flows/` **新文件**即时注册（未知 id 自动重扫）；**改已有文件**需重启
3. 本目录只测插件运行时；skill（workflow-authoring）是拷贝型启用，走
   CLAUDE.md 的手动同步流程，与本环境无关
4. 运行产物 `.agw/` 已被仓库 .gitignore 覆盖（dist/ 同理），不会误提交

## ⚠️ 全局配置冲突（2026-10-10 实测踩坑）

`~/.config/opencode/opencode.json` 里如果也注册了本插件（npm 包名形式），
宿主会**同时装载两个实例**（npm 缓存版 + 本地 dist 版，id 字符串不同不去重）：
工具调用路由随机、面板双份、options 互相干扰。搭建本环境时已把全局条目
摘除（备份在 `~/.config/opencode/opencode.json.bak-20261011`；testworkflow
是项目级配置不受影响）。**规则：插件要么全局配、要么项目配，绝不双配**。
详见 `dev-docs/experience/全局项目双插件条目双实例并行.md`。
