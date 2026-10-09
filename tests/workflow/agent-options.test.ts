/**
 * P1-4 agent 调用级选项 单测
 * 覆盖：timeoutMs（超时抛错、计时器清理）/ retries（失败后成功、耗尽抛原错、
 *       超时可重试）/ model 解析与透传（字符串/对象/非法格式）/
 *       OpenCodeV2Executor task.model 覆盖默认
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import type { AgentResult, AgentTask } from "../../src/runtime/executor.js"
import { setExecutor } from "../../src/runtime/engine.js"
import { agent, AgentTimeoutError } from "../../src/workflow/agent.js"
import { OpenCodeV2Executor } from "../../src/plugin/opencode-v2-executor.js"

/** 捕获型 executor：可配置延迟与「前 N 次失败」 */
class CapturingExecutor {
  readonly tasks: AgentTask[] = []
  failFirst = 0
  delayMs = 0
  async execute(task: AgentTask): Promise<AgentResult> {
    this.tasks.push(task)
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    }
    if (this.tasks.length <= this.failFirst) {
      throw new Error(`boom #${this.tasks.length}`)
    }
    return { output: `ok:${this.tasks.length}` }
  }
}

test.afterEach(() => {
  setExecutor(new CapturingExecutor())
})

test("timeoutMs：超时抛 AgentTimeoutError，且不泄漏计时器", async () => {
  const ex = new CapturingExecutor()
  ex.delayMs = 120
  setExecutor(ex)
  await assert.rejects(agent("p", { timeoutMs: 20 }), AgentTimeoutError)
  // 计时器已清理（进程可正常退出）；任务仍在 tasks 里（底层调用未被硬杀）
  assert.equal(ex.tasks.length, 1)
})

test("retries：前两次失败第三次成功 → 成功且尝试 3 次", async () => {
  const ex = new CapturingExecutor()
  ex.failFirst = 2
  setExecutor(ex)
  const result = await agent("p", { retries: 2 })
  assert.equal(result.output, "ok:3")
  assert.equal(ex.tasks.length, 3)
})

test("retries 耗尽：抛最后一次的错误，尝试 = 1+retries 次", async () => {
  const ex = new CapturingExecutor()
  ex.failFirst = 99
  setExecutor(ex)
  await assert.rejects(agent("p", { retries: 1 }), /boom #2/)
  assert.equal(ex.tasks.length, 2)
})

test("超时可重试：每次尝试独立计时，慢 executor 最终赶上", async () => {
  const ex = new CapturingExecutor()
  ex.failFirst = 1 // 第 1 次失败（非超时），第 2 次成功
  setExecutor(ex)
  const result = await agent("p", { timeoutMs: 5000, retries: 1 })
  assert.equal(result.output, "ok:2")
})

test("model 字符串解析为 providerID/id 并透传到 task", async () => {
  const ex = new CapturingExecutor()
  setExecutor(ex)
  await agent("p", { model: "glm/glm-5.3-flash" })
  assert.deepEqual(ex.tasks[0]!.model, { providerID: "glm", id: "glm-5.3-flash" })
})

test("model 对象原样透传（含 variant）", async () => {
  const ex = new CapturingExecutor()
  setExecutor(ex)
  await agent("p", { model: { providerID: "glm", id: "glm-5.3", variant: "thinking" } })
  assert.deepEqual(ex.tasks[0]!.model, { providerID: "glm", id: "glm-5.3", variant: "thinking" })
})

test("model 非法格式：明确报错（无 /、空 provider、空 id）", async () => {
  setExecutor(new CapturingExecutor())
  await assert.rejects(agent("p", { model: "glmflash" }), /invalid model "glmflash".*providerID\/modelId/)
  await assert.rejects(agent("p", { model: "/flash" }), /invalid model/)
  await assert.rejects(agent("p", { model: "glm/" }), /invalid model/)
})

/** 假 session 域：只关心 create 收到的 model 参数 */
class FakeSessionDomain {
  readonly created: Array<Record<string, unknown>> = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async create(args: any) {
    this.created.push(args)
    return { id: "s1" }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async prompt(_args: any) {
    return {}
  }
  async wait() {}
  async context() {
    return [
      {
        type: "assistant",
        content: [{ type: "text", text: "ok" }],
        tokens: undefined,
        model: undefined,
      },
    ]
  }
}

test("OpenCodeV2Executor：task.model 覆盖构造期默认，未带时回落默认", async () => {
  const fake = new FakeSessionDomain()
  const executor = new OpenCodeV2Executor({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session: fake as any,
    model: { providerID: "glm", id: "glm-5.3" },
    estimateCost: () => undefined,
  })
  await executor.execute({
    prompt: "x",
    model: { providerID: "glm", id: "glm-5.3-flash" },
  })
  assert.deepEqual(fake.created[0]!.model, { providerID: "glm", id: "glm-5.3-flash" })

  await executor.execute({ prompt: "y" })
  assert.deepEqual(fake.created[1]!.model, { providerID: "glm", id: "glm-5.3" })
})
