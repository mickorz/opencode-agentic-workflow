// FFF 文件搜索性能基准 workflow（A/B Test 第一版：端到端 Agent 体感性能）
//
// 目的：测量在同一项目/同一模型/同一 Agent 下，OPENCODE_DISABLE_FFF=1(ripgrep)
//      与 =0(fff) 两种搜索后端对 Agent 工作流的耗时差异。
//
// 设计要点：
//   - 单 agent 连续执行 20 次原生 glob/grep，减少多 agent 各自 LLM 预热的方差，
//     让搜索后端耗时在总时长中累积到可观测量级。
//   - 每个 glob/grep 用显式 pattern，保证 A/B 两路 agent 行为一致，
//     唯一变量是 OPENCODE_DISABLE_FFF。
//   - workflow DSL 禁用非确定性时间/随机 API（外层脚本负责计时），
//     计时由外层 PowerShell 包装脚本（run-fff-bench.ps1）包住 `opencode run` 完成。
//   - 返回结构化 JSON：每条查询的命中数与前 5 个路径，供 A/B 正确性比对。

export const meta = {
  name: 'fff_search_benchmark',
  description: 'FFF 文件搜索性能基准：单 agent 连续 20 次原生 glob/grep，返回每条命中数与前 5 路径',
}

phase('Mass Search')

const result = await agent(
  `这是 OpenCode 文件搜索性能基准测试（FFF A/B Test）。

【强制规则】
1. 只能使用 OpenCode 原生文件搜索工具：glob 与 grep（以及 read）。
2. 禁止使用 Bash、PowerShell、终端或任何 shell。
3. 禁止直接或间接执行 rg、ripgrep、find、fd、python 等外部命令。
4. 禁止修改、创建、删除任何文件。
5. 不要分析、解释、评论搜索结果。
6. 依次执行下面全部 20 个搜索任务，每个任务都要真正调用一次对应的原生工具。
7. glob 任务用 glob 工具，grep 任务用 grep 工具，pattern 必须与下表完全一致。

【搜索任务清单】
文件路径搜索（用 glob 工具，pattern 列即传给 glob 的 pattern）：
  id=1  pattern="**/*agent*"
  id=2  pattern="**/*workflow*"
  id=3  pattern="**/*config*"
  id=4  pattern="**/*permission*"
  id=5  pattern="**/*runtime*"
  id=6  pattern="**/*session*"
  id=7  pattern="**/*plugin*"
  id=8  pattern="**/*tool*"
  id=9  pattern="**/*schema*"
  id=10 pattern="**/*adapter*"

内容搜索（用 grep 工具，pattern 列即传给 grep 的 pattern）：
  id=11 pattern="agent("
  id=12 pattern="phase("
  id=13 pattern="parallel("
  id=14 pattern="permission"
  id=15 pattern="workflow"
  id=16 pattern="schema"
  id=17 pattern="runtime"
  id=18 pattern="session"
  id=19 pattern="plugin"
  id=20 pattern="tool"

【返回格式】严格只输出如下 JSON 对象，不要任何额外文字、代码围栏或解释：
{
  "queries": 20,
  "results": [
    { "id": 1, "kind": "glob", "pattern": "**/*agent*", "hits": <命中数量，整数>, "sample": ["前5个文件路径"] },
    { "id": 2, "kind": "glob", "pattern": "**/*workflow*", "hits": <n>, "sample": ["..."] },
    { "id": 3, "kind": "glob", "pattern": "**/*config*", "hits": <n>, "sample": ["..."] },
    { "id": 4, "kind": "glob", "pattern": "**/*permission*", "hits": <n>, "sample": ["..."] },
    { "id": 5, "kind": "glob", "pattern": "**/*runtime*", "hits": <n>, "sample": ["..."] },
    { "id": 6, "kind": "glob", "pattern": "**/*session*", "hits": <n>, "sample": ["..."] },
    { "id": 7, "kind": "glob", "pattern": "**/*plugin*", "hits": <n>, "sample": ["..."] },
    { "id": 8, "kind": "glob", "pattern": "**/*tool*", "hits": <n>, "sample": ["..."] },
    { "id": 9, "kind": "glob", "pattern": "**/*schema*", "hits": <n>, "sample": ["..."] },
    { "id": 10, "kind": "glob", "pattern": "**/*adapter*", "hits": <n>, "sample": ["..."] },
    { "id": 11, "kind": "grep", "pattern": "agent(", "hits": <n>, "sample": ["..."] },
    { "id": 12, "kind": "grep", "pattern": "phase(", "hits": <n>, "sample": ["..."] },
    { "id": 13, "kind": "grep", "pattern": "parallel(", "hits": <n>, "sample": ["..."] },
    { "id": 14, "kind": "grep", "pattern": "permission", "hits": <n>, "sample": ["..."] },
    { "id": 15, "kind": "grep", "pattern": "workflow", "hits": <n>, "sample": ["..."] },
    { "id": 16, "kind": "grep", "pattern": "schema", "hits": <n>, "sample": ["..."] },
    { "id": 17, "kind": "grep", "pattern": "runtime", "hits": <n>, "sample": ["..."] },
    { "id": 18, "kind": "grep", "pattern": "session", "hits": <n>, "sample": ["..."] },
    { "id": 19, "kind": "grep", "pattern": "plugin", "hits": <n>, "sample": ["..."] },
    { "id": 20, "kind": "grep", "pattern": "tool", "hits": <n>, "sample": ["..."] }
  ]
}`,
  {
    label: 'FFF 搜索基准 20 连测',
    schema: {
      type: 'object',
      properties: {
        queries: { type: 'number' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              kind: { type: 'string' },
              pattern: { type: 'string' },
              hits: { type: 'number' },
              sample: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'kind', 'pattern', 'hits', 'sample'],
          },
        },
      },
      required: ['queries', 'results'],
    },
  },
)

return JSON.stringify(result, null, 2)
