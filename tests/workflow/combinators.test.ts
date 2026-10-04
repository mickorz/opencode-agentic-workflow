/**
 * P1-5 组合子补齐 单测：pipeline / race / judgePanel
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { setExecutor } from "../../src/runtime/engine.js"
import { pipeline } from "../../src/workflow/pipeline.js"
import { race } from "../../src/workflow/race.js"
import { judgePanel } from "../../src/workflow/judge-panel.js"
import { WorkflowPipelineError, WorkflowRaceError } from "../../src/runtime/errors.js"

test.afterEach(() => {
  setExecutor({ async execute() { return { output: "ok" } } })
})

// ── pipeline ────────────────────────────────────────────────────────────

test("pipeline：条目流经阶段链，阶段入参含 (当前值, 原始条目, 下标)", async () => {
  const seen: string[] = []
  const results = await pipeline(
    ["a", "b"],
    [
      (value, original, index) => {
        seen.push(`${value}|${original}|${index}`)
        return value.toUpperCase() as never
      },
      (value) => `${value}!` as never,
    ],
  )
  assert.deepEqual(results, ["A!", "B!"])
  // 阶段按条目独立执行：第一阶段的原始条目/下标正确
  assert.deepEqual(seen.sort(), ["a|a|0", "b|b|1"])
})

test("pipeline：空条目返回 []；空 stages 返回原条目", async () => {
  assert.deepEqual(await pipeline([], [() => 1 as never]), [])
  assert.deepEqual(await pipeline(["x"], []), ["x"])
})

test("pipeline fail-fast：首个失败条目即抛（携带下标）", async () => {
  await assert.rejects(
    pipeline(
      ["ok", "boom", "ok2"],
      [
        (value) => {
          if (value === "boom") throw new Error("stage exploded")
          return value as never
        },
      ],
    ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowPipelineError)
      assert.equal(error.mode, "fail-fast")
      assert.deepEqual(error.failures.map((f) => f.index), [1])
      return true
    },
  )
})

test("pipeline continue：跑完全部，聚合每个失败条目", async () => {
  await assert.rejects(
    pipeline(
      ["a", "boom", "c", "bad"],
      [
        (value) => {
          if (value === "boom" || value === "bad") throw new Error(`fail:${value}`)
          return `${value}-done` as never
        },
      ],
      { onFailure: "continue" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowPipelineError)
      assert.equal(error.mode, "continue")
      assert.deepEqual(error.failures.map((f) => f.index), [1, 3])
      // 成功条目的值保留在 results
      assert.deepEqual(error.results, ["a-done", undefined, "c-done", undefined])
      return true
    },
  )
})

// ── race ────────────────────────────────────────────────────────────────

test("race：首个成功者胜出，迟到的失败被忽略（无 unhandled rejection）", async () => {
  const winner = await race([
    () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late loser")), 30)),
    () => new Promise<string>((resolve) => setTimeout(() => resolve("fast"), 5)),
    () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error("late loser 2")), 30)),
  ])
  assert.equal(winner, "fast")
})

test("race：即使靠后分支先 resolve 也按首达取胜（顺序无关）", async () => {
  const winner = await race([
    () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 25)),
    () => new Promise<number>((resolve) => setTimeout(() => resolve(2), 5)),
  ])
  assert.equal(winner, 2)
})

test("race：全部分支失败 -> WorkflowRaceError 聚合全部原因", async () => {
  await assert.rejects(
    race([
      () => Promise.reject(new Error("e1")),
      () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("e2")), 5)),
    ]),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowRaceError)
      assert.equal(error.failures.length, 2)
      assert.match(error.message, /e1.*e2/)
      return true
    },
  )
})

test("race：空分支数组 = 结构性错误", async () => {
  await assert.rejects(race([]), /at least one branch/)
})

// ── judgePanel ──────────────────────────────────────────────────────────

/** 按候选标记返回评分的 executor：prompt 含 "ALPHA" -> "7"；含 "BETA" -> "9" */
function scoringExecutor(outputFor: (prompt: string) => string) {
  return {
    async execute(task: { prompt: string }) {
      return { output: outputFor(task.prompt) }
    },
  }
}

test("judgePanel：均分最高者胜出，judgments 带原始输出", async () => {
  setExecutor(
    scoringExecutor((prompt) => (prompt.includes("ALPHA") ? "7" : prompt.includes("BETA") ? "9" : "5")),
  )
  const best = await judgePanel(["ALPHA 文本", "BETA 文本"], { judges: 2 })
  assert.equal(best.index, 1)
  assert.equal(best.candidate, "BETA 文本")
  assert.equal(best.score, 9)
  assert.equal(best.judgments.length, 2)
  assert.equal(best.judgeFailures, 0)
})

test("judgePanel：同分稳定取输入顺序靠前者", async () => {
  setExecutor(scoringExecutor(() => "5"))
  const best = await judgePanel(["first", "second"], { judges: 3 })
  assert.equal(best.index, 0)
  assert.equal(best.score, 5)
})

test("judgePanel：评委输出不可解析 = 该评委失败（计入统计、不进均分）", async () => {
  setExecutor(
    scoringExecutor((prompt) => {
      // 候选 A 的所有评委输出无法解析；候选 B 正常
      if (prompt.includes("CAND-A")) return "I cannot rate this"
      return "8"
    }),
  )
  const best = await judgePanel(["CAND-A", "CAND-B"], { judges: 2 })
  // A 全部评委失败 -> 0 分；B 胜出
  assert.equal(best.index, 1)
})

test("judgePanel：所有候选全部评委失败 -> 明确抛错（绝不静默选第一个）", async () => {
  setExecutor(scoringExecutor(() => "no numbers here"))
  await assert.rejects(judgePanel(["a", "b"], { judges: 2 }), /could not rank/)
})

test("judgePanel：非字符串候选 JSON 序列化后可被评委看到；agent 选项透传", async () => {
  const models: Array<unknown> = []
  setExecutor({
    async execute(task: { prompt: string; model?: unknown }) {
      models.push(task.model)
      assert.match(task.prompt, /"feature":"fast"/) // JSON.stringify 的候选文本
      return { output: "6" }
    },
  })
  const best = await judgePanel([{ feature: "fast" }], {
    judges: 1,
    agent: { model: "glm/glm-5.3-flash" },
  })
  assert.equal(best.index, 0)
  assert.deepEqual(models, [{ providerID: "glm", id: "glm-5.3-flash" }])
})
