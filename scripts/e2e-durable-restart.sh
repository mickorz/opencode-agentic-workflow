#!/usr/bin/env zsh
# P2 Durable Workflow Restart —— 全链路总验收（Commit 20）
#
# 链路（用户确认的验收形态）：
#   Registry 解析 workflow@version
#   -> 创建 Worktree（git-worktree 隔离）
#   -> Start（journal 落盘）
#   -> Trace（events.jsonl）/ Metrics（内存聚合）
#   -> Agent 在 worktree 内写文件
#   -> fileExists 检查 -> Checkpoint 拒绝（模拟失败/崩溃）
#   -> 【进程重启 = 新目录新服务的 opencode run】
#   -> 从失败输出/journal 取 runId
#   -> Registry 精确版本 Resolve（journal.workflow.version）
#   -> Reattach 同一个 worktree（文件仍在）
#   -> Resume from journal（completed 步骤跳过，零 agent 调用）
#   -> Complete
#   -> Metrics 查询（workflow_metrics 工具 + metrics.json）
#   -> Trace 查询（双目录 events.jsonl）
#   -> Cleanup（on-success：worktree 移除、journal 身份清空、分支保留）
#
# 用法：./scripts/e2e-durable-restart.sh [topic]
# 环境假设：macOS + zsh + git + python3 + opencode CLI；模型 glm/glm-5.3-flash。
# 经验纪律（dev-docs/experience/）：全新一次性目录；预检模型；直杀 PID 看门狗；
# 取证优先读 journal/traceDir/工具结果而非 stdout。

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
MODEL="glm/glm-5.3-flash"
TOPIC="${1:-火星基地能源方案}"
PRICE_IN=0.15; PRICE_OUT=0.5; PRICE_CACHE_READ=0.03

E2E=$(mktemp -d "${TMPDIR:-/tmp}/agw-e2e-durable-XXXXXX")
J="$E2E/journal"; H1="$E2E/h1"; H2="$E2E/h2"
mkdir -p "$J"

PASS=""; FAIL=""
ok()   { PASS="$PASS\n  ✓ $1";   print -P "  ✓ %F{green}$1%f" }
bad()  { FAIL="$FAIL\n  ✗ $1";   print -P "  ✗ %F{red}$1%f" }
stage() { print -P "\n%F{blue}== $1 ==%f" }

# opencode run + 直杀 PID 看门狗（子壳/管道模式杀不掉本体——见经验文档）
# 用法: run_watchdog <outfile> <timeout_s> <prompt...>
run_watchdog() {
  local out=$1; local t=$2; shift 2
  opencode run --model "$MODEL" "$*" > "$out" 2>&1 & local pid=$!
  ( sleep "$t"; pkill -P $pid 2>/dev/null; kill $pid 2>/dev/null ) & local wd=$!
  wait $pid; local rc=$?
  kill $wd 2>/dev/null || true
  return $rc
}

# journal JSON 断言：python3 表达式为真则 ok，否则 bad
# 用法: assert_json <file> <描述> <python 表达式（变量 run = 解析后的对象）>
assert_json() {
  local file=$1 label=$2 expr=$3
  if python3 - "$file" "$expr" <<'PYEOF'
import json, sys
run = json.load(open(sys.argv[1]))
sys.exit(0 if eval(sys.argv[2]) else 1)
PYEOF
  then ok "$label"; else bad "$label"; fi
}

# ---------------------------------------------------------------------------
stage "Stage 0：构建插件（service 只在启动时加载 dist/）"
(cd "$ROOT_DIR" && npm run build >/dev/null 2>&1) && ok "npm run build" || { bad "npm run build"; exit 1 }

# ---------------------------------------------------------------------------
stage "Stage 1：准备 H1/H2（全新 git 仓库 + 共享绝对 journalDir）"
setup_dir() {  # <dir> <checkpoint-mode>
  local d=$1 mode=$2
  mkdir -p "$d"; cd "$d"; git init -b main -q
  cat > opencode.json <<EOF
{
  "plugins": [
    {
      "package": "$ROOT_DIR/dist/plugin",
      "options": {
        "model": { "providerID": "glm", "id": "glm-5.3-flash" },
        "agent": "build",
        "concurrency": 3,
        "checkpoint": { "mode": "$mode" },
        "journalDir": "$J",
        "traceDir": "trace",
        "isolation": { "mode": "git-worktree" },
        "prices": {
          "glm/glm-5.3-flash": { "input": $PRICE_IN, "output": $PRICE_OUT, "cacheRead": $PRICE_CACHE_READ, "cacheWrite": 0 }
        }
      }
    }
  ]
}
EOF
  git add -A && git -c user.email=e@t -c user.name=t commit -qm init
}
setup_dir "$H1" auto-reject
setup_dir "$H2" auto-approve
ok "H1(auto-reject) / H2(auto-approve) git 仓库 + 共享 journalDir"

# ---------------------------------------------------------------------------
stage "Stage 2：模型预检（不过即终止——完整流程会烧配额）"
cd "$H1"
if run_watchdog precheck.out 90 "只回复 ok" && grep -q "ok" precheck.out; then
  ok "模型可用（$(tail -1 precheck.out | tr -d '\n' | tail -c 40)）"
else
  bad "模型预检失败（限流/配额）——终止验收"; tail -3 precheck.out; exit 1
fi

# ---------------------------------------------------------------------------
stage "Stage 3：Run A（H1）——Registry→Worktree→Journal→Trace→Metrics→Agent 写文件→Checkpoint 拒绝"
run_watchdog run-h1.out 1200 \
  "调用 workflow 工具：flow=artifact, topic=$TOPIC。等待它完成后原样报告工具输出。" \
  || true   # 工具失败以结果文本返回，opencode 本身 exit 0；挂起击杀才非 0

A_OUT=$(cat run-h1.out)
if grep -q "workflow failed" <<< "$A_OUT"; then ok "Run A 按预期失败（checkpoint auto-reject）"; else bad "Run A 未按预期失败"; tail -10 run-h1.out; exit 1; fi
RID=$(sed -n 's/.*resumeRunId="\([^"]*\)".*/\1/p' run-h1.out | head -1)
if [[ -n "$RID" ]]; then ok "失败输出携带 runId=$RID"; else bad "未提取到 runId"; exit 1; fi

# ---------------------------------------------------------------------------
stage "Stage 4：Run A 中间态取证（journal / worktree / 文件 / trace / metrics）"
RJ="$J/$RID.json"
[[ -f "$RJ" ]] && ok "journal 存在：$RJ" || bad "journal 缺失: $RJ"
assert_json "$RJ" "journal: status=failed"                 'run["status"] == "failed"'
assert_json "$RJ" "journal: workflow 身份 {artifact@1.0.0}" 'run["workflow"] == {"id": "artifact", "version": "1.0.0"}'
assert_json "$RJ" "journal: workspace 身份已落盘"            'run.get("workspace", {}).get("provider") == "git-worktree"'
assert_json "$RJ" "journal: write/check 完成、checkpoint 失败" '[s["status"] for s in run["steps"]] == ["completed", "completed", "failed"]'

WS_PATH=$(python3 -c "import json; print(json.load(open('$RJ'))['workspace']['path'])")
[[ -f "$WS_PATH/artifact.md" ]] && ok "agent 产物在 worktree 内：$WS_PATH/artifact.md" || bad "worktree 内无 artifact.md"
MD_FILES=("$H1"/*.md(N))
if [[ ${#MD_FILES[@]} -eq 0 ]]; then ok "项目目录零污染（无 .md 落入 H1）"; else bad "H1 项目目录被污染: ${MD_FILES[*]}"; fi
grep -q '"type":"agent.started"' "$H1/trace/events.jsonl" 2>/dev/null && ok "H1 trace 有 agent.* 事件" || bad "H1 trace 缺 agent.* 事件"
[[ -f "$H1/trace/metrics.json" ]] && ok "H1 metrics.json 落盘（failed 也写快照）" || bad "H1 metrics.json 缺失"
assert_json "$H1/trace/metrics.json" "H1 metrics: 有 agent 调用与 token" 'run["agents"]["calls"] >= 1 and run["agents"]["tokens"]["input"] > 0'

# ---------------------------------------------------------------------------
stage "Stage 5：Run B（H2 = 新目录新服务）——Resume：精确版本 Resolve→Reattach 原 worktree→续跑→Metrics 查询"
cd "$H2"
run_watchdog run-h2.out 600 \
  "依次做两件事：1) 调用 workflow 工具：resumeRunId=$RID，等待完成并原样报告输出；2) 然后调用 workflow_metrics 工具（format=text）并原样报告。" \
  || true

B_OUT=$(cat run-h2.out)
grep -q "resumed artifact@1.0.0" <<< "$B_OUT" && ok "Resume 成功且为精确版本 artifact@1.0.0" || bad "Resume 未成功"
grep -q "$WS_PATH" <<< "$B_OUT" && ok "最终报告指向原 worktree（attach 而非新建）" || bad "报告未指向原 worktree"
grep -q "审批：已批准" <<< "$B_OUT" && ok "checkpoint 重跑并通过" || bad "checkpoint 未通过"
grep -q "## Workflows" <<< "$B_OUT" && ok "workflow_metrics 工具查询成功（同会话）" || bad "metrics 查询失败"

# ---------------------------------------------------------------------------
stage "Stage 6：终态取证（完成 / 清理 / 双目录 trace / metrics）"
assert_json "$RJ" "journal: status=completed"                    'run["status"] == "completed"'
assert_json "$RJ" "journal: workspace 身份已清空（防假 attach）"   'run.get("workspace") is None'
assert_json "$RJ" "journal: 三步全部 completed"                   'all(s["status"] == "completed" for s in run["steps"])'
[[ ! -d "$WS_PATH" ]] && ok "on-success 清理：worktree 已移除" || bad "worktree 残留: $WS_PATH"
git -C "$H1" branch --list 'agw/*' | grep -q . && ok "分支保留（文档化：不删 ref）" || bad "分支意外消失"
H2_AGENTS=$(grep -c '"type":"agent.started"' "$H2/trace/events.jsonl" 2>/dev/null || true)
[[ "${H2_AGENTS:-0}" == "0" ]] && ok "H2 trace 零 agent.* 事件（completed 步骤全部跳过）" || bad "H2 出现 ${H2_AGENTS} 个 agent 事件"
grep -q '"type":"checkpoint.completed"' "$H2/trace/events.jsonl" && ok "H2 trace 有 checkpoint 事件（唯一重跑步骤）" || bad "H2 缺 checkpoint 事件"
[[ -f "$H2/trace/metrics.json" ]] && ok "H2 metrics.json 落盘" || bad "H2 metrics.json 缺失"
assert_json "$H2/trace/metrics.json" "H2 metrics: artifact completed 计数" 'run["workflows"].get("artifact", {}).get("completed", 0) >= 1'

# 恢复期间文件系统状态仍在的旁证（Step 5 报告已含原路径；此处校验报告内容一致）
if grep -q "检查：通过" <<< "$B_OUT"; then ok "报告由 journaled 状态重建（检查字段来自 Run A）"; else bad "报告未重建 journaled 状态"; fi

# ---------------------------------------------------------------------------
stage "结果"
print -P "验收根目录（保留取证）：$E2E"
if [[ -n "$FAIL" ]]; then
  print -P "%F{red}FAILED%f$FAIL"
  print -P "\n通过项：$PASS"
  exit 1
else
  print -P "%F{green}PASSED%f —— P2 durable restart 全链路验收通过$PASS"
fi
