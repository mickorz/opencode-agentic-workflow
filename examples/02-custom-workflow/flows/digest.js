export const meta = {
  name: "digest",
  description: "主题速览：起草 → 文件断言 → 人工审批（v1 js 脚本自定义流程演示）",
}

// v1 脚本形态：魔法全局 + 顶层 return（唯一装载形态，见仓库 README「代码流程」）
phase("起草")
await agent(
  `请在当前工作目录创建文件 digest.md：针对主题「${args.topic}」的速览` +
    "（Markdown：一级标题 + 3-5 条要点 + 一句结论）。" +
    "用文件写入工具直接创建，禁止调用 workflow / workflow_metrics 工具。完成后只回复 done。",
  { label: "draft", retries: 1 },
)

phase("校验")
check(() => fileExists("digest.md"), "digest.md 未生成（agent 步骤失败或没写文件）")

phase("定稿")
const approved = await checkpoint(`「${args.topic}」的 digest 已生成并通过文件检查（见 digest.md），批准定稿？`)

return {
  output: `digest ${approved ? "已定稿" : "未批准"}：${args.topic}（文件：digest.md）`,
}
