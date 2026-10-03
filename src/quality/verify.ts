/**
 * verify —— 语义质量验证节点（P1.2）
 *
 * 与 check 的职责边界：
 *   check = 确定性验证（谓词求值，可重复）
 *   verify = 语义质量验证（reviewer agent 评审「做得对不对/好不好」）
 *
 * 机制：
 *   verify(artifact, { reviewers: N, criteria, reviewerProtocol })
 *     -> N 个 reviewer 子 agent 并行评审（复用 parallel() 组合子）
 *     -> 每个 reviewer 被要求输出 JSON verdict
 *     -> 三种结局严格分离（v0.3.1 坑 3 修复）：
 *          a) 语义结论 pass/fail —— 不重试（拒绝就是拒绝，禁止「问到同意为止」）
 *          b) 解析失败（非法 JSON / 缺字段 / 非法 enum）—— 仅此类局部重试，
 *             修复指令只要求重出格式，不重新评审；默认 attempts=2
 *          c) 重试耗尽 —— 抛 ReviewerProtocolError（协议失败），
 *             绝不与「评审否决」混同：产物没有被否定，可安全 resume
 *     -> 全员 pass 才 passed=true（严格语义；后续失败策略在此之上构建）
 *
 * 与 check 对称的双 API：
 *   verify()       -> 语义结果永不抛错（协议失败除外：那不是评审结论，是运维事故）
 *   assertVerify() -> 语义失败抛 WorkflowVerifyError；协议失败原样上抛 ReviewerProtocolError
 */

import type { AgentResult } from "../runtime/executor.js"
import { WorkflowError } from "../runtime/errors.js"
import { emitEvent } from "../observability/events.js"
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
  /** reviewer 协议容错：解析失败时的局部重试策略（默认 attempts=2） */
  reviewerProtocol?: ReviewerProtocolOptions
}

/** reviewer 协议容错选项（只作用于解析失败，不作用于语义否决） */
export interface ReviewerProtocolOptions {
  /** 单 reviewer 最大尝试次数（含首次），默认 2；最小 1（即不重试） */
  attempts?: number
}

export interface VerifyResult {
  label: string
  /** 所有 reviewer 均 pass 才为 true */
  passed: boolean
  verdicts: ReviewVerdict[]
}

/** assertVerify 失败时抛出，携带完整 VerifyResult 供失败策略消费 */
export class WorkflowVerifyError extends WorkflowError {
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

/**
 * reviewer 协议失败（解析重试耗尽）——与语义否决严格分离（v0.3.1 坑 3 修复）。
 *
 * 语义区别（用户可见诊断的关键）：
 *   WorkflowVerifyError  = 评审员看了产物，结论是「不合格」  → 产物被否定
 *   ReviewerProtocolError = 评审员的输出无法解析，评审没有完成 → 产物未被否定，可安全 resume
 */
export class ReviewerProtocolError extends WorkflowError {
  readonly reviewer: number
  readonly attempts: number
  readonly lastRaw: string

  constructor(label: string, reviewer: number, attempts: number, lastRaw: string) {
    super(
      `[workflow] verification could not be completed: reviewer #${reviewer} ` +
        `returned invalid structured output after ${attempts} attempt` +
        `${attempts > 1 ? "s" : ""} (label: ${label}). ` +
        `This is a protocol failure, NOT a semantic rejection - ` +
        `the artifact was not judged; resume to retry verify.`,
    )
    this.name = "ReviewerProtocolError"
    this.reviewer = reviewer
    this.attempts = attempts
    this.lastRaw = lastRaw
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
    '只输出 JSON，不要任何其他文字，也不要调用任何工具，直接给出结论，格式：',
    '{"verdict":"pass|fail","summary":"一句话结论","issues":["问题1","问题2"]}',
    "pass 与 fail 只能二选一；没有问题时 issues 为空数组。",
  ].join("\n")
}

/**
 * 解析单个 reviewer 的输出为 verdict。
 * 返回 undefined = 协议失败（非法 JSON / 缺字段 / 非法 enum）——
 * 由调用方走局部重试，绝不在此伪造成「fail」（坑 3：协议失败 ≠ 评审否决）。
 */
function toVerdict(reviewer: number, output: string): ReviewVerdict | undefined {
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

  return undefined
}

/**
 * 解析失败的修复指令：只要求重出格式，不重新评审（低 token、聚焦协议修复）。
 * 保留原 prompt（含产物与评审标准）因为子 agent 每次调用都是无状态新会话。
 */
function buildRepairPrompt(originalPrompt: string, lastRaw: string): string {
  return [
    originalPrompt,
    "",
    "=== 重要：你上一次的响应无法解析为 JSON ===",
    "Your previous response could not be parsed.",
    "Return JSON only. Do not include markdown fences or explanation.",
    "",
    "=== 上一次无法解析的输出（供对照，勿原样重复） ===",
    lastRaw.slice(0, 1000),
    "",
    "请重新给出严格 JSON 结论（内容可沿用你上一次的判断，只需修正格式）。",
  ].join("\n")
}

/**
 * 单 reviewer 的结局（v0.3.1 坑 3 修复，三态模型）：
 *   "reviewed"         —— 产出语义结论（verdict.pass 或 verdict.fail，二者都不重试）
 *   "invalid-response" —— 协议失败（解析重试耗尽），绝不伪装成语义否决
 */
type ReviewerOutcome =
  | { status: "reviewed"; verdict: ReviewVerdict }
  | {
      status: "invalid-response"
      reviewer: number
      attempts: number
      lastRaw: string
    }

/**
 * 语义质量验证：N 个 reviewer 并行评审，全员 pass 才通过。
 * 语义结果永不抛错；协议失败（解析重试耗尽）抛 ReviewerProtocolError——
 * 那不是评审结论，是运维事故：产物未被否定，可安全 resume 重试 verify。
 */
export async function verify(
  artifact: string | AgentResult | object,
  options?: VerifyOptions,
): Promise<VerifyResult> {
  const reviewers = Math.max(1, Math.floor(options?.reviewers ?? 1))
  const label = options?.label ?? "semantic verify"
  const attempts = Math.max(1, Math.floor(options?.reviewerProtocol?.attempts ?? 2))

  phase(`Verify(${label}, ${reviewers} reviewer${reviewers > 1 ? "s" : ""})`)

  const text = artifactToText(artifact)

  // 单 reviewer：仅解析失败局部重试（修复格式，不重新评审）；语义结论不重试
  const runReviewer = async (no: number): Promise<ReviewerOutcome> => {
    const basePrompt = buildReviewerPrompt(text, no, reviewers, options?.criteria)
    let lastRaw = ""
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await agent(
        attempt === 1 ? basePrompt : buildRepairPrompt(basePrompt, lastRaw),
      )
      lastRaw = result.output
      const verdict = toVerdict(no, result.output)
      if (verdict) return { status: "reviewed", verdict }
    }
    return { status: "invalid-response", reviewer: no, attempts, lastRaw }
  }

  // 协议失败以哨兵值穿透 parallel（避免被 WorkflowParallelError 包装），在外层统一抛
  const outcomes = await parallel(
    Array.from({ length: reviewers }, (_, i) => () => runReviewer(i + 1)),
  )

  const protocolFailure = outcomes.find((o) => o.status === "invalid-response")
  if (protocolFailure) {
    emitEvent({
      type: "verify.protocol_failed",
      label,
      reviewer: protocolFailure.reviewer,
      attempts: protocolFailure.attempts,
      lastRaw: protocolFailure.lastRaw.slice(0, 200),
    })
    throw new ReviewerProtocolError(
      label,
      protocolFailure.reviewer,
      protocolFailure.attempts,
      protocolFailure.lastRaw,
    )
  }

  const verdicts = outcomes.map(
    (o) => (o as { status: "reviewed"; verdict: ReviewVerdict }).verdict,
  )
  const passed = verdicts.every((v) => v.verdict === "pass")

  console.log(
    `[agentic-workflow] verify ${passed ? "ok" : "FAIL"}: ${label} ` +
      `(${verdicts.filter((v) => v.verdict === "pass").length}/${verdicts.length} pass)`,
  )

  emitEvent({
    type: "verify.completed",
    label,
    passed,
    passedCount: verdicts.filter((v) => v.verdict === "pass").length,
    totalCount: verdicts.length,
  })

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
