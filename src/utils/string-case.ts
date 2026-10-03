/**
 * string-case —— 字符串命名格式转换（kebab-case）
 *
 * 纯函数、无副作用、无依赖：
 * 以空白、下划线、连字符作为分隔符分词，每个词转小写后用单个 `-` 连接；
 * 首尾分隔符与连续分隔符自动归一，空串输入返回空串。
 */

export function kebabCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase())
    .join("-")
}
