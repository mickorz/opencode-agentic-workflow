/**
 * feature-development workflow 单元测试 —— 真实临时 git 仓库 + mock executor
 *
 * git 命令链路（rev-parse / 幂等 commit / diff）真实执行于 tmp 仓库；
 * 只有 agent（executor）与 checkpoint 门被 mock。
 * checkCommand 用轻量 shell 命令代替 npm install + test（网络/耗时不适合单测）。
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { writeFileSync, mkdirSync } from "node:fs"

import { setCheckpointGate } from "../../src/quality/checkpoint.js"
import { PolicyCheckpointGate } from "../../src/plugin/policy-checkpoint-gate.js"
import { WorkflowSequenceError } from "../../src/runtime/errors.js"
import { setExecutor } from "../../src/runtime/engine.js"
import {
  NodeCommandRunner,
  setCommandRunner,
} from "../../src/runtime/command.js"
import { sequence, type RunStepsFn } from "../../src/workflow/sequence.js"
import {
  featureDevelopmentWorkflow,
  type FeatureDevState,
} from "../../src/workflows/feature-development.js"

const PASS = JSON.stringify({ verdict: "pass", summary: "ok", issues: [] })

/** 每个槽位一个 handler：返回 output 字符串，可带副作用（写文件模拟实现/修复） */
function agentExecutor(handlers: Array<(prompt: string) => string>) {
  let i = 0
  const prompts: string[] = []
  return {
    prompts,
    executor: {
      async execute(task: { prompt: string }) {
        prompts.push(task.prompt)
        const handler = handlers[Math.min(i, handlers.length - 1)]
        i += 1
        return { output: handler(task.prompt) }
      },
    },
  }
}

/** 在仓库内写文件（自动建父目录），模拟 agent 的实现/修复副作用 */
function writeIn(repo: string, rel: string, content: string): void {
  const abs = path.join(repo, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

/** 真实临时 git 仓库（单 commit 初始状态，含被跟踪的 lockfile 以测坑 1） */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agw-feature-test-"))
  const runner = new NodeCommandRunner()
  const init = await runner.run(
    "git init -q -b main && git config user.email test@example.com && " +
      "git config user.name test && echo hello > README.md && " +
      "echo '{\"lockfileVersion\":3,\"packages\":{}}' > package-lock.json && " +
      "git add -A && git commit -qm init",
    { cwd: dir },
  )
  assert.equal(init.code, 0, `git init failed: ${init.stderr}`)
  return dir
}

function fakeCtx(root: string) {
  return {
    runId: "test-run",
    mode: "start" as const,
    workspaceRoot: root,
    runSteps: sequence as RunStepsFn,
  }
}

test.afterEach(() => {
  setCommandRunner(new NodeCommandRunner())
  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))
})

test("feature-development: 全链路成功（分析 -> 实现 -> check -> commit -> verify x2 -> 审批）", async () => {
  const repo = await makeRepo()
  const recorder = agentExecutor([
    () => "实现计划：新增 src/util.ts + 测试",
    () => {
      writeIn(repo, "src/util.ts", "export const x = 1\n")
      return "done\nsrc/util.ts"
    },
    () => PASS,
    () => PASS,
  ])
  setExecutor(recorder.executor)
  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))

  const report = await featureDevelopmentWorkflow().run(
    { topic: "新增工具函数", checkCommand: "true" },
    fakeCtx(repo),
  )

  // 4 次子任务：分析 + 实现 + 2 reviewer
  assert.equal(recorder.prompts.length, 4)
  assert.ok(recorder.prompts[0]?.includes("新增工具函数"))
  assert.ok(recorder.prompts[1]?.includes("实现计划"))
  assert.ok(recorder.prompts[2]?.includes("完整 diff"))

  assert.match(report.output, /确定性检查 通过/)
  assert.match(report.output, /2\/2 reviewer 通过/)
  assert.match(report.output, /已批准/)
  assert.match(report.output, /分支：main/)

  // 产物已固化为 commit（真实 git 断言）
  const log = await new NodeCommandRunner().run("git log -1 --format=%s", { cwd: repo })
  assert.match(log.stdout, /agentic-workflow\(feature-development\): 新增工具函数/)
  const stat = await new NodeCommandRunner().run("git show --stat --format= HEAD", { cwd: repo })
  assert.match(stat.stdout, /src\/util\.ts/)
})

test("feature-development: check 首败 -> 修复回路（fix agent + 复检）后通过", async () => {
  const repo = await makeRepo()
  const recorder = agentExecutor([
    () => "实现计划：新增 src/util.ts",
    () => {
      writeIn(repo, "src/util.ts", "export const x = 1\n")
      return "done\nsrc/util.ts"
    },
    () => {
      // 修复 agent：补写缺失的标记文件，使 check 命令可通过
      writeIn(repo, "fixed.marker", "")
      return "修复摘要：补写 fixed.marker"
    },
    () => PASS,
    () => PASS,
  ])
  setExecutor(recorder.executor)

  const report = await featureDevelopmentWorkflow().run(
    { topic: "需求 X", checkCommand: "test -f fixed.marker" },
    fakeCtx(repo),
  )

  // 分析 + 实现 + 1 轮修复 + 2 reviewer = 5 次子任务
  assert.equal(recorder.prompts.length, 5)
  assert.ok(recorder.prompts[2]?.includes("未通过确定性检查"))
  assert.match(report.output, /经 1 轮自动修复/)
  assert.match(report.output, /确定性检查 通过/)

  // 修复产物同样进入 commit
  const stat = await new NodeCommandRunner().run("git show --stat --format= HEAD", { cwd: repo })
  assert.match(stat.stdout, /fixed\.marker/)
})

test("feature-development: check 持续失败 -> 修复耗尽后 fail-fast，verify/checkpoint 不执行", async () => {
  const repo = await makeRepo()
  const recorder = agentExecutor([
    () => "实现计划",
    () => "done",
    () => "修复尝试 1",
    () => "修复尝试 2",
  ])
  setExecutor(recorder.executor)

  await assert.rejects(
    () =>
      featureDevelopmentWorkflow().run(
        { topic: "需求 Y", checkCommand: "false" },
        fakeCtx(repo),
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowSequenceError)
      assert.equal(error.errors[0]?.stepIndex, 2)
      assert.equal(error.errors[0]?.stepName, "check")
      return true
    },
  )

  // 分析 + 实现 + 2 轮修复（retry attempts=2），reviewer 从未执行
  assert.equal(recorder.prompts.length, 4)
})

test("feature-development: 未启用隔离（无 workspaceRoot）-> fail-fast 并给出配置指引", async () => {
  const recorder = agentExecutor([() => "不应被执行"])
  setExecutor(recorder.executor)

  await assert.rejects(
    () =>
      featureDevelopmentWorkflow().run({ topic: "需求 Z" }, {
        runId: "test-run",
        mode: "start",
        runSteps: sequence as RunStepsFn,
      }),
    /isolation/,
  )
  assert.equal(recorder.prompts.length, 0)
})

test("feature-development: verify 不通过 -> fail-fast，checkpoint 不执行", async () => {
  const repo = await makeRepo()
  const FAIL = JSON.stringify({ verdict: "fail", summary: "不合格", issues: ["缺测试"] })
  const recorder = agentExecutor([
    () => "实现计划",
    () => {
      writeIn(repo, "src/util.ts", "export const x = 1\n")
      return "done"
    },
    () => FAIL,
  ])
  setExecutor(recorder.executor)

  await assert.rejects(
    () =>
      featureDevelopmentWorkflow().run(
        { topic: "需求 W", checkCommand: "true", reviewers: 1 },
        fakeCtx(repo),
      ),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowSequenceError)
      assert.equal(error.errors[0]?.stepName, "verify")
      return true
    },
  )

  assert.equal(recorder.prompts.length, 3)
})

test("feature-development: 状态为 JSON 可序列化（journal 落盘契约）", async () => {
  const repo = await makeRepo()
  let captured: FeatureDevState | undefined
  const runSteps: RunStepsFn = async (steps, options) => {
    let prev: unknown
    for (const step of steps) {
      prev = await step(prev as never)
    }
    captured = prev as FeatureDevState
    return captured
  }
  const recorder = agentExecutor([
    () => "计划",
    () => {
      writeIn(repo, "src/a.ts", "1")
      return "done"
    },
    () => PASS,
    () => PASS,
  ])
  setExecutor(recorder.executor)

  await featureDevelopmentWorkflow().run(
    { topic: "序列化", checkCommand: "true", reviewers: 2 },
    { runId: "t", mode: "start", workspaceRoot: repo, runSteps },
  )

  // 深度序列化不抛错且往返一致（journal state 契约）
  const round = JSON.parse(JSON.stringify(captured)) as FeatureDevState
  assert.equal(round.baseSha, captured?.baseSha)
  assert.equal(round.checkOk, true)
  assert.equal(round.branch, "main")
  assert.ok(round.commitSha)
  assert.equal(round.verdicts?.length, 2)
})

test("feature-development: 坑1修复——check 引发的 lockfile 重写默认被恢复，不进交付 commit", async () => {
  const repo = await makeRepo()
  const recorder = agentExecutor([
    () => "实现计划：新增 src/util.ts",
    () => {
      writeIn(repo, "src/util.ts", "export const x = 1\n")
      // 模拟 npm install 重写 lockfile 的噪声
      writeIn(repo, "package-lock.json", '{"lockfileVersion":3,"packages":{},"noise":"rewritten-by-install"}')
      return "done\nsrc/util.ts"
    },
    () => PASS,
    () => PASS,
  ])
  setExecutor(recorder.executor)

  await featureDevelopmentWorkflow().run(
    { topic: "需求 L", checkCommand: "true" },
    fakeCtx(repo),
  )

  const stat = await new NodeCommandRunner().run("git show --stat --format= HEAD", { cwd: repo })
  assert.match(stat.stdout, /src\/util\.ts/)
  assert.doesNotMatch(stat.stdout, /package-lock\.json/)
  // worktree 中的噪声也已被恢复（不残留脏文件）
  const dirty = await new NodeCommandRunner().run("git status --porcelain", { cwd: repo })
  assert.equal(dirty.stdout, "")
})

test("feature-development: keepLockfileChanges=true——依赖变更场景保留锁文件", async () => {
  const repo = await makeRepo()
  const recorder = agentExecutor([
    () => "实现计划：新增依赖",
    () => {
      writeIn(repo, "src/util.ts", "export const x = 1\n")
      writeIn(repo, "package-lock.json", '{"lockfileVersion":3,"packages":{},"new":"dep"}')
      return "done"
    },
    () => PASS,
    () => PASS,
  ])
  setExecutor(recorder.executor)

  await featureDevelopmentWorkflow().run(
    { topic: "需求 D", checkCommand: "true", keepLockfileChanges: true },
    fakeCtx(repo),
  )

  const stat = await new NodeCommandRunner().run("git show --stat --format= HEAD", { cwd: repo })
  assert.match(stat.stdout, /package-lock\.json/)
})

test("feature-development: 坑4修复——外部 amend 后 verify 同源现算，报告指向新 commit", async () => {
  const repo = await makeRepo()
  let amendedSha = ""
  const runSteps: RunStepsFn = async (steps) => {
    let prev: unknown
    for (let i = 0; i < steps.length; i++) {
      prev = await steps[i]!(prev as never)
      if (i === 2) {
        // 模拟坑 4：check 落盘后、verify 之前，外部 amend 修正 commit
        const runner = new NodeCommandRunner()
        await runner.run("git commit --amend -m 'amended deliverable' -q", { cwd: repo })
        amendedSha = (await runner.run("git rev-parse HEAD", { cwd: repo })).stdout.trim()
      }
    }
    return prev as FeatureDevState
  }
  const recorder = agentExecutor([
    () => "实现计划",
    () => {
      writeIn(repo, "src/util.ts", "export const x = 1\n")
      return "done"
    },
    () => PASS,
    () => PASS,
  ])
  setExecutor(recorder.executor)

  const report = await featureDevelopmentWorkflow().run(
    { topic: "需求 A", checkCommand: "true", reviewers: 2 },
    { runId: "t", mode: "start", workspaceRoot: repo, runSteps },
  )

  assert.ok(amendedSha, "amend 应已执行")
  // 报告的 commitSha 是 verify 现算的 amend 后新值，而非 journal 缓存的旧值
  assert.ok(report.output.includes(amendedSha.slice(0, 8)))
})
