# V2 工具返回 output 字段必须声明 output schema

日期：2026-10-03 ｜ 环境：@opencode/plugin 2.0.22

## 问题现象

workflow 工具执行成功，但主 agent（Code Mode）侧报错：

```text
Error: Tool result declared output without an output schema
```

工具返回值无法传递给调用方，主 agent 拿到的是空结果。

## 排查过程

- 子会话/工具侧日志一切正常，错误只出现在调用方消费结果时。
- 对照 `@opencode/schema` 的 `Tool.Result` 类型：`output?: OutputValue<Output>` ——
  output 字段的类型由工具定义的 `output` schema 决定。

## 根因

OpenCode V2 对工具结果是强校验的：`execute` 返回 `{ output: ... }` 时，
工具定义（`editor.add({...})`）里必须同时声明 `output` 的 ValueSchema（如
`{ type: "string" }`）。只声明 `input` 不够。

## 解决方案

```ts
ctx.tool.transform((editor) => {
  editor.add({
    name: "workflow",
    input: { type: "object", properties: { ... }, required: [...] },
    output: { type: "string" },   // 必须：返回 output 字段就要声明
    async execute(input) {
      return { output: "..." }    // 与 schema 对应
    },
  })
})
```

不想声明 output schema 时，可改用 `content` 字段返回文本
（`Tool.Result.content?: string | Content[]`），它不要求 output schema。

## 预防/注意事项

- V2 工具「返回什么」也要像「入参」一样显式建模；input/output schema 是一对。
- 类似强校验还出现在：插件 options（`ctx.options` 是自由 Record，读取时自己做类型收敛）。
