/**
 * 价目表与成本估算单元测试（P2.6）
 */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildPriceTable,
  estimateCostUSD,
} from "../../src/plugin/price-table.js"
import type { TokenUsage } from "../../src/runtime/executor.js"

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
    ...partial,
    ...(partial.cache ?? {}),
  } as TokenUsage
}

test("buildPriceTable: 基准价取无 tier 条目；无价目模型跳过", () => {
  const table = buildPriceTable([
    {
      providerID: "glm",
      id: "flash",
      cost: [
        { tier: { type: "context", size: 128_000 }, input: 0.2, output: 0.6, cache: { read: 0.02, write: 0.2 } },
        { input: 0.1, output: 0.4, cache: { read: 0.01, write: 0.1 } },
      ],
    },
    { providerID: "x", id: "free", cost: [] },
    { providerID: "y", id: "nopr" },
  ])
  assert.equal(table.size, 1)
  const price = table.get("glm/flash")
  assert.ok(price)
  assert.equal(price.input, 0.1, "无 tier 的条目为基准价")
  assert.equal(price.cacheRead, 0.01)
})

test("estimateCostUSD: input/cache/output+reasoning 分价计费", () => {
  const table = buildPriceTable([
    {
      providerID: "glm",
      id: "flash",
      cost: [{ input: 1, output: 2, cache: { read: 0.25, write: 1.25 } }],
    },
  ])
  // in 1M×$1 + cacheRead 1M×$0.25 + cacheWrite 1M×$1.25 + (out 1M + reasoning 0.5M)×$2 = 1+0.25+1.25+3 = $5.5
  const usd = estimateCostUSD(table, "glm/flash", {
    input: 1_000_000,
    output: 1_000_000,
    reasoning: 500_000,
    cache: { read: 1_000_000, write: 1_000_000 },
  })
  assert.ok(usd !== undefined)
  assert.ok(Math.abs(usd - 5.5) < 1e-9)
})

test("estimateCostUSD: 模型不在价目表返回 undefined", () => {
  const table = buildPriceTable([])
  assert.equal(estimateCostUSD(table, "a/b", usage({ input: 100 })), undefined)
})
