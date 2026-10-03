# dev-examples/ —— 开发期沙盒

> **不对读者负责**：这里存放开发中的 workflow 脚本试验、插件联调配置与临时输出。
> 任何东西都可能随时失效、重构或删除；不要把这里的目录当作文档引用。

## 与 examples/ 的边界

```text
开发中的 workflow / 联调配置 / 试验输出   ->  dev-examples/（这里）
已合入 main 且注册进插件的读者向示例      ->  examples/（按其 README 规范）
```

毕业路径：dev-examples 里验证通过 → 定义合入 `src/workflows/` 并在插件注册
→ `examples/` 落地正式条目 → 删除这里的对应目录。

## 约定

1. **一个开发主题一个子目录**，kebab-case 命名（如 `feature-dev-e2e/`）。
2. 子目录内自便：WIP workflow 脚本、opencode 配置、断言脚本、输出文件都行；
   运行产物（journal/trace/*.out/node_modules）一律 gitignore，**不提交**。
3. 这里**不维护索引**——目录本身就是过程产物，完成即删。
4. 联调配置统一用 `file:../../`（symlink 到仓库 dist），仓库重新 build 即生效，
   无需重装（与 examples/ 的解析方式一致，但这里允许写死本机模型/路径）。
