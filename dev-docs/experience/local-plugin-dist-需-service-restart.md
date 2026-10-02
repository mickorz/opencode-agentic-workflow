# 本地目录插件代码更新不生效：service 缓存与重启

日期：2026-10-03 ｜ 阶段：P2.3 ｜ 排查耗时：约 20 分钟

## 现象

修改插件源码并重新 build 到 `dist/` 后，在**同一项目目录**再次 `opencode run`，
行为仍是**旧版插件**：配置了 `checkpoint.mode="interactive"`，但 checkpoint 仍被
auto-approve（旧代码没有 interactive 分支，忽略未知 option 后回落默认策略门）。

## 根因

- `opencode run` / `opencode api` 会**附着到该目录已运行的 service**（同 location 复用），
  service 进程里加载的还是它**启动时**的插件模块。
- 文档明言：自动 reload 只监听**配置目录**（`.opencode/plugins/` 等）下的变化；
  本地目录插件指向 `dist/`（绝对路径）时，改动需要 `opencode service restart`。
- 更糟的是：在 agent 会话内执行 `opencode service restart` 可能重启**自己附着的
  service**，命令自身被取消（本次实测两次被取消）。

## 解法

**换一个全新的项目目录**做验收（新 location = 新 service = 必然加载当前 dist）：

```bash
mkdir "$TMPDIR/opencode-p2-interactive"
# 写入 opencode.json（plugin package 指向 dist/plugin）
cd "$TMPDIR/opencode-p2-interactive" && opencode run ...
```

若必须留在原目录：由**人在终端外**执行 `opencode service restart`，不要让 agent
在自己会话里跑这条命令。

## 预防

- 涉及插件行为的验收，一律用**一次性新目录**（本项目 `$TMPDIR/opencode-*` 系列），
  顺带隔离历史会话污染。
- 判断「新代码是否生效」：先看插件 setup 日志（如本项目的
  `checkpoint gate: interactive`），或在关键分支放可观测输出，再跑业务链路。
