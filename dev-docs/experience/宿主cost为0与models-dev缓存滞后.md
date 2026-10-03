# 宿主 cost=0 不是真相：models-dev 缓存滞后与价格兜底

日期：2026-10-03 ｜ 环境：opencode v2.022、glm/glm-5.3-flash

## 问题现象

P2.6 metrics 的 cost 一路 `$0.0000`，但 token 计数正常（in 74k）。三层排查：

1. **V2 assistant 消息自带 `cost` 字段，但值为 `0`**——`message.cost ?? 估算`
   的 `??` 只在 `null/undefined` 时兜底，`0` 会直接吃掉估算分支；
2. 即使修成「宿主非正 → 估算」，估算仍为空：**`ctx.model.list()` 的价目来自
   服务缓存的 models-dev 目录，新模型（glm-5.3-flash）不在缓存里**
   （线上 models.dev API 已有：in $0.15/M、out $0.5/M、cache read $0.03/M）；
   缓存本体在 `opencode.db` 的 `kv` 表 `models-dev:catalog` 键（~6MB JSON），
   可直接 sqlite 查证：
   ```zsh
   sqlite3 ~/.local/share/opencode/opencode.db \
     "SELECT value FROM kv WHERE key='models-dev:catalog';" | python3 -c "..."
   ```
3. 插件 `console.log` 走 **service 进程**，`opencode run` 的 stdout 看不到，
   service 日志（`~/.local/share/opencode/log/`）里也没有——插件侧诊断
   不能依赖 console，要么进事件流，要么经工具结果带出。

## 解决方案（三层价格优先级）

```
用户 prices 覆盖（插件选项，最高）
  > ctx.model.list 价目（目标模型缺失时先 ctx.model.reload() 重同步一次）
  > 宿主消息 cost（正值视为精确）
```

executor 侧取值规则：**宿主正值直接用；宿主 0/缺失 → 价目表按 token 估算**：
`in×in$ + cache.read×cacheRead$ + cache.write×cacheWrite$ + (out+reasoning)×out$`（每百万）。

估算与实测对齐验证：47.5k×0.15 + 27.7k×0.03 + 2.0k×0.5 ≈ $0.00897，
工具报 **$0.0090** ✓（toFixed(4)）。

## 预防/注意事项

- `??` 兜底对 `0` 不生效——「缺失」与「零值」语义不同时必须显式判
  `> 0`，这是本次唯一的代码 bug，其余都是数据源问题。
- 新模型没有成本数据时，先怀疑 **models-dev 缓存滞后**，别急着改公式；
  一次性验证：直接 fetch `https://models.dev/api.json`（注意 >5MB，工具
  抓取会超限，用 node/python 流式取目标 provider 段）。
- 长期方案是价目表与宿主解耦：`prices` 插件选项让用户/部署方钉死价格，
  不受宿主缓存时效影响（CI、私有网关场景必需）。
- reasoning tokens 按输出价计费是**估算约定**（provider 间口径不一：
  output 是否已含 reasoning 无从判断），误差小但别当精确值报。
