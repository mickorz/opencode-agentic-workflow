/**
 * sequence() —— 顺序执行步骤，上一步结果作为下一步入参
 *
 * P0 语义：Step A -> Step B -> Step C，串行传递。
 * P1 再考虑 failure strategy / jump / fallback / retry / branch。
 */

export async function sequence<T>(
  steps: Array<(prev?: T) => Promise<T>>,
): Promise<T | undefined> {
  let result: T | undefined
  for (const step of steps) {
    result = await step(result)
  }
  return result
}
