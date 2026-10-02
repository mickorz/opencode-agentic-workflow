/**
 * OpenCode V2 插件入口
 *
 * P0 目标：Plugin.define 骨架能被 OpenCode V2 发现并加载，
 * setup(ctx) 被调用时输出 loaded 日志（Acceptance 01）。
 *
 * 后续 OpenCode 特定 API 只允许出现在本目录（plugin 层），
 * Workflow Core（src/workflow、src/runtime）保持宿主无关。
 */

import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "agentic-workflow",

  async setup(ctx) {
    console.log(`[agentic-workflow] loaded: ${ctx.location.directory}`)
  },
})
