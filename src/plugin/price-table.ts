/**
 * 模型价目表与成本估算（P2.6，插件层=宿主关注点）
 *
 * 数据源：OpenCode V2 `ctx.model.list()` 的 Model.Info.cost
 * （USD / 百万 token，含 cache read/write 单价；结构子集本地声明，
 * 不直接依赖 @opencode 类型，便于单测）。
 *
 * 优先级：宿主消息自带精确 cost > 价目表估算 > 不计。
 */

import type { TokenUsage } from "../runtime/executor.js"

/** Model.Info.cost 条目的结构子集（结构兼容 @opencode/schema Model.Info） */
interface CostTier {
  tier?: { type: "context"; size: number }
  input: number
  output: number
  cache: { read: number; write: number }
}

/** model.list() 元素的结构子集 */
interface ModelLike {
  id: string
  providerID: string
  cost?: CostTier[]
}

export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 构建价目表：key = "providerID/id"；基准价取无 tier 限制的条目（缺省第一个） */
export function buildPriceTable(models: readonly ModelLike[]): Map<string, ModelPrice> {
  const table = new Map<string, ModelPrice>()
  for (const model of models) {
    const tiers = model.cost ?? []
    const base = tiers.find((tier) => !tier.tier) ?? tiers[0]
    if (!base) continue
    table.set(`${model.providerID}/${model.id}`, {
      input: base.input,
      output: base.output,
      cacheRead: base.cache.read,
      cacheWrite: base.cache.write,
    })
  }
  return table
}

/**
 * 估算成本（USD）：
 *   input×in + cache.read×cacheRead + cache.write×cacheWrite
 *   + (output + reasoning)×out      —— reasoning 按输出价计
 * 单位：价目为 USD/百万 token。注意这是估算值（output 是否已含
 * reasoning 因 provider 而异）；宿主给出精确 cost 时不走本函数。
 */
export function estimateCostUSD(
  table: Map<string, ModelPrice>,
  model: string,
  usage: TokenUsage,
): number | undefined {
  const price = table.get(model)
  if (!price) return undefined
  return (
    (usage.input * price.input +
      usage.cache.read * price.cacheRead +
      usage.cache.write * price.cacheWrite +
      (usage.output + usage.reasoning) * price.output) /
    1_000_000
  )
}
