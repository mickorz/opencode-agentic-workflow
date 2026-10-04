#!/usr/bin/env bash
# agw 外部测试 · 步骤①：最小安装 + smoke（验证 A1 安装 / A2 第一个 workflow）
#
# 用法（任意空目录的机器上）：
#   bash step1-smoke.sh
#   PROVIDER=glm MODEL=glm-5.3-flash bash step1-smoke.sh   # 换成你在用的模型
#
# 预期：几分钟后输出一份多角度分析 + 汇总报告（3 路并行 research → summary）
set -euo pipefail

PROVIDER="${PROVIDER:-glm}"
MODEL="${MODEL:-glm-5.3-flash}"
BUDGET="${BUDGET:-480}"   # 看门狗预算（秒）

DIR="$(mktemp -d "${TMPDIR:-/tmp}agw-step1-XXXXXX")"
cd "$DIR"

cat > opencode.json <<EOF
{
  "plugins": [
    {
      "package": "@mickorz/opencode-agentic-workflow",
      "options": {
        "model": { "providerID": "$PROVIDER", "id": "$MODEL" },
        "agent": "build"
      }
    }
  ]
}
EOF

echo "[1/2] 最小配置完成：$DIR"
echo "[2/2] 运行 smoke（首次会从 npm 下载插件，需要网络；全程约 2–5 分钟，"
echo "      每 45 秒打印一次进度心跳，请勿中断）…"

opencode run --model "$PROVIDER/$MODEL" \
  "调用 workflow 工具：flow=smoke, topic=Rust 内存安全。完成后报告输出。" \
  > smoke.out 2>&1 &
PID=$!
( sleep "$BUDGET"; pkill -P "$PID" 2>/dev/null; kill "$PID" 2>/dev/null ) & WD=$!
START=$(date +%s)
while kill -0 "$PID" 2>/dev/null; do
  sleep 45
  kill -0 "$PID" 2>/dev/null || break
  LAST="$(tail -c 300 smoke.out 2>/dev/null \
    | LC_ALL=C sed $'s/\x1b\\[[0-9;]*[a-zA-Z]//g' \
    | LC_ALL=C tr '\n' ' ' \
    | tail -c 120 \
    | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null || :)"
  echo "  … 已运行 $(( $(date +%s) - START ))s（最近输出：${LAST:-尚无}）"
done
STATUS=0
wait "$PID" || STATUS=$?
kill "$WD" 2>/dev/null || true
wait "$WD" 2>/dev/null || true

echo "----------------------------------------"
if [ "$STATUS" -eq 0 ]; then
  echo "✅ smoke 完成（exit=0）。报告尾部："
  tail -15 smoke.out
  echo "----------------------------------------"
  echo "完整输出：$DIR/smoke.out"
  echo "下一步（可选）：step2-flagship.sh —— 在 git 项目里跑旗舰全链"
else
  echo "❌ smoke 失败（exit=$STATUS）。输出尾部："
  tail -20 smoke.out
  echo "----------------------------------------"
  echo "完整输出：$DIR/smoke.out"
  echo "排障：https://github.com/mickorz/opencode-agentic-workflow → docs/troubleshooting.md"
  exit 1
fi
