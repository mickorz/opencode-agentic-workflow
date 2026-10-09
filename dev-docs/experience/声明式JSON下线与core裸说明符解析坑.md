# 声明式 JSON 流程下线与裸说明符解析坑（v0.6.0）

日期：2026-10-09　|　版本：0.5.2 → 0.6.0　|　性质：产品决策 + 实锤缺陷修复

## 决策

用户（产品负责人）判断：**声明式 JSON 流程设计未定型（"还没有想清楚"），
本版本下线，自定义流程只保留代码（JS 模块）形态**。

摘除面（全部用户可见面，git 历史留档）：

- `workflow_define` 工具（对话内 JSON 定义 → 注册 → 落盘链路）
- loader 的 `.json` 装载分支 + 声明式机器（validateWorkflow /
  toDefinition / 模板解析 / 七类步骤声明，约 490 行）
- `loadDeclarativeWorkflows` 别名
- skills/workflow-authoring 的 JSON 作者指南（改写为 JS 作者指南）
- README 声明式语法文档（subflow/pipeline/race 的 JSON 形态示例）

`.json` 入口（显式文件或目录内文件）不静默忽略——逐文件给出
「JSON workflows were removed in v0.6.0」迁移提示（fail-loud 文化）。

## 坑：`<pkg>/core` 裸说明符在用户目录解析不了（P2-14 文档债）

**现象**：README/skill 教用户在 flows 目录写
`import { agent } from "@mickorz/opencode-agentic-workflow/core"`，
但包安装在 opencode 全局缓存（`~/.cache/opencode/npm/...`），不在用户
项目 node_modules 解析链上：

```
node -e "import('./flows/probe.mjs')"   # probe.mjs import <pkg>/core
→ ERR_MODULE_NOT_FOUND: Cannot find package '@mickorz/opencode-agentic-workflow'
```

**根因**：P2-14 的测试全部用**无依赖纯对象模块**（不 import 包），
文档里的 core-barrel import 写法**从未在真实用户目录执行过**——
典型的「文档超前于验证」。

**修复（装载器说明符重写）**：

1. 读 flow 文件源码，若含裸说明符（`from`/副作用 `import`/动态
   `import()` 三形态）：
   - 重写为**插件自身 dist/core 的绝对 file URL**（从 loader 的
     `import.meta.url` 推导；tsx 下探测 `.ts`）——保证拿到与宿主
     **同一模块实例**（executor 已 `setExecutor` 接线、ambient 状态可用；
     若解析出第二份模块实例，engine 未接线会炸）
   - 重写产物写**同目录隐藏临时 `.mjs`**（`.<name>.<hash8>.aw.mjs`）
     → import → finally 删除：保留该文件**其余相对/npm 导入**的解析
     语义（data: URL 方案会丢这个）
   - 目录不可写 → 回退 `data:text/javascript;base64,` 导入（此形态
     下文件内相对导入不可用，核心 API 可用）
2. `.cjs` 引用 core：require 语义无法安全重写 → 明确报错「改名 .mjs」
3. 不含裸说明符的文件原样导入，行为零变化

**测试覆盖**：无 node_modules 临时目录装载 bare-core 模块（agent/
defineWorkflow 可用）、相对导入保留、临时文件零残留、.cjs 报错、
.json 迁移提示。

## 顺带改进

- **flows/ 零配置缺省**：`options.workflows` 未配置时，项目目录存在
  `flows/` 即自动装载（对齐用户对 flows 目录的心智；此前必须显式配置
  才装载）
- 目录扫描忽略点开头文件（防临时文件/编辑器杂物误入）

## 后续（v0.6.1）：保存即用——未知 id 增量重扫

用户要 v1 的完整闭环：「输入需求 → agent 写 JS → 立即可跑」，不接受
写完文件还要重启。实现：`workflow` 工具遇未知 flow id 先重扫一次 flows
目录（`refreshCustomWorkflows`，init/重扫共用），命中即注册运行；仍未知
才报错（附 flows 装载错误前 3 条，作者可在对话内自诊断）。

**诚实边界**：只有新文件能被拾取——Node ESM 缓存按 URL，改动已装载
文件（含升 version）重导返回旧模块，必须重启。skill/README 均如实标注。

## 教训

1. **文档里的每个 import 写法都要在目标环境跑过一次**——"能编译"不等于
   "用户的目录能解析"
2. 下线功能时，**入口处给迁移提示**比静默忽略友好得多（用户能自己走完
   迁移，不用来问）
3. 动态 import 用户文件的**模块实例同一性**是被忽略的正确性维度：
   必须重写到自身绝对路径，而不是让 Node 再解析一份
4. **flows 模块顶层的立即执行代码**会在文件后部常量之前运行（TDZ）——
   数据索引必须惰性构建（实测：底部大表 + 顶层建索引循环 →
   `Cannot access 'PINYIN_INITIALS' before initialization`，装载即炸）
5. 主 agent 写流程卡壳的两大原因（2026-10-09 实测.trace）：不知道
   「零依赖数据怎么做」（答案：内嵌表 + 惰性索引）、去探索插件/npm
   安装位置（答案：根本不需要——flows 目录就在项目根下）。
   两条都进 skill 后 4 分钟打转应能避免

## 后续（v0.6.3 当日）：拷贝型 skills 与插件本体更新脱节

**现象**：宿主重启/缓存清理只更新插件本体（npm 缓存自动拉 latest），
拷贝进 `~/.config/opencode/skills/` 的 skill 是安装时快照——发多少版都
不会跟。用户实测抓到：0.6.2/0.6.3 的 skill 修复发布后，会话加载的仍是
安装时旧版。

**机制**：`npx <pkg> update` 会无条件刷新拷贝型 skills（update.ts），
但手动清缓存/等宿主自动更新这条路完全不经过它。

**当日处置**：手动 cp 同步到全局目录（diff 验证与 0.6.3 逐字节一致）。

**改进候选**（未做，记 backlog）：插件 init 时比对「包内 skills 与拷贝
目录的内容指纹」，不一致就 WARN 提示跑 update——把 drift 变成显式
信号而不是沉默过期。

## 验证

- `npm test` 337/337（26 个 JSON 专属测试移除，9 个新测试加入）
- typecheck / build 绿；pty 真实宿主装载零 `plugin operation failed`
- 用户项目 end-to-end：testworkflow `flows/calc.mjs`（core API 重写）
  装载 + 运行成功
