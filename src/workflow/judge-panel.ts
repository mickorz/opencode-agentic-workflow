/**
 * judgePanel() —— 评审团打分选优（P1-5，v1-parity）
 *
 * N 个评委 agent 并发给每个候选打 0-10 分（按 rubric），候选均分排序，
 * 最高分胜出；同分稳定取输入顺序靠前者（v1 同语义）。
 *
 * v2 无结构化输出（P1-6 前置调研未完成）——评委 prompt 要求「只回复数字」，
 * 输出经正则解析首个数值；解析失败/超界 = 该评委失败（计入 judgeFailures、
 * 不进均分，fail-loud 统计而非静默丢分）。
 * 某候选全部评委失败 -> 该候选按 0 分参与排序（judgments 为空可辨别）；
 * 所有候选均无有效评分 -> 抛错（无法排序，绝不静默选第一个）。
 *
 * 候选间并发、单个候选的评委间并发；实际 LLM 并发由 executor 层信号量约束。
 */

import { agent, type AgentCallOptions } from "./agent.js"
import { parallel } from "./parallel.js"

export interface JudgePanelOptions {
  /** 评委人数，默认 3（<1 归一为 1） */
  judges?: number
  /** 评分标准（写进评委 prompt），默认 "overall quality and correctness" */
  rubric?: string
  /** agent() 调用级选项透传（model/timeoutMs/retries，P1-4） */
  agent?: AgentCallOptions
}

export interface JudgeVerdict {
  score: number
  raw: string
}

export interface JudgedCandidate<T> {
  index: number
  candidate: T
  /** 成功评委的均分（全部失败 = 0 且 judgments 为空） */
  score: number
  judgments: JudgeVerdict[]
  /** 失败评委数（agent 抛错或输出无法解析为 0-10 数值） */
  judgeFailures: number
}

const SCORE_PATTERN = /-?\d+(?:\.\d+)?/

/** 从评委输出解析 0-10 分值；无法解析或超界返回 undefined */
function parseScore(raw: string): number | undefined {
  const match = raw.match(SCORE_PATTERN)
  if (!match) return undefined
  const value = Number(match[0])
  if (!Number.isFinite(value) || value < 0 || value > 10) return undefined
  return value
}

export async function judgePanel<T>(
  candidates: T[],
  options?: JudgePanelOptions,
): Promise<JudgedCandidate<T>> {
  const judgeSlots = Math.max(1, Math.floor(options?.judges ?? 3))
  const rubric = options?.rubric ?? "overall quality and correctness"

  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("judgePanel() requires a non-empty candidates array")
  }

  const judged = await parallel(
    candidates.map((candidate, index) => async (): Promise<JudgedCandidate<T>> => {
      const text = typeof candidate === "string" ? candidate : JSON.stringify(candidate)
      const verdicts = await parallel(
        Array.from({ length: judgeSlots }, (_v, j) => async (): Promise<JudgeVerdict> => {
          const result = await agent(
            `Rate the following candidate from 0 to 10 on: ${rubric}. ` +
              `Reply with ONLY the numeric score (no words, no explanation).\n\nCandidate:\n${text}`,
            { ...options?.agent },
          )
          const score = parseScore(result.output)
          if (score === undefined) {
            throw new Error(
              `judge ${index + 1}.${j + 1} output is not a 0-10 number: "${result.output.slice(0, 80)}"`,
            )
          }
          return { score, raw: result.output }
        }),
        { onFailure: "partial" },
      )
      const judgments = verdicts.filter((v): v is JudgeVerdict => v !== undefined)
      const judgeFailures = judgeSlots - judgments.length
      const score =
        judgments.length > 0
          ? judgments.reduce((sum, v) => sum + v.score, 0) / judgments.length
          : 0
      return { index, candidate, score, judgments, judgeFailures }
    }),
  )

  // 最高均分；同分稳定取输入顺序靠前者
  let best = judged[0]!
  for (const entry of judged) {
    if (entry.score > best.score || (entry.score === best.score && entry.index < best.index)) {
      best = entry
    }
  }

  const anyJudged = judged.some((entry) => entry.judgments.length > 0)
  if (!anyJudged) {
    throw new Error(
      "judgePanel() could not rank: every candidate lost all judges " +
        "(agent failures or unparseable scores); check judge model/output",
    )
  }

  return best
}
