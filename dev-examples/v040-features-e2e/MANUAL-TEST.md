# v0.4.0 手动测试文档

> 测试对象：`checkpointMode` 调用级审批覆盖（功能①）+ 无隔离 workspaceRoot
> 兜底（功能②）。配置基线：本目录 `opencode.json`（故意配成坏环境：
> `checkpoint: interactive` + 无隔离）。
>
> 全部测试在 **dev-examples/v040-features-e2e/ 目录**进行（T4/T5 除外，见各项说明）。

## 前置准备（一次性，约 1 分钟）

```bash
cd /Users/michaelchang/Desktop/WorkProjects/opencode-agentic-workflow
npm run build          # T1/T2/T3 走本机 dist（相对路径引用）
pgrep -x opencode      # 可选卫生检查；有残留可 pkill -x opencode
                       #（v0.4.0 + 显式参数已不依赖此步骤，仅降噪）
```

| 项 | 耗时 | 验证什么 | 必做 |
|---|---|---|---|
| T1 主路径 | <1 分钟 | 功能①+功能②一跑双验 | ✅ |
| T2 拒绝对照 | <1 分钟 | 覆盖参数真实驱动门（非摆设） | ✅ |
| T3 坏路径复刻 | ~1 分钟（可随时中断） | 复现旧版假死现场，反衬修复 | 可选 |
| T4 隔离回归 | 10–15 分钟 | git-worktree 老路径零改动 | 可选 |
| T5 发布产物 | <2 分钟 | npm 包名形式 = 测试者真实视角 | 推荐 |

---

## T1 主路径：一跑双验（必做）

```bash
cd /Users/michaelchang/Desktop/WorkProjects/opencode-agentic-workflow/dev-examples/v040-features-e2e
opencode run --model glm/glm-5.3-flash \
  "调用 workflow 工具：flow=artifact, topic=写一段关于 workspace 抽象的设计笔记, checkpointMode=auto-approve（这个参数必须传）"
```

**预期**：命令正常退出，全程 **< 1 分钟**（假死场景 300 秒起步，对比极明显）。

**判据 1（功能①）——审批同毫秒**：

```bash
python3 -c "
import json
for line in open('.agw/trace/events.jsonl'):
    e = json.loads(line)
    if 'checkpoint' in e['type']:
        print(e['type'], e.get('approved',''), e['time'])"
```

✅ `checkpoint.waiting` 与 `checkpoint.completed … approved: True` 两行的
`time` **完全相同**（毫秒级一致 = 策略门秒批；interactive 门不可能）。

**判据 2（功能②）——文件落本目录 + check 通过**：

```bash
ls -la artifact.md        # ✅ 存在于本目录（修复前写到 ~/artifact.md，
                          #    然后 check 步骤在 HOME 找不到而失败）
python3 -c "
import json, glob
j = json.load(open(glob.glob('.agw/journal/*.json')[0]))
print(j['status'], [s['status'] for s in j['steps']])
print('workspace:', j.get('workspace'))"
```

✅ journal `completed`，steps 全 `completed`；
✅ workspace 身份 `provider: 'in-place'`，`path` = 本目录绝对路径。

---

## T2 拒绝对照：auto-reject 语义（必做）

T1 之后再跑一次，参数换成 `checkpointMode=auto-reject`（topic 随意换个）。

**预期**：workflow 在 checkpoint 步骤**失败**——文件已写出，但审批被拒、
流程不再继续。工具返回文案里带 `runId` 与 resume 提示。

**判据**：

```bash
python3 -c "
import json, glob
j = json.load(open(glob.glob('.agw/journal/*.json')[0]))
print(j['status'], [s['status'] for s in j['steps']])"
```

✅ journal `failed`，steps 形如 `['completed', 'completed', 'failed']`
（write/check 完成，checkpoint 被拒）；
✅ trace 中 `checkpoint.completed` 的 `approved` 为 `False`；
✅ `artifact.md` 仍在（拒绝不回收已写文件——安全侧语义）。

> 这一步同时隐式验证了覆盖的「恢复」语义：T1 用 auto-approve、T2 用
> auto-reject，同进程先后两次行为各自正确 = 上一次的覆盖没有泄漏。

---

## T3 坏路径复刻：不传参数的 interactive 假死（可选）

> 复现 0.3.x 用户真实遭遇：interactive 门在无 TUI 的 `opencode run` 里
> 无人应答 → 静默 300 秒被拒。**不必等满 5 分钟**，看到 waiting 事件即可中断。

```bash
opencode run --model glm/glm-5.3-flash \
  "调用 workflow 工具：flow=artifact, topic=坏路径观察"
```

等 ~15 秒后另开终端：

```bash
cd dev-examples/v040-features-e2e
tail -1 .agw/trace/events.jsonl    # ✅ 出现 checkpoint.waiting 且无 completed
```

回原终端 **Ctrl-C 中断**（安全：产物在 checkpoint 前已提交/写盘的习惯
不受影响；此处只是观察）。对照结论：同样的配置，T1 靠一个参数全链走通。

---

## T4 隔离回归：git-worktree 老路径零改动（可选，10–15 分钟）

用既有沙盒 `dev-examples/feature-dev-e2e/`（isolation: git-worktree）：

```bash
cd /Users/michaelchang/Desktop/WorkProjects/opencode-agentic-workflow/dev-examples/feature-dev-e2e
opencode run --model glm/glm-5.3-flash \
  "调用 workflow 工具：flow=feature-development, topic=在 README 末尾追加一行 changelog"
```

✅ journal 5 步全 `completed`；✅ 分支 `agw/<runId>` 存在（worktree 成功后
清理，分支保留）；✅ journal workspace 身份 `provider: "git-worktree"`。
全绿 = v0.4.0 没碰隔离路径。

---

## T5 发布产物验证：npm 包名形式（推荐，<2 分钟）

测试者的真实视角——全新目录 + npm 包名（解析 latest = 0.4.0）：

```bash
D=$(mktemp -d) && cd "$D"
cat > opencode.json <<'EOF'
{
  "plugins": [{
    "package": "@mickorz/opencode-agentic-workflow",
    "options": {
      "model": { "providerID": "glm", "id": "glm-5.3-flash" },
      "agent": "build",
      "journalDir": ".agw/journal",
      "traceDir": ".agw/trace",
      "checkpoint": { "mode": "auto-approve" }
    }
  }]
}
EOF
opencode run --model glm/glm-5.3-flash \
  "调用 workflow 工具：flow=artifact, topic=发布产物验证, checkpointMode=auto-approve（这个参数必须传）"
ls -la artifact.md && cat .agw/journal/*.json | python3 -m json.tool | grep -A3 workspace
```

✅ 同 T1 判据（artifact.md 在本目录、journal completed×3、in-place 身份）。
若主 agent 报工具参数校验错误（`checkpointMode` 不被认识）→ 服务本次运行的
是缓存了 0.3.2 的旧 daemon：`pkill -x opencode` 后重跑即好（该判别法本身
也是已知坑，见 dev-docs/experience/ 包名解析缓存条目）。

---

## 失败了怎么办

每项失败时采集三样证据（目录内直接打包）：

1. `run.out` 不存在时（直接终端跑）→ 终端输出全文复制
2. `.agw/journal/*.json` + `.agw/trace/events.jsonl`
3. 当时是否有长驻进程：`pgrep -fl opencode` 输出

按项目惯例记录到 dev-docs/friction 或直接反馈：环境类当场修，产品信号
按 P3 规则分流（Frequency / Blocker Override）。
