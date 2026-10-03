/**
 * titlecase —— 按空白分词的标题大小写转换
 *
 * 纯函数、无副作用、无依赖：
 * 每个词首字母大写、其余小写；空白分隔符（含多个连续空格/制表符）原样保留。
 */

export function titlecase(s: string): string {
  return s
    .split(/(\s+)/)
    .map((token) =>
      /^\s+$/.test(token) || token === ""
        ? token
        : token.charAt(0).toUpperCase() + token.slice(1).toLowerCase(),
    )
    .join("")
}
