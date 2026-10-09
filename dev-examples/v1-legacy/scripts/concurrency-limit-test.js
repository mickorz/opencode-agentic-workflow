// 并发上限测试脚本：24 个轻量探针 agent 并行，测当前实际同时执行的 agent 数上限
//
// 并发由 runtime 信号量控制（src/runtime/semaphore.ts）：
//   - 工具入参 concurrency：钳制上限 16
//   - 缺省值：CPU 核数 - 2
//
// 用法：在 examples/sample-project 目录启动 OpenCode 后，对 Main Agent 说：
//   "用 workflow 工具执行 scripts/concurrency-limit-test.js，scriptPath 传该路径，
//    concurrency 传 8（换成你想验证的值），不要粘贴脚本内容"
//
// 读数方法（三选一）：
//   1. 总耗时对比法：同一脚本分别用 concurrency=1/4/8/16 各跑一次，
//      总耗时应约反比于 concurrency（24 个探针、并发 C 时约 24/C 波 x 单探针耗时）
//   2. 精确计算法：结果 metadata.agents 里每个 agent 带 durationMs，
//      有效并发度 约等于 所有 agent 耗时之和 / 总耗时，应约等于传入的 concurrency
//   3. TUI 目测法：运行期间看 sidebar 实时进度树，同时处于 running 的节点数即实际并发
//
// 注意：不要带 resumeFromRunId，journal 缓存回放会让探针全部秒回、测量失真

export const meta = { name: 'concurrency_limit_test', description: '并发上限测试：24 个轻量 agent 并行探针' }

phase('Probe')
const TOTAL = 24
const probes = []
for (let i = 0; i < TOTAL; i++) {
  probes.push(() =>
    agent(`这是并发测试探针 第 ${i + 1}/${TOTAL} 个。只回复 ok，不要读文件不要做其他任何事`, { label: `probe-${i + 1}` }),
  )
}
const results = await parallel(probes)
const okCount = results.filter((r) => String(r).trim().toLowerCase() === 'ok').length
log(`探针完成 ${okCount}/${TOTAL}`)
return {
  total: TOTAL,
  okCount,
  hint: '读数见本文件头注释：有效并发度 约等于 所有agent耗时之和(metadata.agents各durationMs) / 总耗时',
}
