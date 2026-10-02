# V2 插件 TypeScript 工程配置小坑（console / Plugin.Context）

日期：2026-10-03 ｜ 环境：TypeScript 5.x、@opencode/plugin 2.0.22

## 问题现象

1. `error TS2584: Cannot find name 'console'`（lib 未含 DOM，也没引 node types）。
2. `error TS2305: Module '"@opencode/plugin"' has no exported member 'Context'`。

## 根因与解决方案

1. tsconfig 的 `lib: ["ES2022"]` 不含浏览器/Node 全局，需要显式引入 Node 类型：

```jsonc
{ "compilerOptions": { "lib": ["ES2022"], "types": ["node"] } }
```

（前提：devDependencies 有 `@types/node`。）

2. `@opencode/plugin` 的入口把 plugin 模块以命名空间导出：`export * as Plugin from "./plugin.js"`。
   `Context` 等类型在命名空间内，不能直接具名导入：

```ts
// 错误：import type { Context } from "@opencode/plugin"
// 正确：
import type { Plugin } from "@opencode/plugin"
type SessionDomain = Plugin.Context["session"]
```

## 预防/注意事项

- 写 Adapter 前先 `ls node_modules/@opencode/plugin/dist/promise/` 并读 `index.d.ts` 的导出清单，
  确认类型入口形状，避免按 V1（`@opencode-ai/plugin` 的 `PluginInput`）惯性写导入。
- 本仓库约定：OpenCode 类型只从 `Plugin.*` 命名空间取，集中在 plugin 层使用。
