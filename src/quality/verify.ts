/**
 * verify —— 语义质量验证节点（P1.2）
 *
 * 与 check 的职责边界：
 *   check = 确定性验证（谓词求值，可重复）
 *   verify = 语义质量验证（reviewer agent 评审「做得对不对/好不好」）
 *
 * 机制：
 *   verify(artifact, { reviewers: N, criteria })
 *     -> N 个 reviewer 子 agent 并行评审（复用 parallel() 组合子）
 *     -> 每个 reviewer 被要求输出 JSON verdict（宽松解析，解析失败按 fail）
 *     -> 全员 pass 才 passed=true（严格语义；后续失败策略在此之上构建）
 *
 * 与 check 对称的双 API：
 *   verify()      -> 永不抛错，返回 VerifyResult
 *   assertVerify() -> 失败抛 WorkflowVerifyError
 */

import type { AgentResult } from "../runtime/executor.js"
import { agent } from "../workflow/agent.js"
import { parallel } from "../workflow/parallel.js"
import { phase } from "../workflow/phase.js"
import { parseJsonLoose } from "./json.js"

/** 单个 reviewer 的评审结论 */
export interface ReviewVerdict {
  /** reviewer 序号（1 起） */
  reviewer: number
  verdict: "pass" | "fail"
  summary: string
  issues: string[]
}

export interface VerifyOptions {
  /** 并行评审人数，默认 1；至少 1 */
  reviewers?: number
  /** 验证标准（评审依据），例如「符合登录模块需求，无安全漏洞」 */
  criteria?: string
  /** 结果标签，默认 "semantic verify" */
  label?: string
}

export interface VerifyResult {
  label: string
  /** 所有 reviewer 均 pass 才为 true */
  passed: boolean
  verdicts: ReviewVerdict[]
}

/** assertVerify 失败时抛出，携带完整 VerifyResult 供失败策略消费 */
export class WorkflowVerifyError extends Error {
  readonly result: VerifyResult

  constructor(result: VerifyResult) {
    const failed = result.verdicts
      .filter((v) => v.verdict === "fail")
      .map((v) => `#${v.reviewer}: ${v.summary}`)
      .join("; ")
    super(`[workflow] verify failed: ${result.label}${failed ? ` (${failed})` : ""}`)
    this.name = "WorkflowVerifyError"
    this.result = result
  }
}

/** 输入产物归一化为文本：string 原样，对象取 output 字段或 JSON 序列化 */
function artifactToText(artifact: string | AgentResult | object): string {
  if (typeof artifact === "string") return artifact
  const record = artifact as { output?: unknown }
  if (typeof record.output === "string") return record.output
  return JSON.stringify(artifact, null, 2)
}

function buildReviewerPrompt(
  artifact: string,
  reviewerNo: number,
  reviewers: number,
  criteria?: string,
): string {
  return [
    `你是第 ${reviewerNo}/${reviewers} 号独立评审员。请评审下面的产物，给出严格 JSON 结论。`,
    criteria ? `评审标准：${criteria}` : "评审标准：产物完整、正确、可交付。",
    "",
    "=== 待评审产物 ===",
    artifact,
    "=== 产物结束 ===",
    "",
    '只输出 JSON，不要任何其他文字，格式：',
    '{"verdict":"pass|fail","summary":"一句话结论","issues":["问题1","问题2"]}',
    "pass 与 fail 只能二选一；没有问题时 issues 为空数组。",
  ].join("\n")
}

/** 解析单个 reviewer 的输出为 verdict；解析失败按 fail 处理 */
function toVerdict(reviewer: number, output: string): ReviewVerdict {
  const parsed = parseJsonLoose(output) as
    | { verdict?: unknown; summary?: unknown; issues?: unknown }
    | undefined

  if (
    parsed &&
    (parsed.verdict === "pass" || parsed.verdict === "fail") &&
    typeof parsed.summary === "string"
  ) {
    return {
      reviewer,
      verdict: parsed.verdict,
      summary: parsed.summary,
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.filter((i): i is string => typeof i === "string")
        : [],
    }
  }

  return {
    reviewer,
    verdict: "fail",
    summary: "reviewer output was not valid JSON with verdict/summary",
    issues: [output.slice(0, 200)],
  }
}

/** 语义质量验证：N 个 reviewer 并行评审，全员 pass 才通过；永不抛错 */
export async function verify(
  artifact: string | AgentResult | object,
  options?: VerifyOptions,
): Promise<VerifyResult> {
  const reviewers = Math.max(1, Math.floor(options?.reviewers ?? 1))
  const label = options?.label ?? "semantic verify"

  phase(`Verify(${label}, ${reviewers} reviewer${reviewers > 1 ? "s" : ""})`)

  const text = artifactToText(artifact)

  const outputs = await parallel(
    Array.from({ length: reviewers }, (_, i) => () =>
      agent(buildReviewerPrompt(text, i + 1, reviewers, options?.criteria)),
    ),
  )

  const verdicts = outputs.map((result, i) => toVerdict(i + 1, result.output))
  const passed = verdicts.every((v) => v.verdict === "pass")

  console.log(
    `[agentic-workflow] verify ${passed ? "ok" : "FAIL"}: ${label} ` +
      `(${verdicts.filter((v) => v.verdict === "pass").length}/${verdicts.length} pass)`,
  )

  return { label, passed, verdicts }
}

/** verify 的严格版：失败抛 WorkflowVerifyError，成功原样返回 VerifyResult */
export async function assertVerify(
  artifact: string | AgentResult | object,
  options?: VerifyOptions,
): Promise<VerifyResult> {
  const result = await verify(artifact, options)
  if (!result.passed) {
    throw new WorkflowVerifyError(result)
  }
  return result
}
