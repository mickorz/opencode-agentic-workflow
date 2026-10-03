/**
 * Registry Runner 集成测试 —— startWorkflow / resumeWorkflow / runWorkflowInline
 * 覆盖：journal 版本身份落盘、失败收口、精确版本恢复、completed 前缀跳过、幂等
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { WorkflowRegistry } from "../../src/registry/registry.js"
import {
  resumeWorkflow,
  runWorkflowInline,
  startWorkflow,
} from "../../src/registry/runner.js"
import {
  WorkflowArgsError,
  WorkflowExecutionError,
  WorkflowNotFoundError,
} from "../../src/registry/errors.js"
import { FileExecutionStore } from "../../src/state/file-store.js"
import type { ExecutionStore } from "../../src/state/store.js"

let baseDir: string
let store: ExecutionStore

test.before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-runner-"))
})

test.beforeEach(async () => {
  // 每个测试独立子目录，隔离前面测试留下的 run 文件
  store = new FileExecutionStore(await fs.mkdtemp(path.join(baseDir, "case-")))
})

/** 可控 workflow：steps 由测试注入，记录执行序号 */
function makeDef(
  id: string,
  version: string,
  steps: Array<(prev?: unknown) => Promise<unknown>>,
  executed?: number[],
) {
  return {
    id,
    version,
    description: `${id}@${version}`,
    argsSchema: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
    stepNames: steps.map((_, i) => `s${i}`),
    async run(_args: unknown, ctx: { runSteps: <T>(s: Array<(p?: T) => Promise<T>>) => Promise<T | undefined> }) {
      const wrapped = steps.map((fn, i) => async (prev?: unknown) => {
        executed?.push(i)
        return fn(prev)
      })
      const state = (await ctx.runSteps<Record<string, unknown>>(wrapped as never, {
        stepNames: steps.map((_, i) => `s${i}`),
      })) as Record<string, unknown> | undefined
      return { output: `done:${JSON.stringify(state?.topic ?? null)}` }
    },
  }
}

test("startWorkflow: journal 记录 workflow {id,version} + args + steps，run 完成", async () => {
  const registry = new WorkflowRegistry().register(
    makeDef("chain", "1.2.0", [async () => ({ topic: "A" }), async (prev) => ({ ...prev, more: 1 })]),
  )
  const result = await startWorkflow(registry, store, "chain", { topic: "T" })

  assert.match(result.output, /^done:/)
  assert.equal(result.workflow.id, "chain")
  assert.equal(result.workflow.version, "1.2.0")

  const run = await store.getRun(result.runId)
  assert.ok(run)
  assert.deepEqual(run.workflow, { id: "chain", version: "1.2.0" })
  assert.deepEqual(run.args, { topic: "T" })
  assert.equal(run.status, "completed")
  assert.deepEqual(
    run.steps.map((s) => s.status),
    ["completed", "completed"],
  )
})

test("startWorkflow: args 非法 / 未知 id 抛错且不产生 journal", async () => {
  const registry = new WorkflowRegistry().register(makeDef("chain", "1.0.0", [async () => ({})]))
  await assert.rejects(
    () => startWorkflow(registry, store, "chain", { topic: 42 }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowArgsError)
      return true
    },
  )
  await assert.rejects(
    () => startWorkflow(registry, store, "ghost", {}),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowNotFoundError)
      return true
    },
  )
  assert.deepEqual(await store.listRuns(), [])
})

test("startWorkflow: 步骤失败 -> journal failed + WorkflowExecutionError(runId)", async () => {
  const boom = new Error("transient")
  const registry = new WorkflowRegistry().register(
    makeDef("chain", "1.0.0", [
      async () => ({ topic: "A" }),
      async () => {
        throw boom
      },
      async (prev) => ({ ...prev, never: true }),
    ]),
  )
  await assert.rejects(
    () => startWorkflow(registry, store, "chain", { topic: "T" }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowExecutionError)
      assert.ok(error.runId.startsWith("run_"))
      return true
    },
  )
  const runs = await store.listRuns()
  assert.equal(runs.length, 1)
  assert.equal(runs[0]?.status, "failed")
  assert.deepEqual(
    runs[0]?.steps.map((s) => s.status),
    ["completed", "failed", "skipped"],
  )
})

test("resumeWorkflow: 精确版本恢复（绝不隐式取最新）", async () => {
  // v1.0.0 可用；v1.1.0 若被误用会直接抛错
  const executed: number[] = []
  // 模拟「首跑环境故障，恢复前已修复」：broken 标志在两次执行间翻转
  let broken = true
  const v1 = makeDef(
    "chain",
    "1.0.0",
    [
      async () => ({ topic: "A" }),
      async () => {
        if (broken) throw new Error("first attempt fails")
        return { fixed: true }
      },
      async (prev) => ({ ...prev, done: true }),
    ],
    executed,
  )
  const v2 = makeDef("chain", "1.1.0", [
    async () => {
      throw new Error("v1.1.0 must NOT be used for resume")
    },
  ])
  const registry = new WorkflowRegistry().register(v1).register(v2)

  const failed = await startWorkflow(registry, store, "chain", { topic: "T" }, {
    version: "1.0.0",
  }).catch((error: unknown) => error as WorkflowExecutionError)
  assert.ok(failed instanceof WorkflowExecutionError)
  assert.equal(failed.workflowVersion, "1.0.0")

  // 故障修复后恢复：step0 跳过，仅 1/2 重跑
  broken = false
  executed.length = 0
  const resumed = await resumeWorkflow(registry, store, failed.runId)
  assert.deepEqual(executed, [1, 2], "step0 跳过（completed 前缀），1/2 重跑")
  assert.match(resumed.output, /done:/)

  const run = await store.getRun(failed.runId)
  assert.equal(run?.status, "completed")
  assert.deepEqual(
    run?.steps.map((s) => s.status),
    ["completed", "completed", "completed"],
  )
})

test("resumeWorkflow: 精确版本未注册 -> 明确报错并列出版本", async () => {
  const registryA = new WorkflowRegistry().register(
    makeDef("chain", "1.0.0", [
      async () => ({ topic: "A" }),
      async () => {
        throw new Error("fail")
      },
    ]),
  )
  const failed = await startWorkflow(registryA, store, "chain", { topic: "T" }).catch(
    (error: unknown) => error as WorkflowExecutionError,
  )
  assert.ok(failed instanceof WorkflowExecutionError)

  // 新 registry 只注册了 1.1.0（旧版本下线）——恢复 1.0.0 journal 必须报错
  const registryB = new WorkflowRegistry().register(makeDef("chain", "1.1.0", [async () => ({})]))
  await assert.rejects(
    () => resumeWorkflow(registryB, store, failed.runId),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowNotFoundError)
      assert.match(error.message, /chain@1\.0\.0/)
      assert.match(error.message, /1\.1\.0/)
      return true
    },
  )
})

test("resumeWorkflow: 已完成 run 幂等重放（零步骤执行）", async () => {
  const executed: number[] = []
  const registry = new WorkflowRegistry().register(
    makeDef(
      "chain",
      "1.0.0",
      [async () => ({ topic: "A" }), async (prev) => ({ ...prev, done: true })],
      executed,
    ),
  )
  const first = await startWorkflow(registry, store, "chain", { topic: "T" })
  executed.length = 0
  const second = await resumeWorkflow(registry, store, first.runId)
  assert.deepEqual(executed, [])
  assert.equal(second.output, first.output)
  assert.equal(second.runId, first.runId)
})

test("resumeWorkflow: run 不存在 / 无 store runId 报错", async () => {
  const registry = new WorkflowRegistry()
  await assert.rejects(
    () => resumeWorkflow(registry, store, "run_missing"),
    /run not found/,
  )
})

test("runWorkflowInline: 直跑不走 journal；args 校验同样生效", async () => {
  const registry = new WorkflowRegistry().register(
    makeDef("chain", "1.0.0", [async () => ({ topic: "A" })]),
  )
  const result = await runWorkflowInline(registry, "chain", { topic: "T" })
  assert.match(result.output, /^done:/)
  assert.deepEqual(await store.listRuns(), [])

  await assert.rejects(() => runWorkflowInline(registry, "chain", {}), WorkflowArgsError)
})
