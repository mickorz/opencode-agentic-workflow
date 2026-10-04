/**
 * subflow（P2-9 嵌套工作流）单元测试
 * 覆盖：ctx.subflow 存在性、成功 + lineage（parentRunId）、失败 fail-fast 传播、
 *       深度上限、gate 继承（run 级门下传）、workspace 继承与父作用域不被清掉
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { WorkflowRegistry } from "../../src/registry/registry.js"
import {
  MAX_SUBFLOW_DEPTH,
  runWorkflowInline,
  startWorkflow,
} from "../../src/registry/runner.js"
import { WorkflowExecutionError } from "../../src/registry/errors.js"
import { FileExecutionStore } from "../../src/state/file-store.js"
import type { ExecutionStore } from "../../src/state/store.js"
import { setExecutor } from "../../src/runtime/engine.js"
import type { AgentTask } from "../../src/runtime/executor.js"
import { agent } from "../../src/workflow/agent.js"
import { createEventBus, setEventBus } from "../../src/observability/events.js"
import { setCheckpointGate } from "../../src/quality/checkpoint.js"
import { checkpoint } from "../../src/quality/checkpoint.js"
import { PolicyCheckpointGate } from "../../src/plugin/policy-checkpoint-gate.js"
import { currentWorkspace } from "../../src/workspace/ambient.js"
import type {
  WorkspaceHandle,
  WorkspaceIdentity,
  WorkspaceOptions,
  WorkspaceProvider,
} from "../../src/workspace/provider.js"

interface Ctx {
  runSteps<T>(steps: Array<(p?: T) => Promise<T>>): Promise<T | undefined>
  subflow?<TArgs>(id: string, args?: TArgs, options?: { version?: string }): Promise<{ runId: string; output: string }>
}

let baseDir: string
let store: ExecutionStore

test.before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-subflow-"))
})

test.beforeEach(async () => {
  store = new FileExecutionStore(await fs.mkdtemp(path.join(baseDir, "case-")))
  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))
})

function makeRegistry() {
  return new WorkflowRegistry()
}

/** 纯函数步骤的 workflow 定义 */
function def(
  id: string,
  steps: Array<(ctx: Ctx) => Promise<unknown>>,
  extra?: { argsSchema?: object },
) {
  return {
    id,
    version: "1.0.0",
    stepNames: steps.map((_, i) => `s${i}`),
    ...(extra?.argsSchema ? { argsSchema: extra.argsSchema } : {}),
    async run(_args: unknown, ctx: Ctx) {
      let prev: unknown
      for (const step of steps) {
        prev = await step(ctx)
      }
      return { output: typeof prev === "string" ? prev : JSON.stringify(prev ?? null) }
    },
  }
}

test("ctx.subflow 存在性：journal 路径提供；inline 路径不提供", async () => {
  const registry = makeRegistry()
  registry.register(
    def("parent", [
      (ctx) => {
        assert.equal(typeof ctx.subflow, "function")
        return "seen"
      },
    ]),
  )
  await startWorkflow(registry, store, "parent", { topic: "t" })

  let inlineSeen: unknown = "unset"
  registry.register(
    def("inline-probe", [
      (ctx) => {
        inlineSeen = ctx.subflow
        return "ok"
      },
    ]),
  )
  await runWorkflowInline(registry, "inline-probe", { topic: "t" })
  assert.equal(inlineSeen, undefined)
})

test("成功链路：子 run 独立 journal + parentRunId lineage；输出回传父步骤", async () => {
  const registry = makeRegistry()
  registry.register(
    def("child", [() => Promise.resolve("child-output")], {
      argsSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
    }),
  )
  let childResult: { runId: string; output: string } | undefined
  registry.register(
    def("parent", [
      async (ctx) => {
        childResult = await ctx.subflow!("child", { topic: "t" })
        return `wrapped:${childResult.output}`
      },
    ]),
  )

  const parent = await startWorkflow(registry, store, "parent", { topic: "t" })
  assert.equal(parent.output, "wrapped:child-output")

  // lineage：子 run 的 journal 指回父 run
  const childRun = await store.getRun(childResult!.runId)
  assert.ok(childRun)
  assert.equal(childRun.parentRunId, parent.runId)
  assert.equal(childRun.status, "completed")
  assert.equal(childRun.workflow.id, "child")

  const parentRun = await store.getRun(parent.runId)
  assert.ok(parentRun)
  assert.equal(parentRun.parentRunId, undefined)
  assert.equal(parentRun.status, "completed")
})

test("失败传播：子 run 失败 -> 父步骤失败（fail-fast），双方 journal 都 failed", async () => {
  const registry = makeRegistry()
  registry.register(
    def("boom", [
      () => {
        throw new Error("child exploded")
      },
    ]),
  )
  registry.register(def("parent", [(ctx) => ctx.subflow!("boom", {})]))

  await assert.rejects(
    startWorkflow(registry, store, "parent", {}),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowExecutionError)
      return true
    },
  )
  const runs = await store.listRuns()
  const child = runs.find((r) => r.workflow.id === "boom")
  const parent = runs.find((r) => r.workflow.id === "parent")
  assert.equal(child?.status, "failed")
  assert.equal(parent?.status, "failed")
})

test("深度上限：MAX_SUBFLOW_DEPTH 层嵌套可过，超一层明确报错", async () => {
  assert.equal(MAX_SUBFLOW_DEPTH, 3)
  const registry = makeRegistry()
  // depth3 -> subflow depth2 -> subflow depth1（三层成功）
  registry.register(def("leaf", [() => Promise.resolve("leaf")]))
  registry.register(def("mid", [(ctx) => ctx.subflow!("leaf", {})]))
  registry.register(def("top", [(ctx) => ctx.subflow!("mid", {})]))
  const ok = await startWorkflow(registry, store, "top", {})
  assert.equal(ok.status ?? "completed", "completed")
  const runs = await store.listRuns()
  assert.equal(runs.filter((r) => r.status === "completed").length, 3)

  // 四层：deeper -> deep -> top -> mid -> leaf，最内层 depth=4 超限
  registry.register(def("deep", [(ctx) => ctx.subflow!("top", {})]))
  registry.register(def("deeper", [(ctx) => ctx.subflow!("deep", {})]))
  await assert.rejects(
    startWorkflow(registry, store, "deeper", {}),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.ok(message.includes("nesting too deep"), message)
      return true
    },
  )
})

test("gate 继承：父 run 的 run 级 gate 下传子 run 的 checkpoint", async () => {
  const asks: string[] = []
  const recordingGate = {
    async ask(request: { label: string }) {
      asks.push(request.label)
      return { approved: true }
    },
  }
  const registry = makeRegistry()
  registry.register(
    def("gated-child", [
      async () => {
        await checkpoint("child-gate", { label: "child-gate" })
        return "passed"
      },
    ]),
  )
  registry.register(def("gated-parent", [(ctx) => ctx.subflow!("gated-child", {})]))

  // run 级 gate（非全局）：子 checkpoint 必须走到它
  const result = await startWorkflow(registry, store, "gated-parent", {}, {
    gate: recordingGate,
  })
  assert.ok(result.output.includes("passed"))
  assert.deepEqual(asks, ["child-gate"])
})

/** 真实目录的最小 provider（create/attach/dispose） */
class MinimalProvider implements WorkspaceProvider {
  readonly kind = "minimal"
  constructor(private readonly baseDir: string) {}
  async create(runId: string, options?: WorkspaceOptions): Promise<WorkspaceHandle> {
    const root = options?.path ?? path.join(this.baseDir, runId)
    await fs.mkdir(root, { recursive: true })
    const identity: WorkspaceIdentity = { provider: this.kind, path: root }
    return { root, identity, dispose: async () => {} }
  }
  async attach(identity: WorkspaceIdentity): Promise<WorkspaceHandle> {
    return { root: identity.path, identity, dispose: async () => {} }
  }
}

test("workspace 继承 + 回归：子 run 不清掉父 run 的工作区环境", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "agw-ws-"))
  const provider = new MinimalProvider(base)
  const registry = makeRegistry()
  registry.register(def("ws-child", [() => Promise.resolve("c")]))
  const seen: Array<string | undefined> = []
  registry.register(
    def("ws-parent", [
      async (ctx) => {
        // 步骤 1：记录父 run 的工作区（隔离绑定创建）
        seen.push(currentWorkspace()?.root)
        await ctx.subflow!("ws-child", {})
        // 步骤 2（子 run 完成后）：父工作区必须仍然可见——
        // 旧全局单例实现会在此处读到 undefined（子 run 收口清掉了全局）
        seen.push(currentWorkspace()?.root)
        return "done"
      },
    ]),
  )
  const result = await startWorkflow(registry, store, "ws-parent", {}, {
    workspace: { provider, cleanup: "never" },
  })
  assert.equal(result.output, "done")
  assert.equal(seen.length, 2)
  // 父 run 的工作区（FakeProvider 按 runId 建目录）在子 run 前后一致可见
  assert.ok(seen[0]?.startsWith(base), `first=${seen[0]}`)
  assert.equal(seen[1], seen[0])
})

test("P2-8b 集成：agent() 事件带 runId 聚合到各自 journal（subflow 互不串账）", async () => {
  const bus = createEventBus()
  setEventBus(bus)
  try {
    // executor 回传 usage + model（走真实 agent() -> emitEvent -> journal 订阅链）
    setExecutor({
      async execute(task: AgentTask) {
        return {
          output: `out:${task.prompt}`,
          usage: { input: 11, output: 4, reasoning: 1, cache: { read: 0, write: 0 } },
          model: "glm/glm-5.3-flash",
        }
      },
    })
    const topicSchema = {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    }
    // 注意：def() 直跑步骤不经 ctx.runSteps（journal 无步骤记录）——本测试
    // 需要 journal 步骤账本，故用 runSteps 包装（runner.test.ts makeDef 模式）
    const registry = makeRegistry()
    registry.register({
      id: "meta-child",
      version: "1.0.0",
      description: "child",
      argsSchema: topicSchema,
      stepNames: ["child-agent"],
      async run(_args: unknown, ctx: Ctx) {
        const state = (await ctx.runSteps([
          async () => (await agent("child-prompt")).output,
        ])) as { "child-agent"?: string } | undefined
        return { output: `child:${state?.["child-agent"] ?? ""}` }
      },
    })
    let childRunId = ""
    registry.register({
      id: "meta-parent",
      version: "1.0.0",
      description: "parent",
      stepNames: ["parent-agent", "spawn"],
      async run(_args: unknown, ctx: Ctx) {
        const child = await ctx.subflow!("meta-child", { topic: "t" })
        childRunId = child.runId
        const state = (await ctx.runSteps([
          async () => (await agent("parent-prompt")).output,
          async () => child.output,
        ])) as Record<string, unknown> | undefined
        return { output: `parent:${JSON.stringify(state ?? {})}` }
      },
    })

    const result = await startWorkflow(registry, store, "meta-parent", { topic: "t" })
    const parent = await store.getRun(result.runId)
    assert.equal(parent?.status, "completed")

    // 父步骤 0（自己的 agent 调用）：元数据落账
    assert.deepEqual(parent?.steps[0]?.usage, { input: 11, output: 4, reasoning: 1 })
    assert.equal(parent?.steps[0]?.model, "glm/glm-5.3-flash")
    // 父步骤 1（subflow 结果步）：子的 agent 不串到父账上
    assert.equal(parent?.steps[1]?.usage, undefined)
    assert.equal(parent?.steps[1]?.model, undefined)

    // 子 journal：自己的 agent 元数据（runId 作用域隔离的正向证明）
    const child = await store.getRun(childRunId)
    assert.equal(child?.status, "completed")
    assert.deepEqual(child?.steps[0]?.usage, { input: 11, output: 4, reasoning: 1 })
    assert.equal(child?.steps[0]?.model, "glm/glm-5.3-flash")
  } finally {
    setEventBus(createEventBus())
  }
})
