#!/usr/bin/env bash
# agw 外部测试 · 步骤②：旗舰 feature-development（analyze→implement→check→verify→checkpoint）
#
# 脚本会搭一个最小 git 演示项目并跑全链，产物固化为 agw/<runId> 分支。
# 若你想在自己的项目里跑：把「插件配置」段抄进你项目的 opencode.json，在项目目录执行同样的 opencode run。
#
# 用法：
#   bash step2-flagship.sh
#   PROVIDER=glm MODEL=glm-5.3-flash bash step2-flagship.sh   # 换成你在用的模型
#
# 说明：脚本走 opencode run（无 TUI），审批配置为 auto-approve；
#       想体验人工审批弹窗，请在 opencode TUI 里把配置改回 interactive 后手动发同样指令。
set -euo pipefail

PROVIDER="${PROVIDER:-glm}"
MODEL="${MODEL:-glm-5.3-flash}"
BUDGET="${BUDGET:-1200}"   # 看门狗预算（秒）：check 阶段会 npm install，全链较慢

DIR="$(mktemp -d "${TMPDIR:-/tmp}agw-step2-XXXXXX")"
cd "$DIR"

# --- 最小 git 演示项目（模拟「你的某个 git 项目」）---
cat > package.json <<'EOF'
{
  "name": "agw-demo-project",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF
mkdir -p src tests
printf 'export const APP = "agw-demo"\n' > src/app.js
cat > tests/app.test.js <<'EOF'
import assert from "node:assert/strict"
import test from "node:test"
import { APP } from "../src/app.js"

test("app name", () => assert.equal(APP, "agw-demo"))
EOF
git init -q -b main
git config user.email tester@example.com
git config user.name tester
git add -A && git commit -qm "init demo project"

# --- 插件配置（全功能：journal / trace / 隔离 / 审批）---
cat > opencode.json <<EOF
{
  "plugins": [
    {
      "package": "@mickorz/opencode-agentic-workflow",
      "options": {
        "model": { "providerID": "$PROVIDER", "id": "$MODEL" },
        "agent": "build",
        "journalDir": ".agw/journal",
        "traceDir": ".agw/trace",
        "isolation": { "mode": "git-worktree" },
        "checkpoint": { "mode": "auto-approve" }
      }
    }
  ]
}
EOF

echo "[1/3] 演示 git 项目就绪：$DIR"
echo "[2/3] 运行 feature-development（check 阶段会 npm install，慢属正常）…"

TOPIC='在 src/greet.js 新增导出函数 greet(name)：name 为空或缺失时返回 "Hello, stranger!"，否则返回 "Hello, <name>!"。并在 tests/greet.test.js 用 node:test + assert/strict 编写单测，覆盖：正常名字、空字符串。代码风格参考现有 src/app.js'
opencode run --model "$PROVIDER/$MODEL" \
  "调用 workflow 工具：flow=feature-development（必须是这个 flow，不要换成其他 flow），topic=$TOPIC" \
  > run.out 2>&1 &
PID=$!
( sleep "$BUDGET"; pkill -P "$PID" 2>/dev/null; kill "$PID" 2>/dev/null ) & WD=$!
STATUS=0
wait "$PID" || STATUS=$?
kill "$WD" 2>/dev/null; wait "$WD" 2>/dev/null

echo "[3/3] 结果核验："
echo "----------------------------------------"
tail -20 run.out
echo "----------------------------------------"

JOURNAL="$(ls .agw/journal/*.json 2>/dev/null | head -1 || true)"
if [ -n "$JOURNAL" ]; then
  python3 - "$JOURNAL" <<'PY' 2>/dev/null || true
import json, sys
j = json.load(open(sys.argv[1]))
print(f"journal: {j['status']} | steps: {[s['status'] for s in j['steps']]}")
PY
fi

BRANCH="$(git branch --list 'agw/*' | head -1 | tr -d ' +')"
if [ -n "$BRANCH" ] && [ "$STATUS" -eq 0 ]; then
  echo "✅ 交付分支：$BRANCH"
  git show --stat --format='%h %s' "$BRANCH" | head -8
  echo "----------------------------------------"
  echo "引入实现：git merge $BRANCH"
  echo "演示目录（可直接删）：$DIR"
else
  echo "❌ 未完成（exit=$STATUS，分支：${BRANCH:-无}）"
  echo "完整输出：$DIR/run.out"
  echo "排障：https://github.com/mickorz/opencode-agentic-workflow → docs/troubleshooting.md"
  exit 1
fi
