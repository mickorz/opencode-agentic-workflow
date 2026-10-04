/**
 * P2-12 Skills 打包 结构校验：SKILL.md frontmatter 合规（V2 发现规则）
 * - name 必须匹配目录名且符合 ^[a-z0-9]+(-[a-z0-9]+)*$
 * - description 1-1024 字符
 * - 正文非空
 */

import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

const SKILLS_DIR = path.join(import.meta.dirname, "../../skills")

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 解析 YAML frontmatter（name 单行；description 支持折叠块 >） */
function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) return {}
  const lines = match[1]!.split("\n")
  const result: { name?: string; description?: string } = {}
  let inFolded = false
  const folded: string[] = []
  for (const line of lines) {
    if (inFolded) {
      folded.push(line.trim())
      continue
    }
    const nameMatch = line.match(/^name:\s*(.+)$/)
    if (nameMatch) {
      result.name = nameMatch[1]!.trim()
      continue
    }
    if (/^description:\s*>-?\s*$/.test(line)) {
      inFolded = true
      continue
    }
    const descMatch = line.match(/^description:\s*(.+)$/)
    if (descMatch) result.description = descMatch[1]!.trim()
  }
  if (inFolded) result.description = folded.join(" ").trim()
  return result
}

test("skills 目录：两个 skill 均合规（frontmatter/命名/描述长度）", async () => {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  assert.deepEqual([...dirs].sort(), ["workflow-authoring", "workflow-optimize"])

  for (const dir of dirs) {
    const raw = await readFile(path.join(SKILLS_DIR, dir, "SKILL.md"), "utf8")
    const { name, description } = parseFrontmatter(raw)
    assert.ok(name, `${dir}: frontmatter 缺 name`)
    assert.equal(name, dir, `${dir}: name 必须匹配目录名`)
    assert.match(name, NAME_PATTERN, `${dir}: name 不符合 V2 命名规则`)
    assert.ok(description && description.length >= 1 && description.length <= 1024, `${dir}: description 必须 1-1024 字符`)
    // 正文非空（frontmatter 之后有实际内容）
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim()
    assert.ok(body.length > 100, `${dir}: 正文过短（应含可执行指令）`)
  }
})

test("frontmatter 解析器：折叠块与单行 description 均支持", () => {
  assert.deepEqual(parseFrontmatter("---\nname: a-b\ndescription: 单行\n---\n# x"), {
    name: "a-b",
    description: "单行",
  })
  assert.deepEqual(
    parseFrontmatter("---\nname: c\ndescription: >\n  第一行\n  第二行\n---\n正文"),
    { name: "c", description: "第一行 第二行" },
  )
})
