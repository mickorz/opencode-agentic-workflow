/**
 * Runner workspace 集成测试（P2.7）—— 隔离绑定注入 startWorkflow/resumeWorkflow
 * 覆盖：创建+journal 身份、ctx.workspaceRoot/ambient 注入、cleanup 三策略、
 *       resume attach 原工作区（文件存活）、缺失报错不重建、清理后幂等 resume、agent cwd 下发
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { WorkflowRegistry } from "../../src/registry/registry.js"
import { resumeWorkflow, startWorkflow } from "../../src/registry/runner.js"
import { WorkflowExecutionError } from "../../src/registry/errors.js"
import { FileExecutionStore } from "../../src/state/file-store.js"
import type { ExecutionStore } from "../../src/state/store.js"
import { setExecutor } from "../../src/runtime/engine.js"
import type { AgentExecutor, AgentTask } from "../../src/runtime/executor.js"
import { agent } from "../../src/workflow/agent.js"
import { currentWorkspace } from "../../src/workspace/ambient.js"
import { InPlaceWorkspaceProvider } from "../../src/workspace/in-place.js"
import type {
  WorkspaceHandle,
  WorkspaceIdentity,
  WorkspaceOptions,
  WorkspaceProvider,
} from "../../src/workspace/provider.js"

/** 真实文件系统的假 provider：create=mkdir，attach=校验存在，dispose=rm */
class FakeProvider implements WorkspaceProvider {
  readonly kind = "fake"
  readonly created: string[] = []
  readonly attached: WorkspaceIdentity[] = []
  readonly disposed: string[] = []

  constructor(private readonly baseDir: string) {}

  async create(runId: string, options?: WorkspaceOptions): Promise<WorkspaceHandle> {
    this.created.push(runId)
    const root = options?.path ?? path.join(this.baseDir, runId)
    await fs.mkdir(root, { recursive: true })
    const identity: WorkspaceIdentity = { provider: this.kind, path: root }
    return { root, identity, dispose: () => this.remove(root) }
  }

  async attach(identity: WorkspaceIdentity): Promise<WorkspaceHandle> {
    this.attached.push(identity)
    const stat = await fs.stat(identity.path).catch(() => undefined)
    if (!stat?.isDirectory()) {
      throw new Error(`[fake] workspace missing: ${identity.path}`)
    }
    return { root: identity.path, identity, dispose: () => this.remove(identity.path) }
  }

  private async remove(root: string): Promise<void> {
    this.disposed.push(root)
    await fs.rm(root, { recursive: true, force: true })
  }
}

/** 记录 AgentTask 的假 executor（验证 cwd 下发） */
class RecordingExecutor implements AgentExecutor {
  readonly tasks: AgentTask[] = []
  async execute(task: AgentTask) {
    this.tasks.push(task)
    return { output: `echo:${task.prompt}` }
  }
}

let baseDir: string
let store: ExecutionStore
let provider: FakeProvider

test.before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "agw-runner-ws-"))
})

test.beforeEach(async () => {
  store = new FileExecutionStore(await fs.mkdtemp(path.join(baseDir, "case-")))
  provider = new FakeProvider(await fs.mkdtemp(path.join(baseDir, "ws-")))
})

interface CaseContext {
  workspaceRoot?: string
}

/** 可控 workflow：记录 ctx.workspaceRoot；steps 可写文件/抛错 */
function makeDef(
  id: string,
  steps: Array<(prev: Record<string, unknown> | undefined) => Promise<Record<string, unknown>>>,
  executed: number[],
  seen: CaseContext,
) {
  return {
    id,
    version: "1.0.0",
    description: id,
    argsSchema: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
    stepNames: steps.map((_, i) => `s${i}`),
    async run(
      _args: unknown,
      ctx: {
        runSteps: <T>(s: Array<(p?: T) => Promise<T>>) => Promise<T | undefined>
        workspaceRoot?: string
      },
    ) {
      seen.workspaceRoot = ctx.workspaceRoot
      const wrapped = steps.map((fn, i) => async (prev?: Record<string, unknown>) => {
        executed.push(i)
        return fn(prev)
      })
      const state = (await ctx.runSteps<Record<string, unknown>>(
        wrapped as never,
      )) as Record<string, unknown> | undefined
      return { output: `done:${state?.topic ?? null}` }
    },
  }
}

test("start：创建 workspace、journal 记录身份、ctx.workspaceRoot 注入、步骤内 ambient 可见", async () => {
  const executed: number[] = []
  const seen: CaseContext = {}
  let ambientRoot: string | undefined
  const registry = new WorkflowRegistry().register(
    makeDef(
      "chain",
      [
        async () => {
          ambientRoot = currentWorkspace()?.root
          return { topic: "T" }
        },
      ],
      executed,
      seen,
    ),
  )

  const result = await startWorkflow(registry, store, "chain", { topic: "T" }, {
    workspace: { provider, cleanup: "never" },
  })

  assert.match(result.output, /^done:/)
  assert.deepEqual(executed, [0])
  assert.equal(provider.created.length, 1)

  // journal 身份已持久化
  const run = await store.getRun(result.runId)
  assert.ok(run)
  assert.ok(run.workspace)
  assert.equal(run.workspace.provider, "fake")
  assert.equal(run.workspace.path, seen.workspaceRoot)
  // 步骤内 ambient workspace 指向同一根目录
  assert.equal(ambientRoot, run.workspace.path)
  // run 结束后 ambient 清空
  assert.equal(currentWorkspace(), undefined)
})

test("start 成功 + on-success（默认）：清理 workspace 并清空 journal 字段", async () => {
  const registry = new WorkflowRegistry().register(
    makeDef("chain", [async () => ({ topic: "T" })], [], {}),
  )
  const result = await startWorkflow(registry, store, "chain", { topic: "T" }, {
    workspace: { provider },
  })

  assert.equal(provider.disposed.length, 1)
  const run = await store.getRun(result.runId)
  assert.ok(run)
  assert.equal(run.status, "completed")
  // 关键：清理后 journal 的 workspace 字段被清掉（否则幂等 resume 会 attach 已删目录）
  assert.equal(run.workspace, undefined)
})

test("start 失败 + on-success：保留现场（不清理、不清 journal 字段）", async () => {
  const registry = new WorkflowRegistry().register(
    makeDef(
      "chain",
      [
        async () => ({ topic: "T" }),
        async () => {
          throw new Error("boom")
        },
      ],
      [],
      {},
    ),
  )

  await assert.rejects(
    () => startWorkflow(registry, store, "chain", { topic: "T" }, { workspace: { provider } }),
    (error: unknown) => error instanceof WorkflowExecutionError,
  )

  assert.equal(provider.disposed.length, 0)
  // 从 journal 找回 run（runId 在错误里）
  assert.equal(provider.created.length, 1)
  const runId = provider.created[0]
  if (!runId) throw new Error("unreachable")
  const run = await store.getRun(runId)
  assert.ok(run)
  assert.equal(run.status, "failed")
  assert.ok(run.workspace, "失败 run 必须保留 workspace 身份（resume attach 依据）")
})

test("start 失败 + always：仍清理", async () => {
  const registry = new WorkflowRegistry().register(
    makeDef(
      "chain",
      [
        async () => {
          throw new Error("boom")
        },
      ],
      [],
      {},
    ),
  )

  await assert.rejects(
    () =>
      startWorkflow(registry, store, "chain", { topic: "T" }, {
        workspace: { provider, cleanup: "always" },
      }),
    (error: unknown) => error instanceof WorkflowExecutionError,
  )

  assert.equal(provider.disposed.length, 1)
})

test("resume：attach 原 workspace（同一身份）、文件存活、续跑成功后清理", async () => {
  let failOnce = true
  let artifactDuringRun = ""
  const executed: number[] = []
  const seen: CaseContext = {}
  const registry = new WorkflowRegistry().register(
    makeDef(
      "chain",
      [
        // step0：把文件写进 workspace（模拟 agent 产物）
        async () => {
          const root = currentWorkspace()?.root
          if (!root) throw new Error("workspace missing in step")
          await fs.writeFile(path.join(root, "artifact.md"), "# kept")
          return { topic: "T" }
        },
        // step1：入口先读 workspace 文件（run A 与 resume B 都经过这里，
        // 证明崩溃/重启后续跑期间文件系统状态仍在）；第一次抛错，resume 时成功
        async (prev) => {
          const root = currentWorkspace()?.root
          if (root) {
            artifactDuringRun = await fs.readFile(path.join(root, "artifact.md"), "utf8")
          }
          if (failOnce) {
            failOnce = false
            throw new Error("checkpoint rejected")
          }
          return { ...prev, done: true }
        },
      ],
      executed,
      seen,
    ),
  )

  // Run A：失败，现场保留（step1 已读到文件——run A 期间存在）
  await assert.rejects(
    () => startWorkflow(registry, store, "chain", { topic: "T" }, { workspace: { provider } }),
    (error: unknown) => error instanceof WorkflowExecutionError,
  )
  assert.equal(artifactDuringRun, "# kept")
  const runId = provider.created[0]
  if (!runId) throw new Error("unreachable")
  const runA = await store.getRun(runId)
  assert.ok(runA?.workspace, "失败 run 的 workspace 身份必须保留")
  const artifactPath = path.join(runA.workspace.path, "artifact.md")

  // Run B：resume——attach 原 workspace（同一 identity，不是新建）
  const resumed = await resumeWorkflow(registry, store, runId, {
    workspace: { provider },
  })
  assert.equal(resumed.runId, runId)
  assert.equal(provider.created.length, 1, "resume 绝不新建 workspace")
  assert.equal(provider.attached.length, 1)
  assert.deepEqual(provider.attached[0], runA.workspace)

  // 续跑步骤内部读到了同一文件（durable resume = journal + 文件系统同时恢复）
  assert.equal(artifactDuringRun, "# kept")

  // step0 跳过（journaled completed），仅 step1 重跑
  assert.deepEqual(executed, [0, 1, 1])

  // 成功后清理 + journal 字段清空
  assert.equal(provider.disposed.length, 1)
  await assert.rejects(fs.stat(artifactPath))
  const runB = await store.getRun(runId)
  assert.ok(runB)
  assert.equal(runB.status, "completed")
  assert.equal(runB.workspace, undefined)
})

test("resume：workspace 已被删除 → 报错且绝不重建", async () => {
  const registry = new WorkflowRegistry().register(
    makeDef(
      "chain",
      [
        async () => ({ topic: "T" }),
        async () => {
          throw new Error("boom")
        },
      ],
      [],
      {},
    ),
  )
  await assert.rejects(
    () => startWorkflow(registry, store, "chain", { topic: "T" }, { workspace: { provider } }),
    () => true,
  )
  const runId = provider.created[0]
  if (!runId) throw new Error("unreachable")

  // 人为破坏现场（删除 workspace 目录）
  const runA = await store.getRun(runId)
  assert.ok(runA?.workspace)
  await fs.rm(runA.workspace.path, { recursive: true, force: true })

  await assert.rejects(
    () => resumeWorkflow(registry, store, runId, { workspace: { provider } }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowExecutionError)
      assert.match(error.message, /workspace missing/)
      return true
    },
  )
  assert.equal(provider.created.length, 1, "缺失时不得静默重建")
})

test("resume：已清理的 completed run 幂等重放（无 attach、无创建、无清理副作用）", async () => {
  const registry = new WorkflowRegistry().register(
    makeDef("chain", [async () => ({ topic: "T" })], [], {}),
  )
  const first = await startWorkflow(registry, store, "chain", { topic: "T" }, {
    workspace: { provider },
  })
  assert.equal(provider.disposed.length, 1)

  const again = await resumeWorkflow(registry, store, first.runId, {
    workspace: { provider },
  })
  assert.equal(again.runId, first.runId)
  assert.equal(again.output, first.output)
  assert.equal(provider.attached.length, 0, "workspace 已清理，幂等重放不应 attach")
  assert.equal(provider.created.length, 1)
  assert.equal(provider.disposed.length, 1, "幂等重放不重复清理")
})

test("agent()：workspace 启用时 cwd 下发给 executor；未启用时不带 cwd", async () => {
  const recording = new RecordingExecutor()
  setExecutor(recording)

  const withWs: CaseContext = {}
  const registryWs = new WorkflowRegistry().register(
    makeDef(
      "chain",
      [
        async () => {
          await agent("hi")
          return { topic: "T" }
        },
      ],
      [],
      withWs,
    ),
  )
  await startWorkflow(registryWs, store, "chain", { topic: "T" }, {
    workspace: { provider, cleanup: "never" },
  })
  assert.equal(recording.tasks.length, 1)
  assert.equal(recording.tasks[0]?.cwd, withWs.workspaceRoot)

  recording.tasks.length = 0
  const noWs: CaseContext = {}
  const registryPlain = new WorkflowRegistry().register(
    makeDef(
      "plain",
      [
        async () => {
          await agent("hi")
          return { topic: "T" }
        },
      ],
      [],
      noWs,
    ),
  )
  await startWorkflow(registryPlain, store, "plain", { topic: "T" })
  assert.equal(recording.tasks.length, 1)
  assert.equal(recording.tasks[0]?.cwd, undefined)
  assert.equal(noWs.workspaceRoot, undefined)
})

test("in-place 绑定（无隔离默认）：ctx.workspaceRoot=项目目录、journal 记录 in-place 身份、成功后项目文件保留", async () => {
  const projectDir = await fs.mkdtemp(path.join(baseDir, "proj-"))
  const sentinel = path.join(projectDir, "keep.txt")
  await fs.writeFile(sentinel, "user data")

  const executed: number[] = []
  const seen: CaseContext = {}
  const registry = new WorkflowRegistry().register(
    makeDef("inplace", [async () => ({ topic: "T" })], executed, seen),
  )

  const result = await startWorkflow(registry, store, "inplace", { topic: "T" }, {
    workspace: { provider: new InPlaceWorkspaceProvider({ startDir: projectDir }), cleanup: "never" },
  })

  assert.match(result.output, /^done:/)
  assert.deepEqual(executed, [0])
  // P3 修复核心断言：无隔离时 workspaceRoot 解析到项目目录（而非 process.cwd()）
  assert.equal(seen.workspaceRoot, path.resolve(projectDir))

  const run = await store.getRun(result.runId)
  assert.ok(run?.workspace)
  assert.equal(run.workspace.provider, "in-place")
  assert.equal(run.workspace.path, path.resolve(projectDir))

  // 原地工作区 = 用户项目目录：run 成功后文件原样保留
  assert.equal(await fs.readFile(sentinel, "utf8"), "user data")
})
