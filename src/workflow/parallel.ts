/**
 * parallel() —— 并行执行多个任务，全部完成后返回结果数组
 *
 * P0 用 Promise.all 实现：任一失败即整体失败（fail-fast）。
 * P1 再考虑 failure strategy / 并发上限。
 */

export async function parallel<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  return Promise.all(tasks.map((task) => task()))
}
