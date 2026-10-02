# 插件内相对路径按 service 进程 cwd 解析，而非项目目录

日期：2026-10-03 ｜ 阶段：P2.4 ｜ 排查耗时：约 10 分钟

## 现象

插件 options 配置 `traceDir: ".agentic-workflow"`，工作流真实跑完且成功，
但项目目录下没有 `.agentic-workflow/events.jsonl`（trace sink 写失败被静默吞掉，
日志也进了 service 进程，run 输出里看不到）。

## 根因

插件代码运行在 **opencode service 进程**里，`path.join(traceDir, file)` 等
相对路径以 **service 进程 cwd** 为基准解析，与用户所在项目目录无关。

## 解法

凡插件内涉及文件路径，**显式以 `ctx.location.directory`（项目目录）为基准**：

```ts
const traceDir = path.isAbsolute(options.traceDir)
  ? options.traceDir
  : path.join(ctx.location.directory, options.traceDir)
```

## 关联

同族坑：`experience/local-plugin-dist-需-service-restart.md`（插件跑在 service
进程的另一后果——代码缓存）。判断这类问题的共同心法：**插件 ≠ 当前 shell 的
node 进程，一切环境假设（cwd/env/生命周期）都要重新验证**。
