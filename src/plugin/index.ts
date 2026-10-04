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
import path from "node:path"

import { setCheckpointGate } from "../quality/checkpoint.js"
import { setExecutor } from "../runtime/engine.js"
import { withConcurrencyLimit } from "../runtime/semaphore.js"
import { createFileTraceSink } from "../observability/trace.js"
import { MetricsCollector, formatMetrics } from "../metrics/collector.js"
import { WorkflowRegistry } from "../registry/registry.js"
import { startWorkflow, resumeWorkflow, runWorkflowInline } from "../registry/runner.js"
import { WorkflowExecutionError } from "../registry/errors.js"
import { FileExecutionStore } from "../state/file-store.js"
import type { ExecutionStore } from "../state/store.js"
import { reliableWorkflow } from "../workflows/reliable.js"
import { smokeWorkflow } from "../workflows/smoke.js"
import { artifactWorkflow } from "../workflows/artifact.js"
import { featureDevelopmentWorkflow } from "../workflows/feature-development.js"
import { loadDeclarativeWorkflows } from "../workflows/loader.js"
import { GitWorktreeProvider, InPlaceWorkspaceProvider, type WorkspaceProvider, type CleanupPolicy } from "../workspace/index.js"
import {
  InteractiveCheckpointGate,
  type InteractiveCheckpointOptions,
} from "./interactive-checkpoint-gate.js"
import {
  applyCheckpointModeOverride,
  parseCheckpointModeOverride,
} from "./checkpoint-override.js"
import { OpenCodeV2Executor, type ExecutorModelRef } from "./opencode-v2-executor.js"
import { buildPriceTable, estimateCostUSD } from "./price-table.js"
import { PolicyCheckpointGate, type CheckpointPolicy } from "./policy-checkpoint-gate.js"

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
      /** 事件 trace 落盘目录（JSONL，观测用；不配置则不落盘） */
      traceDir?: string
      /** journal 落盘目录（<runId>.json，durable/resume 用；不配置则不持久化） */
      journalDir?: string
      /**
       * 模型价格覆盖（P2.6 cost 估算）：key = "providerID/modelId"，
       * 单位 USD/百万 token。优先级：本选项 > ctx.model.list 价目 > 宿主消息 cost。
       * 价目缓存缺新模型时用它补（如 glm-5.3-flash 未进本地 models-dev 缓存）。
       */
      prices?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
      /**
       * P2.7 workspace 隔离（默认 off）：
       *   { "mode": "git-worktree", "dir"?: "...", "baseRef"?: "...", "cleanup"?: "always" | "on-success" | "never" }
       * mode=git-worktree 时每个 run 创建独立 worktree（子 agent cwd 绑定到其根），
       * resume 重新附着原 worktree；cleanup 缺省 on-success（失败保留现场）。
       */
      isolation?: {
        mode?: "off" | "git-worktree"
        /** worktree 父目录（绝对或相对项目目录；缺省 <repo 同级>/<项目名>-worktrees） */
        dir?: string
        /** 基准 ref（缺省仓库当前 HEAD） */
        baseRef?: string
        cleanup?: CleanupPolicy
      }
      /**
       * P4 自定义 workflow（声明式 JSON）：路径数组，每项为 .json 文件或
       * 目录（扫一层 *.json），相对项目目录。文件格式与步骤类型见
       * dev-docs/planning/P4-custom-workflows.md；坏文件跳过并告警。
       */
      workflows?: string[]
    }

    // P2.6 成本估算兜底：宿主价目表（ctx.model.list，USD/M tokens）。
    // 宿主消息未带精确 cost（或记账为 0）时按 token 用量估算。
    let priceTable = buildPriceTable((await ctx.model.list()).data)
    const wantedModel = options.model
      ? `${options.model.providerID}/${options.model.id}`
      : undefined
    if (wantedModel && !priceTable.has(wantedModel)) {
      // 价目缓存缺目标模型（实测：本地 models-dev 缓存可能滞后于线上）：
      // 尝试重同步一次，失败则保持原表（成本退回宿主上报值）
      try {
        await ctx.model.reload()
        priceTable = buildPriceTable((await ctx.model.list()).data)
      } catch {
        /* 保持原表 */
      }
    }
    // 用户价格覆盖（最高优先）
    if (options.prices) {
      for (const [model, price] of Object.entries(options.prices)) {
        priceTable.set(model, price)
      }
    }
    if (wantedModel) {
      const price = priceTable.get(wantedModel)
      console.log(
        `[agentic-workflow] price table: ${priceTable.size} models` +
          (price
            ? `; ${wantedModel}: in $${price.input}/M out $${price.output}/M cache r $${price.cacheRead}/M`
            : `; ${wantedModel}: no pricing (cost will be host-reported only)`),
      )
    }

    const executor = withConcurrencyLimit(
      new OpenCodeV2Executor({
        session: ctx.session,
        model: options.model,
        agent: options.agent,
        estimateCost: (model, usage) => estimateCostUSD(priceTable, model, usage),
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

    // P2.6 metrics collector：纯事件总线消费者（token/cost/时长/计数聚合）
    const metrics = new MetricsCollector()

    // observability（P2.4）：可选 JSONL 事件 trace 落盘
    // 注意：相对路径以项目目录（ctx.location.directory）为基准——
    // 插件运行在 opencode service 进程内，其 cwd 不是项目目录
    if (options.traceDir) {
      const traceDir = path.isAbsolute(options.traceDir)
        ? options.traceDir
        : path.join(ctx.location.directory, options.traceDir)
      const traceFile = path.join(traceDir, "events.jsonl")
      createFileTraceSink(traceFile)
      console.log(`[agentic-workflow] event trace sink: ${traceFile}`)

      // P2.6 metrics：workflow 结束时把聚合快照落盘（查询/取证用，写失败只记录）
      metrics.subscribeFileSink(path.join(traceDir, "metrics.json"))
    }

    // P2.5 workflow registry：新增 workflow = 新增定义 + 在此注册，
    // 工具描述/枚举/路由全部由注册表驱动
    const registry = new WorkflowRegistry()
      .register(smokeWorkflow())
      .register(reliableWorkflow({ checkCommand: options.checkCommand }))
      .register(artifactWorkflow())
      .register(featureDevelopmentWorkflow({ checkCommand: options.checkCommand }))

    // P4 自定义 workflow（声明式 JSON）：options.workflows 路径（.json 文件
    // 或目录，相对项目目录）→ 装载注册。文件级错误 warn+跳过（观测/装载
    // 不能成为主链路故障源）；必须在工具注册前完成（flow enum 来自
    // registry.listLatest()）
    if (options.workflows && options.workflows.length > 0) {
      const builtinIds = ["smoke", "reliable", "artifact", "feature-development"]
      const loaded = await loadDeclarativeWorkflows(
        options.workflows,
        ctx.location.directory,
        builtinIds,
      )
      for (const error of loaded.errors) {
        console.log(`[agentic-workflow] custom workflow file skipped: ${error}`)
      }
      let registered = 0
      for (const definition of loaded.definitions) {
        try {
          registry.register(definition)
          registered += 1
          console.log(
            `[agentic-workflow] custom workflow registered: ${definition.id}@${definition.version} ` +
              `(${(definition.stepNames ?? []).join(" -> ")})`,
          )
        } catch (error) {
          console.log(
            `[agentic-workflow] custom workflow rejected ${definition.id}@${definition.version}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      if (registered === 0 && loaded.errors.length > 0) {
        console.log(
          "[agentic-workflow] note: no custom workflows were registered; " +
            "built-in workflows remain fully available",
        )
      }
    }

    // P2.5 durable journal：配置 journalDir 后，run 经 startWorkflow/resumeWorkflow
    // 走持久化链路（journal 记录 workflow {id, version} + args + steps，可恢复）
    let store: ExecutionStore | undefined
    if (options.journalDir) {
      const journalDir = path.isAbsolute(options.journalDir)
        ? options.journalDir
        : path.join(ctx.location.directory, options.journalDir)
      store = new FileExecutionStore(journalDir)
      console.log(`[agentic-workflow] journal store: ${journalDir}`)
    }

    // P2.7 workspace 隔离：GitWorktreeProvider（startDir = 项目目录，
    // 内部解析到 git 仓库根；worktree 落在仓库同级目录，不污染仓库）。
    // P3 Blocker 修复：无隔离时绑定 InPlaceWorkspaceProvider——
    // workspaceRoot 必须解析到项目目录；process.cwd() 在托管进程里
    // 不是项目目录（长驻 server 场景实测为 HOME），artifact/reliable
    // 等流程会「文件写对位置、check 查错位置」假失败。
    let workspaceBinding: { provider: WorkspaceProvider; options?: { baseRef?: string }; cleanup?: CleanupPolicy } | undefined
    if (options.isolation?.mode === "git-worktree") {
      const dir = options.isolation.dir
        ? path.isAbsolute(options.isolation.dir)
          ? options.isolation.dir
          : path.join(ctx.location.directory, options.isolation.dir)
        : undefined
      workspaceBinding = {
        provider: new GitWorktreeProvider({ startDir: ctx.location.directory, dir }),
        ...(options.isolation.baseRef ? { options: { baseRef: options.isolation.baseRef } } : {}),
        cleanup: options.isolation.cleanup,
      }
      console.log(
        `[agentic-workflow] workspace isolation: git-worktree ` +
          `(cleanup=${options.isolation.cleanup ?? "on-success"}${dir ? `, dir=${dir}` : ""})`,
      )
    } else {
      workspaceBinding = {
        provider: new InPlaceWorkspaceProvider({ startDir: ctx.location.directory }),
        cleanup: "never",
      }
      console.log(
        `[agentic-workflow] workspace: in-place (project dir, no isolation)`,
      )
    }

    // 递归防护：workflow 运行期间，子会话里的 agent 也可能看到并调用 workflow 工具，
    // 形成递归 workflow；叠加并发信号量后会自饿死死锁（实测卡死）。
    // P0 策略：运行中直接拒绝嵌套调用，让子 agent 用自身能力直接完成任务。
    let workflowDepth = 0

    ctx.tool.transform((editor) => {
      editor.add({
        name: "workflow",
        description:
          "Run a registered agentic workflow (flow = workflow id). Available workflows:\n" +
          `${registry.summarize()}\n` +
          "Returns the workflow's final output. " +
          "Do NOT call this tool from inside a workflow; do the work directly instead.",
        input: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description: "The topic to analyze (not needed when resuming)",
            },
            flow: {
              type: "string",
              enum: registry.listLatest().map((definition) => definition.id),
              description: "Workflow id, default smoke",
            },
            resumeRunId: {
              type: "string",
              description:
                "Resume a previous durable run (from journal); overrides flow/topic. " +
                "Use the runId reported by a failed workflow call",
            },
            checkpointMode: {
              type: "string",
              enum: ["auto-approve", "auto-reject"],
              description:
                "Checkpoint gate mode for THIS invocation, overriding plugin config. " +
                "Pass auto-approve for headless/opencode-run executions unless the user " +
                "explicitly wants auto-reject. Ignored for flows without a checkpoint step",
            },
          },
        } as Record<string, unknown>,
        // V2 强校验：Tool.Result 使用 output 字段必须声明 output schema，
        // 否则报 "Tool result declared output without an output schema"
        output: {
          type: "string",
        } as Record<string, unknown>,
        async execute(input: unknown) {
          const parsed =
            (input as {
              topic?: unknown
              flow?: unknown
              resumeRunId?: unknown
              checkpointMode?: unknown
            }) ?? {}
          if (workflowDepth > 0) {
            return {
              output:
                "[agentic-workflow] nested workflow calls are not allowed: " +
                "another workflow is running. Complete the task directly yourself.",
            }
          }
          workflowDepth += 1
          // P3 Blocker 修复：调用级 checkpoint 覆盖（守护进程宿主下
          // init 配置可能来自别的项目——显式参数免疫单例投毒）
          const gateRestore = applyCheckpointModeOverride(
            parseCheckpointModeOverride(parsed.checkpointMode),
          )
          try {
            // resume 分支：journal -> registry 精确版本解析 -> 续跑
            if (typeof parsed.resumeRunId === "string" && parsed.resumeRunId.length > 0) {
              if (!store) {
                return {
                  output:
                    "[agentic-workflow] resume requires the journalDir plugin option to be configured",
                }
              }
              const resumed = await resumeWorkflow(registry, store, parsed.resumeRunId, {
                workspace: workspaceBinding,
              })
              return {
                output:
                  `[resumed ${resumed.workflow.id}@${resumed.workflow.version} ` +
                  `runId=${resumed.runId}]\n${resumed.output}`,
              }
            }

            const workflowId =
              typeof parsed.flow === "string" && parsed.flow.length > 0
                ? parsed.flow
                : "smoke"

            if (store) {
              const started = await startWorkflow(registry, store, workflowId, {
                topic: parsed.topic,
              }, { workspace: workspaceBinding })
              return {
                output:
                  `[${started.workflow.id}@${started.workflow.version} ` +
                  `runId=${started.runId}]\n${started.output}`,
              }
            }

            // 未配置 journalDir：直跑（不持久化、不可恢复）
            const inline = await runWorkflowInline(registry, workflowId, {
              topic: parsed.topic,
            })
            return { output: inline.output }
          } catch (error) {
            // 抛错会诱发主 agent 无限重试工具调用（实测 22 轮重试耗尽配额）。
            // 失败信息以结果文本返回，让主 agent 停止重试并向用户报告。
            const message = error instanceof Error ? error.message : String(error)
            const resumeHint =
              error instanceof WorkflowExecutionError
                ? ` (runId: ${error.runId}; 可用 resumeRunId="${error.runId}" 恢复本次执行)`
                : ""
            return {
              output: `[agentic-workflow] workflow failed: ${message}${resumeHint}`,
            }
          } finally {
            workflowDepth -= 1
            gateRestore?.()
          }
        },
      })

      // P2.6 metrics 查询工具：读取聚合快照（纯只读，不执行任何 workflow）
      editor.add({
        name: "workflow_metrics",
        description:
          "Query cumulative execution metrics of agentic workflows in this service: " +
          "agent calls, token usage (input/output/reasoning/cache), cost in USD, " +
          "per-model breakdown, workflow durations and quality-gate counters " +
          "(check/verify/checkpoint). Read-only; call after running workflows to report cost & usage.",
        input: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["text", "json"],
              description: "Output format, default text",
            },
          },
        } as Record<string, unknown>,
        output: {
          type: "string",
        } as Record<string, unknown>,
        async execute(input: unknown) {
          const parsed = (input as { format?: unknown }) ?? {}
          const format = parsed.format === "json" ? "json" : "text"
          const snapshot = metrics.snapshot()
          const output =
            format === "json" ? JSON.stringify(snapshot, null, 2) : formatMetrics(snapshot)
          return { output }
        },
      })
    })
  },
})
