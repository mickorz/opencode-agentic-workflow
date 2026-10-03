/**
 * smoke workflow 定义（P2.5）
 *
 * workflows/ = workflow 资产（id/version/description/argsSchema/stepNames/run），
 * workflow/ = 组合子引擎。新增 workflow = 新增定义文件 + 插件入口注册一行。
 */

import type { WorkflowDefinition } from "../registry/definition.js"
import { runSmokeWorkflow } from "../workflow/smoke.js"

export interface SmokeArgs {
  topic: string
}

export function smokeWorkflow(): WorkflowDefinition<SmokeArgs, { output: string }> {
  return {
    id: "smoke",
    version: "1.0.0",
    description: "3 路并行分析 agent + 1 个汇总 agent（冒烟演示）",
    argsSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "分析主题" },
      },
      required: ["topic"],
    },
    stepNames: ["research", "summary"],
    async run(args, ctx) {
      return runSmokeWorkflow(args.topic, ctx.runSteps)
    },
  }
}
