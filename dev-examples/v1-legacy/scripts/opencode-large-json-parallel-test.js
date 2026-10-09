// Node Inspector 大结果截断验收（T05）- 优化版
// 目标：验证“大结构化 JSON 单 Agent”改为“分片并行 + JS 合并”后的耗时变化
//
// 对照原版：
// 1. BigText 保持不变
// 2. BigJson 从 1 个 Agent 生成 120 条，改为 6 个 Agent 并行，每个 20 条
// 3. name / id 由 JS 确定，LLM 只生成 description
// 4. 最终 bigStructured 仍保持：{ title, items: [...] }

export const meta = {
  name: 'node_detail_large_result_optimized',
  description: 'Node Inspector 大结果截断验收 - 分片并行优化版'
}

// -----------------------------------------------------------------------------
// BigText：保持原测试逻辑不变
// -----------------------------------------------------------------------------
phase('BigText')

const bigText = await agent(
  '围绕"OpenCode 插件体系与动态工作流"写一篇详尽的中文说明，分八个章节逐节展开，'
    + '总长度不少于 6000 词，直接输出纯文本，不要使用 Markdown 代码块围栏',
  {
    label: 'long-output'
  }
)

// -----------------------------------------------------------------------------
// BigJson：优化版
// -----------------------------------------------------------------------------
phase('BigJsonPrepare')

const TOTAL_ITEMS = 120
const CHUNK_SIZE = 20

// 确定性字段由 JS 生成，不浪费 LLM 输出 token。
const sourceItems = Array.from({ length: TOTAL_ITEMS }, (_, index) => ({
  id: index + 1,
  name: `plugin-${String(index + 1).padStart(3, '0')}`
}))

const chunks = []
for (let start = 0; start < sourceItems.length; start += CHUNK_SIZE) {
  chunks.push({
    index: chunks.length,
    items: sourceItems.slice(start, start + CHUNK_SIZE)
  })
}

phase('BigJsonParallel')

// 每个 Agent 只处理 20 条。
// schema 仍然保留，用来验证“小规模 structured output + parallel”是否有效。
const partials = await parallel(
  chunks.map((chunk) => async () => {
    const itemList = chunk.items
      .map((item) => `${item.id}. ${item.name}`)
      .join('\n')

    return agent(
      '你只需要为下面给出的插件条目生成中文 description。\n'
        + '要求：\n'
        + '1. 必须严格按照给出的 id 返回，不得新增、删除、修改 id。\n'
        + '2. 每条 description 不少于 60 个中文词语。\n'
        + '3. 不要扫描项目目录，不要调用其他工具寻找素材。\n'
        + '4. 只描述当前清单中的条目。\n'
        + '5. 返回 items 数组即可。\n\n'
        + '条目清单：\n'
        + itemList,
      {
        label: `long-structured-chunk-${String(chunk.index + 1).padStart(2, '0')}`,
        schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  description: { type: 'string' }
                },
                required: ['id', 'description']
              }
            }
          },
          required: ['items']
        }
      }
    )
  })
)

// -----------------------------------------------------------------------------
// JS Merge：不再让最后一个 Agent 重新生成一次 120 条大 JSON
// -----------------------------------------------------------------------------
phase('BigJsonMerge')

const descriptionById = new Map()

for (let chunkIndex = 0; chunkIndex < partials.length; chunkIndex++) {
  const partial = partials[chunkIndex]

  if (!partial || !Array.isArray(partial.items)) {
    throw new Error(`chunk-${chunkIndex + 1} 返回结果无效：缺少 items 数组`)
  }

  for (const generated of partial.items) {
    if (!generated || typeof generated.id !== 'number') {
      throw new Error(`chunk-${chunkIndex + 1} 存在无效 id`)
    }

    if (typeof generated.description !== 'string' || generated.description.trim() === '') {
      throw new Error(`id=${generated.id} 的 description 为空`)
    }

    if (descriptionById.has(generated.id)) {
      throw new Error(`发现重复 id：${generated.id}`)
    }

    descriptionById.set(generated.id, generated.description)
  }
}

const bigStructured = {
  title: '插件生态清单',
  items: sourceItems.map((item) => {
    const description = descriptionById.get(item.id)

    if (!description) {
      throw new Error(`缺少 id=${item.id} 的 description`)
    }

    return {
      id: item.id,
      name: item.name,
      description
    }
  })
}

if (bigStructured.items.length !== TOTAL_ITEMS) {
  throw new Error(
    `最终条目数量不正确：expected=${TOTAL_ITEMS}, actual=${bigStructured.items.length}`
  )
}

phase('Done')

return {
  bigText,
  bigStructured,
  stats: {
    totalItems: TOTAL_ITEMS,
    chunkSize: CHUNK_SIZE,
    chunkCount: chunks.length
  }
}
