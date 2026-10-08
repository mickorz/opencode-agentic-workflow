# TUI 插件装载失败：keymap.layer 挂载点 + peer 打包姿势

> 2026-10-08 · 0.5.0 发布后首装实测发现 · 定位全程无头复现，未占用用户重启

## 现象

`npx install` 装好后重启 opencode，插件面板显示 fail。宿主日志（`~/.local/share/opencode/log/opencode.log`）：

```
level=WARN message="plugin operation failed" stage=setup durationMs=1
error="Keymap.Provider is missing" plugin=agentic-workflow-tui
target=@mickorz/opencode-agentic-workflow role=cli
```

## 惊人事实：TUI 入口从未成功加载过

翻全量日志：**59 次 role=cli 失败、0 次成功**——其中 35 次是 10-06/07 的
本地 dist 路径条目（E2E 期间）。**path 模式同样炸**，不是 npm 缓存安装特有的问题。

为什么 E2E 没拦住：`opencode run` 只走 role=server（只装 `.` 入口），
`./tui` 入口只在交互式 TUI（role=cli）里加载——**全部自动化 E2E 从未执行过
tui.tsx**，失败只沉淀在日志里没人看。

## 根因 1：keymap.layer 在 setup 顶层调用

官方文档（现行版）写「Call layer from setup」，但宿主 2.0.22 的运行时不支持
——setup 顶层没有 Keymap.Provider 渲染上下文，直接抛
`Keymap.Provider is missing`。官方 session.panel 示例自己的写法是把
keymap.layer 放进 `append: "app"` 的空渲染 slot 里：

```tsx
ctx.ui.slot({
  append: "app",
  render: () => {
    ctx.keymap.layer(() => ({ mode: "global", commands: [...] }))
    return null
  },
})
```

修复：tui.tsx 照此改写（`a2f...` 提交）。「文档允许 setup 调用」是新宿主
行为，写插件要按**最保守兼容姿势**写。

## 根因 2：opentui/solid-js 必须是 peerDependencies

官方 "Publish and load" 规定的姿势：

```json
"dependencies": { "@opencode/plugin": "^2.0.22" },
"peerDependencies": {
  "@opentui/core": ">=0.5.8",
  "@opentui/solid": ">=0.5.8",
  "solid-js": ">=1.9.0"
}
```

JSX 渲染插件的 solid-js/@opentui 必须由**宿主提供实例**（context 身份才一致）。
0.5.0 把它们放进了 dependencies → 缓存安装自带私有副本 → 实例错位。

实证：把缓存里的 solid-js/@opentui 目录**删掉** + manifest 改 peer 后，
模块照样解析加载（宿主提供）；而 `@opencode/plugin` 换 2.0.22/2.0.24 都
不影响本错误（排除版本漂移假设）。本地构建所需精确版本留在 devDependencies。

## 副发现：scheduler tick 的 unhandled rejection 刷屏

同窗口日志有 80+ 条 `unhandled rejection`（ENOENT rename
`.cursor.json.tmp → .cursor.json`）：schedules 目录指向的临时根被外部清理后，
`void this.tick()` 每 15s 漏一个 rejection。修复：tick().catch() 降级为单行
日志（atomicWrite 本就有 mkdir 自愈，竞态窗口仍可能失败但不外溢）。

## 无头复现方法（不用用户重启）

```bash
# 临时目录 + 任意插件配置 → pty 起 TUI → 杀掉 → 看日志增量
SCRATCH=...; mkdir -p $SCRATCH
cat > $SCRATCH/opencode.json <<EOF
{ "plugins": [{ "package": "<包名或绝对路径>" }] }
EOF
LOG=~/.local/share/opencode/log/opencode.log; BEFORE=$(wc -l < $LOG)
TERM=xterm-256color COLUMNS=120 LINES=35 script -q /dev/null \
  sh -c "cd $SCRATCH && opencode & OPID=\$!; sleep 12; kill \$OPID" >/dev/null 2>&1
sed -n "$((BEFORE+1)),\$p" $LOG | grep "plugin operation failed"
```

注意：CLI 进程会吞插件 console.log——**插桩要用文件写入探针**（appendFileSync
到固定路径），别信 console。

## 判别清单（下次 TUI 插件 fail）

1. 日志 grep `plugin operation failed` → 看 plugin= / stage= / role=
2. role=cli 失败 = 交互式 TUI 侧；`opencode run` 复现不了
3. 同代码多entry对照：discovered 插件（`~/.config/opencode/plugins/*.js`）
   正常 = 宿主 CLI 装载管线本身没问题
4. setup 阶段抛宿主侧错误 → 文件探针二分定位是哪个 ctx.* 调用
