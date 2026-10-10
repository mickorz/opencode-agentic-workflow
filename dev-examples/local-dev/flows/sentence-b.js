// flows/sentence-b.js —— 子流程 B（场景视角一句话；可独立跑）
export const meta = {
  name: 'sentence_b',
  description: '子流程 B：场景视角一句话',
}

return {
  output: await agent(
    `围绕「${args.topic}」用一句话勾勒一个具体画面（15~30 字）。只输出句子本身，不要解释。禁止调用 workflow / workflow_metrics 工具。`,
    { label: '句子B', timeoutMs: 120000, retries: 1 },
  ),
}
