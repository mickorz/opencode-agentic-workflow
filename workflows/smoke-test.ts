/**
 * P0 Smoke Test 入口（Mock 版）
 *
 * 用 MockExecutor 脱离 OpenCode 验证 smoke workflow 的结构：
 *   phase Research -> parallel(A,B,C) -> phase Summary -> summary agent
 *
 * 真实运行（OpenCode V2 加载本插件后，在 Main Session 中调用 workflow tool）
 * 见 README「验收」一节。
 */

import { MockExecutor } from "../src/runtime/executor.js"
import { setExecutor } from "../src/runtime/engine.js"
import { runSmokeWorkflow } from "../src/workflow/smoke.js"

setExecutor(new MockExecutor())

const result = await runSmokeWorkflow("OpenCode V2 工作流引擎")

console.log("=== smoke-test (mock) ===")
console.log(result.output)
