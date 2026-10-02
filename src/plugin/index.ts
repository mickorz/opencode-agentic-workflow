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

import { setCheckpointGate } from "../quality/checkpoint.js"
import { setExecutor } from "../runtime/engine.js"
import { withConcurrencyLimit } from "../runtime/semaphore.js"
import {
  InteractiveCheckpointGate,
  type InteractiveCheckpointOptions,
} from "./interactive-checkpoint-gate.js"
import { OpenCodeV2Executor, type ExecutorModelRef } from "./opencode-v2-executor.js"
import { PolicyCheckpointGate, type CheckpointPolicy } from "./policy-checkpoint-gate.js"
import { runReliableWorkflow } from "../workflow/reliable.js"
import { runSmokeWorkflow } from "../workflow/smoke.js"

export default Plugin.define({
  id: "agentic-workflow",

  async setup(ctx) {
    console.log(`[agentic-workflow] loaded: ${ctx.location.directory}`)

    const options = ctx.options as {
      model?: ExecutorModelRef
      agent?: string
      concurrency?: number
      checkpoint?: { mode?: CheckpointPolicy | "interactive" } & InteractiveCheckpointOptions
      /** reliable workflow 的 check 步骤命令 */
      checkCommand?: string
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

    // checkpoint 审批门：
    //   auto-approve / auto-reject（默认策略门，headless 友好）
    //   interactive（P2.3：TUI 双形态 + RPC，真正的人工审批）
    if (options.checkpoint?.mode === "interactive") {
      const gate = new InteractiveCheckpointGate(ctx.rpc, {
        timeoutMs: options.checkpoint.timeoutMs,
        onTimeout: options.checkpoint.onTimeout,
      })
      await gate.bind()
      setCheckpointGate(gate)
      console.log(
        "[agentic-workflow] checkpoint gate: interactive (TUI dialog via RPC)",
      )
    } else {
      setCheckpointGate(new PolicyCheckpointGate(options.checkpoint?.mode))
    }

    // 递归防护：workflow 运行期间，子会话里的 agent 也可能看到并调用 workflow 工具，
    // 形成递归 workflow；叠加并发信号量后会自饿死死锁（实测卡死）。
    // P0 策略：运行中直接拒绝嵌套调用，让子 agent 用自身能力直接完成任务。
    let workflowDepth = 0

    ctx.tool.transform((editor) => {
      editor.add({
        name: "workflow",
        description:
          "Run an agentic workflow. flow=smoke (default): 3 parallel analysis agents + summary. " +
          "flow=reliable: agent -> check -> verify -> checkpoint reliable chain. " +
          "Pass a topic; returns the workflow's final output. " +
          "Do NOT call this tool from inside a workflow; do the work directly instead.",
        input: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description: "The topic to analyze",
            },
            flow: {
              type: "string",
              enum: ["smoke", "reliable"],
              description: "Workflow flavor, default smoke",
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
          const parsed = (input as { topic?: unknown; flow?: unknown }) ?? {}
          const topic = parsed.topic
          const flow = parsed.flow === "reliable" ? "reliable" : "smoke"
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
            const result =
              flow === "reliable"
                ? await runReliableWorkflow(topic, {
                    checkCommand: options.checkCommand,
                  })
                : await runSmokeWorkflow(topic)
            return { output: typeof result === "string" ? result : result.output }
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
