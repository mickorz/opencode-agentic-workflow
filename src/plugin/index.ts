/**
 * OpenCode V2 插件入口
 *
 * P0 接线：
 *   setup(ctx)
 *     -> 注册 OpenCodeV2Executor（绑定 ctx.session，经 withConcurrencyLimit 限流）
 *     -> ctx.tool.transform 注册 workflow tool
 *     -> Main Session 调用 workflow tool -> Workflow Core -> 子会话
 *
 * 插件 options（经 opencode.json 的 plugins[].options 传入）：
 *   {
 *     "package": "<路径>",
 *     "options": {
 *       "model": { "providerID": "glm", "id": "glm-5.3-flash" },
 *       "agent": "build",
 *       "concurrency": 3
 *     }
 *   }
 *
 * 架构约束：本目录（plugin 层）是仅有的允许触碰 OpenCode API 的位置。
 */

import { Plugin } from "@opencode/plugin"

import { setExecutor } from "../runtime/engine.js"
import { withConcurrencyLimit } from "../runtime/semaphore.js"
import { OpenCodeV2Executor, type ExecutorModelRef } from "./opencode-v2-executor.js"
import { runSmokeWorkflow } from "../workflow/smoke.js"

export default Plugin.define({
  id: "agentic-workflow",

  async setup(ctx) {
    console.log(`[agentic-workflow] loaded: ${ctx.location.directory}`)

    const options = ctx.options as {
      model?: ExecutorModelRef
      agent?: string
      concurrency?: number
    }

    const executor = withConcurrencyLimit(
      new OpenCodeV2Executor({
        session: ctx.session,
        model: options.model,
        agent: options.agent,
      }),
      options.concurrency,
    )
    setExecutor(executor)

    // 递归防护：workflow 运行期间，子会话里的 agent 也可能看到并调用 workflow 工具，
    // 形成递归 workflow；叠加并发信号量后会自饿死死锁（实测卡死）。
    // P0 策略：运行中直接拒绝嵌套调用，让子 agent 用自身能力直接完成任务。
    let workflowDepth = 0

    ctx.tool.transform((editor) => {
      editor.add({
        name: "workflow",
        description:
          "Run an agentic workflow (P0: 3 parallel analysis agents + 1 summary agent). " +
          "Pass a topic to analyze; returns the summary agent's final output. " +
          "Do NOT call this tool from inside a workflow; do the work directly instead.",
        input: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description: "The topic to analyze",
            },
          },
          required: ["topic"],
        } as Record<string, unknown>,
        // V2 强校验：Tool.Result 使用 output 字段必须声明 output schema，
        // 否则报 "Tool result declared output without an output schema"
        output: {
          type: "string",
        } as Record<string, unknown>,
        async execute(input: unknown) {
          const topic = (input as { topic?: unknown }).topic
          if (typeof topic !== "string" || topic.length === 0) {
            // 注意：工具内校验失败返回文本而非抛错，避免主 agent 重试风暴
            return { output: "[agentic-workflow] error: topic must be a non-empty string" }
          }
          if (workflowDepth > 0) {
            return {
              output:
                "[agentic-workflow] nested workflow calls are not allowed: " +
                "another workflow is running. Complete the task directly yourself.",
            }
          }
          workflowDepth += 1
          try {
            const result = await runSmokeWorkflow(topic)
            return { output: result.output }
          } catch (error) {
            // 抛错会诱发主 agent 无限重试工具调用（实测 22 轮重试耗尽配额）。
            // 失败信息以结果文本返回，让主 agent 停止重试并向用户报告。
            const message = error instanceof Error ? error.message : String(error)
            return { output: `[agentic-workflow] workflow failed: ${message}` }
          } finally {
            workflowDepth -= 1
          }
        },
      })
    })
  },
})
