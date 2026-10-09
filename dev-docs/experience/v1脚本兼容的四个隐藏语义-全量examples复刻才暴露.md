# v1脚本兼容的四个隐藏语义——不做全量examples复刻就会漏掉

**日期**：2026-10-09 · **版本**：0.8.0 → 0.8.1 → 0.8.2 · **类别**：legacy 适配语义坑

## 背景

0.8.0 实现 v1 脚本装载（19 全局绑 v2 原语），单元测试全绿即发布。
用户随后要求「把 v1 examples 全部复刻过来跑一遍测所有功能」——62 个
真机脚本暴露出 **6 个**单元测试测不出来的语义缺口（首批 4 个 + 实跑中
又抓出 2 个）。

## 四个坑（全部：首跑即暴露，修复前 0.8.0 必错）

### 1. 顶层 agent() 超时不该抛，该塌缩 null + 登记闸门

0.8.0 行为：`AgentTimeoutError` 直接上抛 → flow 立即失败。
v1 真语义（workflow-runtime.ts L612-632）：可恢复失败耗尽重试后
**返回 null 继续跑**，同时登记 `phaseFailed`；「阶段失败闸门」在
**下一个 phase() 边界或 run 终检**才终止（同 phase 的 tail 节点照常
执行）；`continueOnAgentFailure` 逃生口 + fallback/race 成功吸收。

暴露脚本：`composite/failure-gate-test.js`（注释明写「Test2 同 phase
收尾照常执行，边界才拦」）。

### 2. fallback 吸收 = 清空全闸门，且「null+登记」≠成功

0.8.0 绑 core fallback（无闸门概念）。v1 语义（L976-991）：
- 候选**真成功** → `phaseFailed = []`（清空**全部**登记，含 fallback
  开始前的——「降级成功=显式吸收，否则 fallback 语义报废」）
- 候选返回 **null 且窗口内新增登记** → 视为候选**失败**换下一个
  （agent 塌缩的 null 不是成功值）

### 3. workflow() 吃的是路径不是 id

v1 `workflow('./scripts/native/1_spec.js')`（相对工程根）、对象形
`{scriptPath, label}`、注册名 `workflow('schedule_test')` 三形态。
native/composite 家族 29 处调用全是路径形。0.8.0 只支持 id → 全数阵亡。

修复：装载索引 `flow-index.ts`（文件绝对路径→id），多基准解析
（cwd → 调用脚本目录 → 装载根 → **装载根的父目录**——v1 的
`./scripts/native/x.js` 相对工程根，根的父目录正是该工程根）。
返回值还要 **JSON 还原**：v2 subflow 给 output 字符串（对象被
toOutput JSON 化），v1 脚本 `spec.brief` 直取字段。

### 4. 子流程 args 不能 required:topic

legacy 定义的 argsSchema 若 `required: ["topic"]`，subflow 传
`{tag}/{brief}/{cfg}` 全被校验拦下（native_pipeline 传 spec.brief
必炸）。修：去 required——workflow 工具本来恒传 topic，顶层不受影响。

## 顺带补的选项面（grep 全量扫描才发现）

- `isolation: 'worktree'`（worktree-test）：per-call worktree，
  复用 v2 GitWorktreeProvider + core agent() 新增调用级 cwd 覆盖 +
  v1 同款工作目录提示词；非 git 目录响亮降级
- `agentType`（chain×2 + worktree）/ `tier`（tier-fallback）：
  v2 无调用级对位 → 响亮警告后降级（tier 的降级恰好=v1 回退语义）
- 未知选项键 fail-loud（防未来静默语义丢失）

## 第五、六个坑（0.8.1 实跑中再抓出）

### 5. workflow() 的 args 克隆隔离（mutate_parent 验收点）

v1 `workflow()` 两侧都 structuredClone：入参克隆（child 改 `args.cfg.xxx`
不外溢父对象——注释原话「VM 内 mutation 不外溢」）+ 返回值克隆。
0.8.1 适配层把 subArgs **原引用**直传 ctx.subflow → v2 直传 →
`mutate_parent` 的 `{counter: 1}` 被子流程改成 `{counter: 999}` →
克隆隔离验收必挂。修复：适配层传参前 structuredClone（不可克隆对象
fail-loud，v1 SCRIPT_VALIDATION_ERROR 对位）。

### 6. 错误分类学：v1 默认一切未知错误「可恢复」（errors.ts wrapError）

0.8.1 的 isRecoverableFailure 白名单 = {AgentTimeout, AgentSchema,
LegacyCheck}——普通 `new Error()` 被当结构性上抛。v1 真语义
（wrapError L33-39）：**除 abort 外一切未知错误 → `AGENT_FAILED,
recoverable: true`**；结构性只有显式标记的四种（脚本校验/agent 上限/
checkpoint 拒绝/阶段闸门）。后果对照：

| 场景 | v1 正确行为 | 0.8.1 错误行为 |
|---|---|---|
| `sequence` 节点抛普通 Error | 停止返 null，run 完成（seq_fail_parent） | 整个 run 失败 |
| `parallel` 槽抛普通 Error | 塌缩 null（子流程失败同） | 整个 run 失败 |
| `fallback` 候选抛普通 Error | 换下一候选（fb_child_parent） | 整个 run 失败 |

修复：新增 `LegacyStructuralError`（适配层契约/闸门类），分类函数改为
**黑名单制**——只排除 LegacyStructuralError 与 RunAbortedError，其余
一律可恢复（v1 默认）。适配层自身 15 处契约 throw 全部换成
LegacyStructuralError（文案不变，fail-loud 不降级）。

**反向风险提示**：黑名单制意味着「parallel 里吞掉适配层没预期的未知
错误」——这正是 v1 语义（宽松塌缩）；适配层自己的 bug 必须用
LegacyStructuralError 显式标记才不被吞，写适配代码时不能随手
`throw new Error`。

## 方法论教训

1. **「兼容层」的验收标准是对方的全量用例，不是自己写的单元测试**。
   单测只覆盖了我对 v1 的想象；examples 才是 v1 的行为规格。
2. 复刻要**逐字不改**（含注释——failure-gate 的验收点就写在注释里），
   改了目录结构（分类重组）会破坏 `./scripts/...` 路径引用——分类用
   README 矩阵表达，不动文件树。
3. 做兼容层前先把对方 runtime 的**错误路径**读完（成功路径大家都对，
   语义差异全在失败/降级/边界：塌缩、闸门、吸收、降级）。
4. grep 对象字面量选项时，`grep '{...label...}'` 会漏掉不含 label 的
   选项——要按「可疑键名全集」逐键扫（tier 就是这么漏的）。

## 预期失败清单（不是 bug，是 v1 设计如此）

跑全量时这些 flow **应该失败**，失败=语义对位正确：
`failure_gate` / `tui_failure` / `tui_enhance`（闸门触发）、
`self_ref` / `self_ref_parent`（深度守卫）、`error_child` /
`error_parent`（结构性传播——注意 error_parent 预期**完成**，
其 try/catch 自理；error_child 单跑预期失败）、
`composite_fb_struct`（不存在路径 fail-loud）、
`node_detail_failed` / `node_detail_retry`（失败态验收）。

## 附：批量跑批的坑——工具描述 flow 枚举滞后，模型静默丢参

首批批量（3 路并行 `opencode run`）全部跑成默认 `smoke`：模型看到
workflow 工具描述里 flow 清单为空/不含目标 id，就**静默丢掉 flow 参数**
回落缺省。工具描述在插件 init「装载完成 → 注册工具」时快照（顺序
正确），但 service 常驻会话与项目级配置的交叉下，枚举可见性不稳定。
**稳定姿势**：提示词里强令「flow 参数必须显式传 X，即使枚举没列出也
照传（未知 id 触发 v0.6.1 自动重扫）」——单跑与批跑均验证有效。
