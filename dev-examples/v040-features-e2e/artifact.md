# Workspace 抽象的设计笔记

- **workspace 作为会话作用域的容器**：workspace 不只是"当前目录"，而是会话（session）的工作上下文集合——包含工作目录、环境变量、工具权限与已加载资源。建议将 workspace 定义为 session 的首要派生物，session 移动目录即隐式切换 workspace。

- **单 workspace 与多 workspace 的边界**：核心场景只暴露一个"主 workspace"，保证心智模型简单；多 workspace（如 git worktree 并行开发）作为显式的扩展能力，需要用户明确挂载，避免默认行为带来的路径歧义。

- **路径解析必须经过 workspace 根**：所有相对路径、工具调用中的文件引用都应统一以 workspace 根目录为基准解析。这样可以在沙箱、worktree、远程执行等不同运行时之间迁移会话而不破坏引用。

- **workspace 与权限/审批的耦合**：安全边界（如"仅允许 workspace 内写入"）应绑定在 workspace 抽象上而非具体工具上。跨 workspace 的外部访问（如系统临时目录）走显式白名单，保持"默认最小权限"。

- **保持抽象薄、可下沉**：workspace 抽象只承担"根目录 + 上下文声明"的最小职责，复杂能力（文件索引、知识库、状态存储）由独立模块叠加。过度膨胀的 workspace 会成为所有功能的上帝对象，阻碍各层独立演进。
