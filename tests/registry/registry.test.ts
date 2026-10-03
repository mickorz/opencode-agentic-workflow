/**
 * WorkflowRegistry 单元测试 —— 注册/版本解析/发现 + args 校验 + 内置定义
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import { WorkflowRegistry } from "../../src/registry/registry.js"
import { validateArgs, type ArgsSchema } from "../../src/registry/schema.js"
import { WorkflowNotFoundError, WorkflowRegistrationError } from "../../src/registry/errors.js"
import { reliableWorkflow } from "../../src/workflows/reliable.js"
import { smokeWorkflow } from "../../src/workflows/smoke.js"
import { setExecutor } from "../../src/runtime/engine.js"
import { setCheckpointGate } from "../../src/quality/checkpoint.js"
import { PolicyCheckpointGate } from "../../src/plugin/policy-checkpoint-gate.js"

const PASS = JSON.stringify({ verdict: "pass", summary: "ok", issues: [] })

function mockExecutor(outputs: string[]) {
  let i = 0
  return {
    async execute() {
      const output = outputs[Math.min(i, outputs.length - 1)] ?? ""
      i += 1
      return { output }
    },
  }
}

test.afterEach(() => {
  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))
})

function def(id: string, version: string, output = id) {
  return {
    id,
    version,
    description: `${id} workflow`,
    async run() {
      return { output }
    },
  }
}

test("registry: 同 id 多版本共存；同 id+同 version 重复注册抛错", () => {
  const registry = new WorkflowRegistry()
  registry.register(def("game-prd", "1.0.0")).register(def("game-prd", "1.2.0"))
  assert.throws(() => registry.register(def("game-prd", "1.2.0")), /already registered/)
  assert.deepEqual(
    registry.versions("game-prd").map((d) => d.version),
    ["1.0.0", "1.2.0"],
  )
})

test("registry: get(id) 取最新 semver；get(id, version) 精确命中", () => {
  const registry = new WorkflowRegistry()
  registry.register(def("w", "1.0.0")).register(def("w", "1.2.0")).register(def("w", "1.0.10"))
  assert.equal(registry.get("w")?.version, "1.2.0")
  assert.equal(registry.latest("w")?.version, "1.2.0")
  assert.equal(registry.get("w", "1.0.0")?.version, "1.0.0")
  assert.equal(registry.get("w", "9.9.9"), undefined)
})

test("registry: 非 semver 版本排在全部 semver 之后（注册序最后者胜）", () => {
  const registry = new WorkflowRegistry()
  registry.register(def("w", "dev")).register(def("w", "0.1.0"))
  assert.equal(registry.get("w")?.version, "0.1.0")
  registry.register(def("w", "nightly"))
  assert.equal(registry.get("w")?.version, "0.1.0", "semver 恒高于非 semver")
})

test("registry: resolve 未命中抛错并列出可用版本（resume 诊断友好）", () => {
  const registry = new WorkflowRegistry()
  registry.register(def("w", "1.0.0")).register(def("w", "1.2.0"))

  assert.throws(() => registry.resolve("nope"), (error: unknown) => {
    assert.ok(error instanceof WorkflowNotFoundError)
    assert.match(error.message, /workflow not found: nope/)
    return true
  })
  assert.throws(() => registry.resolve("w", "0.9.0"), (error: unknown) => {
    assert.ok(error instanceof WorkflowNotFoundError)
    assert.match(error.message, /w@0\.9\.0/)
    assert.match(error.message, /1\.0\.0, 1\.2\.0/)
    return true
  })
  assert.equal(registry.resolve("w", "1.0.0").version, "1.0.0")
})

test("registry: listLatest / ids / summarize（工具枚举与描述）", () => {
  const registry = new WorkflowRegistry()
  registry
    .register(def("b", "1.0.0"))
    .register(def("a", "1.0.0"))
    .register(def("a", "1.1.0"))
  assert.deepEqual(registry.ids(), ["b", "a"])
  const latest = registry.listLatest()
  assert.deepEqual(
    latest.map((d) => `${d.id}@${d.version}`).sort(),
    ["a@1.1.0", "b@1.0.0"],
  )
  assert.equal(registry.list().length, 3, "list 含全部版本")
  assert.match(registry.summarize(), /a@1\.1\.0: a workflow/)
})

test("validateArgs: required / 类型 / 嵌套 / 数组 / enum / 联合", () => {
  const schema: ArgsSchema = {
    type: "object",
    properties: {
      topic: { type: "string" },
      count: { type: "integer" },
      nested: {
        type: "object",
        properties: { flag: { type: "boolean" } },
        required: ["flag"],
      },
      tags: { type: "array", items: { type: "string" } },
      mode: { enum: ["fast", "slow"] },
      maybe: { type: ["string", "null"] },
    },
    required: ["topic"],
  }
  assert.deepEqual(
    validateArgs(schema, {
      topic: "x",
      count: 3,
      nested: { flag: true },
      tags: ["a"],
      mode: "fast",
      maybe: null,
    }),
    [],
  )
  const problems = validateArgs(schema, {
    topic: 42,
    count: 1.5,
    nested: {},
    tags: ["a", 1],
    mode: "medium",
    maybe: 5,
  })
  assert.ok(problems.some((p) => p.includes("args.topic: expected type string")))
  assert.ok(problems.some((p) => p.includes("args.count")))
  assert.ok(problems.some((p) => p.includes('args.nested: missing required property "flag"')))
  assert.ok(problems.some((p) => p.includes("args.tags[1]: expected type string")))
  assert.ok(problems.some((p) => p.includes("args.mode: expected one of")))
  assert.ok(problems.some((p) => p.includes("args.maybe: expected type string|null")))
  assert.ok(validateArgs(schema, { count: 3 }).some((p) => p.includes('missing required property "topic"')))
  // 无 schema 恒通过
  assert.deepEqual(validateArgs(undefined, "anything"), [])
})

test("内置定义: 元数据 + stepNames + run(ctx.runSteps) 真跑", async () => {
  const smoke = smokeWorkflow()
  assert.equal(smoke.id, "smoke")
  assert.equal(smoke.version, "1.0.0")
  assert.deepEqual(smoke.stepNames, ["research", "summary"])
  assert.ok(smoke.argsSchema?.required?.includes("topic"))

  const reliable = reliableWorkflow()
  assert.equal(reliable.id, "reliable")
  assert.deepEqual(reliable.stepNames, ["execute", "check", "verify", "checkpoint"])

  setExecutor(mockExecutor(["要点A", "要点B", "要点C", "总结"]))
  const inline = (steps: Array<(prev?: unknown) => Promise<unknown>>, options?: unknown) =>
    import("../../src/workflow/sequence.js").then((m) => m.sequence(steps, options as never))
  const smokeResult = await smoke.run({ topic: "T" }, {
    runId: "test-inline",
    mode: "start",
    runSteps: inline as never,
  })
  assert.ok(smokeResult.output.includes("总结"))

  setCheckpointGate(new PolicyCheckpointGate("auto-approve"))
  setExecutor(mockExecutor(["产物", PASS, PASS]))
  const reliableResult = await reliable.run({ topic: "T" }, {
    runId: "test-inline",
    mode: "start",
    runSteps: inline as never,
  })
  assert.ok(reliableResult.output.includes("# Reliable Workflow 报告"))
})

test("注册边界: 缺 id/version 抛错", () => {
  const registry = new WorkflowRegistry()
  assert.throws(
    () => registry.register(def("", "1.0.0")),
    /non-empty id/,
  )
  assert.throws(
    () => registry.register(def("x", "")),
    /non-empty version/,
  )
  void WorkflowRegistrationError
})
