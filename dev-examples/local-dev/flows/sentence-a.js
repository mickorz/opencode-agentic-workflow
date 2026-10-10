// flows/sentence-a.js —— 子流程 A（定义视角一句话；可独立跑）
export const meta = {
  name: 'sentence_a',
  description: '子流程 A：定义视角一句话',
}

return {
  output: await agent(
    `围绕「${args.topic}」用一句平实的话说明它是什么（15~30 字）。只输出句子本身，不要解释。禁止调用 workflow / workflow_metrics 工具。`,
    { label: '句子A', timeoutMs: 120000, retries: 1 },
  ),
}
