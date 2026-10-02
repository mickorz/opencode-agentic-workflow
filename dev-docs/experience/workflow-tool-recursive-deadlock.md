# 全局注册的 workflow 工具被子会话递归调用，叠加信号量自饿死死锁

日期：2026-10-03 ｜ 环境：opencode v2.0.22

## 问题现象

端到端验收：主会话调用 workflow 工具后整条 `opencode run` 永久无响应（480s 看门狗击杀）。子会话（workflow#1/2/3）`outcome` 为空，assistant 停在 `["reasoning","tool"]`，工具 part `executed: false`、`state.status: "running"`。

## 排查过程

- 拉取卡住子会话的 context，工具 part 的 input 显示：

  ```json
  { "code": "return await tools.workflow({ topic: \"天空为什么是蓝色——从架构设计角度…\" })" }
  ```

- 即**分析子 agent 自己调用了 workflow 工具**。

## 根因

1. `ctx.tool.transform(editor => editor.add(...))` 注册的工具是**全局可见**的：workflow 创建的子会话里，子 agent 同样能看到并调用 workflow 工具。
2. 子 agent（ glm-5.3-flash）很「聪明」地把分析任务又委托给了 workflow → 递归 workflow。
3. 并发信号量（上限 3）被外层 3 个 executor 执行占满；内层 workflow 的 executor 调用永远拿不到槽位 → **自饿死死锁**：外层等子会话完成，子会话在等内层 workflow，内层在等信号量。

## 解决方案

1. **深度守卫**（plugin 层全局 `workflowDepth` 计数）：

   ```ts
   if (workflowDepth > 0) {
     return { output: "nested workflow calls are not allowed: ... Complete the task directly yourself." }
   }
   workflowDepth += 1
   try { return { output: (await runSmokeWorkflow(topic)).output } }
   finally { workflowDepth -= 1 }
   ```

   嵌套调用立刻返回错误文本（不抛错，避免重试风暴），子 agent 转而自行完成任务。

2. **提示词加固**：分析/汇总 prompt 明确「直接用你自己的知识回答，禁止调用 workflow 或其他任何工具」。

3. 修完后端到端验收一次通过（3 并行 + 汇总全部成功）。

## 预防/注意事项

- 给 agent 注册「会创建子会话」的工具时，必须假设**子会话里的 agent 也能看到这个工具**，递归/重入防护是必需品，不是可选项。
- 并发限制（Semaphore）+ 递归调用 = 经典自饿死：占用槽位的任务又在等新槽位。任何带并发上限的执行器都要考虑重入路径。
- 诊断这类「无输出挂起」：先看子会话 assistant 的 tool part（name/input/state），`executed: false` + `running` 基本就是卡在工具执行里，input 里能看到它到底调了什么。
