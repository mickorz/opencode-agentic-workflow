/**
 * 宽松 JSON 解析 —— LLM 评审输出的确定性化（P1.2）
 *
 * reviewer agent 被要求输出严格 JSON，但 LLM 输出天然不可控：
 * 可能带 markdown 代码围栏、前后缀解释文字。此处依次尝试：
 *   原文 -> 剥代码围栏 -> 首尾大括号截取
 * 全部失败返回 undefined，由调用方按「评审失败」处理。
 * （策略改编自 V1 opencode-dynamicworkflows 的 parseJsonLoose。）
 */

export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  const attempts: string[] = [trimmed]

  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i)
  if (fence?.[1]) attempts.push(fence[1].trim())

  const firstBrace = trimmed.search(/[[{]/)
  const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"))
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    attempts.push(trimmed.slice(firstBrace, lastBrace + 1))
  }

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt)
    } catch {
      // 尝试下一种
    }
  }
  return undefined
}
