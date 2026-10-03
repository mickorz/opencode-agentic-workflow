/**
 * feature-development workflow —— v0.3.x Adoption 招牌 Demo（功能实现链）
 *
 * 链路：需求 -> 分析 -> 实现（隔离 worktree）-> 确定性 check（失败自动修复重试）
 *       -> commit 固化 -> 语义 verify（reviewer 审查真实 diff）-> 人工审批
 *
 * 一眼展示「workflow > 单 agent」的差异点：
 *   确定性验证（check）／失败恢复（修复回路 + journalled step + resume）／
 *   语义审查（verify）／人工决策（checkpoint）／可观测（journal/trace/metrics）。
 *
 * 产物固化设计（关键）：
 *   - 实现以 commit 落在 agw/<runId> 分支上；worktree 按 cleanup 策略清理后
 *     分支保留，交付物不随 worktree 消失（v1 回流方式 = 人工 merge/cherry-pick）。
 *   - commit 命令幂等（无暂存变更时跳过提交）：check 步骤崩溃后 resume 重跑
 *     不会因「nothing to commit」卡死。
 *
 * 前置要求：isolation（git-worktree）——无隔离时 fail-fast 并给出配置指引。
 */

import type { WorkflowDefinition } from "../registry/definition.js"
import { observeWorkflow } from "../observability/observe.js"
import { phase } from "../workflow/phase.js"
import { agent } from "../workflow/agent.js"
import { retry } from "../workflow/retry.js"
import { commandSuccess } from "../quality/predicates.js"
import { assertVerify, type ReviewVerdict } from "../quality/verify.js"
import { checkpoint } from "../quality/checkpoint.js"
import { getCommandRunner } from "../runtime/command.js"

export interface FeatureDevelopmentArgs {
  /** 功能需求（即 feature request 文本） */
  topic: string
  /** check 命令（在 worktree 根执行；默认安装依赖 + typecheck + test） */
  checkCommand?: string
  /** reviewer 数量，默认 2 */
  reviewers?: number
  /**
   * 保留锁文件变更（默认 false）：check 命令（npm install 等）可能重写
   * package-lock.json 等锁文件，默认在固化前恢复该噪声（五连坑坑 1）；
   * 需求本身涉及依赖变更时置 true。
   */
  keepLockfileChanges?: boolean
}

/** 链路累积状态：每步返回 {...prev, 新字段}，journal 逐步落盘（resume 依赖） */
export interface FeatureDevState {
  baseSha?: string
  plan?: string
  implementation?: string
  checkLabel?: string
  checkOk?: boolean
  fixRounds?: number
  branch?: string
  commitSha?: string
  diffStat?: string
  verdicts?: ReviewVerdict[]
  approved?: boolean
}

/**
 * 默认 check 命令：装依赖（worktree 无 node_modules）-> typecheck（若有脚本）
 * -> test（若有脚本）。--if-present 使默认值对任意 npm 项目安全。
 */
export const DEFAULT_FEATURE_CHECK_COMMAND =
  "npm install --silent --no-audit --no-fund && " +
  "npm run typecheck --if-present && npm test --if-present"

/** check 命令超时（npm install + 全量测试的保守上限） */
const CHECK_TIMEOUT_MS = 900_000
/** check 失败后的修复回路轮数（fix agent + 复检） */
const MAX_FIX_ROUNDS = 2
/** 提供给 reviewer 的 diff 文本上限（超出截断） */
const MAX_DIFF_CHARS = 24_000

/** 在 workspace 内执行 git 并返回结果（stdout 供调用方解析） */
function git(root: string, gitArgs: string) {
  return getCommandRunner().run(`git ${gitArgs}`, { cwd: root })
}

/** commit 信息安全化：剔除 shell 元字符，截断长度 */
function safeCommitSubject(topic: string): string {
  return topic.replace(/[`'"\\\n$;]/g, " ").slice(0, 100)
}

export function featureDevelopmentWorkflow(hostOptions?: {
  checkCommand?: string
  reviewers?: number
}): WorkflowDefinition<FeatureDevelopmentArgs, { output: string }> {
  return {
    id: "feature-development",
    version: "1.1.0",
    description:
      "需求分析 -> 隔离 worktree 实现 -> 确定性 check（失败自动修复重试）-> " +
      "reviewer 审查真实 diff -> 人工审批；产物固化为 agw/<runId> 分支 commit。" +
      "需启用 isolation（git-worktree）",
    argsSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "功能需求描述（feature request）" },
        checkCommand: {
          type: "string",
          description: "确定性检查命令（在 worktree 根执行，默认 npm install + typecheck + test）",
        },
        reviewers: { type: "integer", description: "reviewer 数量（默认 2）" },
        keepLockfileChanges: {
          type: "boolean",
          description: "保留锁文件变更（默认 false：check 引发的 lockfile 重写会被恢复；需求涉及依赖变更时置 true）",
        },
      },
      required: ["topic"],
    },
    stepNames: ["analyze", "implement", "check", "verify", "checkpoint"],

    async run(args, ctx) {
      const root = ctx.workspaceRoot
      if (!root) {
        throw new Error(
          "[feature-development] 该 workflow 需要 workspace 隔离：" +
            '请在插件 options 中配置 "isolation": { "mode": "git-worktree" } 后重试。',
        )
      }

      const checkCommand =
        args.checkCommand ??
        hostOptions?.checkCommand ??
        DEFAULT_FEATURE_CHECK_COMMAND
      const reviewers = args.reviewers ?? hostOptions?.reviewers ?? 2

      return observeWorkflow(
        "feature-development",
        async () => {
          phase("Develop")

          const state = await ctx.runSteps<FeatureDevState>(
            [
              // 1. 分析：读取仓库（隔离副本），产出实现计划
              async () => {
                const head = await git(root, "rev-parse HEAD")
                if (head.code !== 0 || !head.stdout.trim()) {
                  throw new Error(
                    "[feature-development] workspace 不是可用的 git 仓库" +
                      "（isolation.mode 应为 git-worktree）",
                  )
                }
                const plan = await agent(
                  "你是资深工程师。当前工作目录是仓库的隔离副本，" +
                    "可以自由读取文件、探索结构，但不要修改任何文件。\n" +
                    `需求：${args.topic}\n` +
                    "请给出简明实现计划：改动文件清单（新增/修改）、" +
                    "每个文件的职责、测试计划（测试文件路径 + 覆盖场景）。\n" +
                    "只输出计划文本；禁止调用 workflow / workflow_metrics 工具。",
                )
                return { baseSha: head.stdout.trim(), plan: plan.output }
              },

              // 2. 实现：agent 在 worktree 内按计划编码（cwd 已绑定 workspace 根）
              async (prev) => {
                const result = await agent(
                  "按照以下实现计划，在当前工作目录（仓库隔离副本）中完成编码：\n\n" +
                    `${prev?.plan ?? ""}\n\n要求：\n` +
                    "- 严格按计划创建/修改文件，并补齐计划中的测试文件\n" +
                    "- 不要执行 npm install / npm test / git commit" +
                    "（由 workflow 的后续步骤统一负责）\n" +
                    "- 完成后只回复：done + 变更文件清单（每行一个路径）\n" +
                    "禁止调用 workflow / workflow_metrics 工具。",
                )
                return { ...prev, implementation: result.output }
              },

              // 3. 确定性 check：命令真实执行于 worktree 根；
              //    失败 -> 修复回路（fix agent + 复检，有界）-> 通过后 commit 固化（幂等）
              async (prev) => {
                const label = `check: ${checkCommand} (in workspace)`
                const checkOnce = () =>
                  commandSuccess(checkCommand, {
                    cwd: root,
                    timeoutMs: CHECK_TIMEOUT_MS,
                  })

                let checkOk = await checkOnce()
                let fixRounds = 0
                if (!checkOk) {
                  await retry(
                    async () => {
                      fixRounds += 1
                      await agent(
                        "当前工作目录中的实现未通过确定性检查：\n" +
                          `${checkCommand}\n` +
                          "请修复问题使该命令可以通过（可读取文件、修改代码与测试；" +
                          "不要执行 npm install / git commit，修复后由 workflow 复检）。" +
                          "只回复修复摘要；禁止调用 workflow / workflow_metrics 工具。",
                      )
                      const ok = await checkOnce()
                      if (!ok) throw new Error(`check 仍未通过：${checkCommand}`)
                    },
                    { attempts: MAX_FIX_ROUNDS, delayMs: 5_000, label: "feature-check" },
                  )
                  checkOk = true
                }

                // 五连坑坑 1 修复：check 命令（npm install 等）可能重写锁文件，
                // 固化前恢复该噪声；需求本身涉及依赖变更时经 keepLockfileChanges 保留
                if (!args.keepLockfileChanges) {
                  await getCommandRunner().run(
                    "for f in package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock bun.lockb; " +
                      'do git checkout -- "$f" 2>/dev/null || true; done',
                    { cwd: root },
                  )
                }

                // 产物固化为 commit：幂等（无暂存变更时跳过），resume 重跑安全
                const commitScript =
                  "git add -A && " +
                  `(git diff --cached --quiet || git commit -m 'agentic-workflow(feature-development): ${safeCommitSubject(args.topic)}')`
                const commit = await getCommandRunner().run(commitScript, { cwd: root })
                if (commit.code !== 0) {
                  throw new Error(`[feature-development] commit 失败: ${commit.stderr}`)
                }

                const [sha, branch, stat] = await Promise.all([
                  git(root, "rev-parse HEAD"),
                  git(root, "rev-parse --abbrev-ref HEAD"),
                  git(root, `diff --stat ${prev?.baseSha ?? "HEAD"}..HEAD`),
                ])

                return {
                  ...prev,
                  checkLabel: label,
                  checkOk,
                  fixRounds,
                  branch: branch.stdout.trim(),
                  commitSha: sha.stdout.trim(),
                  diffStat: stat.stdout.trim(),
                }
              },

              // 4. 语义 verify：reviewer 并行审查「真实 diff」（非 agent 自述）
              //    五连坑坑 4 修复：diffStat/commitSha 与 diff 同源现算，
              //    不引用 journal 中 check 步骤的缓存值（外部 amend 等修正后仍强一致）
              async (prev) => {
                const baseSha = prev?.baseSha
                if (!baseSha) {
                  throw new Error("[feature-development] verify: 缺少 baseSha（analyze 状态丢失）")
                }
                const [diff, stat, sha] = await Promise.all([
                  git(root, `diff ${baseSha}..HEAD`),
                  git(root, `diff --stat ${baseSha}..HEAD`),
                  git(root, "rev-parse HEAD"),
                ])
                const diffText =
                  diff.stdout.length > MAX_DIFF_CHARS
                    ? diff.stdout.slice(0, MAX_DIFF_CHARS) + "\n…(diff 已截断)"
                    : diff.stdout
                const freshDiffStat = stat.stdout.trim()
                const artifactText = [
                  `需求：${args.topic}`,
                  "",
                  "## 实现计划",
                  prev?.plan ?? "",
                  "",
                  "## 变更统计",
                  freshDiffStat,
                  "",
                  "## 完整 diff",
                  "```diff",
                  diffText,
                  "```",
                ].join("\n")

                const result = await assertVerify(artifactText, {
                  reviewers,
                  label: `verify: ${args.topic}`.slice(0, 80),
                  criteria:
                    "改动与需求相符、实现正确、包含覆盖关键行为的测试、" +
                    "未引入明显缺陷或破坏现有代码",
                })
                return {
                  ...prev,
                  diffStat: freshDiffStat,
                  commitSha: sha.stdout.trim(),
                  verdicts: result.verdicts,
                }
              },

              // 5. 人工审批：决定实现是否被接受
              async (prev) => {
                const verdicts = prev?.verdicts ?? []
                const passed = verdicts.filter((v) => v.verdict === "pass").length
                await checkpoint(
                  `实现已通过确定性检查` +
                    `${(prev?.fixRounds ?? 0) > 0 ? `（含 ${prev?.fixRounds} 轮自动修复）` : ""}` +
                    `与 ${passed}/${verdicts.length} reviewer 审查，` +
                    `已提交到分支 ${prev?.branch}。是否接受该实现？`,
                  { label: "accept-implementation" },
                )
                return { ...prev, approved: true }
              },
            ],
            { stepNames: ["analyze", "implement", "check", "verify", "checkpoint"] },
          )

          phase("Done")

          const verdicts = state?.verdicts ?? []
          const passed = verdicts.filter((v) => v.verdict === "pass").length
          const fixRounds = state?.fixRounds ?? 0
          const output = [
            `# Feature Development 报告：${args.topic}`,
            "",
            "1. 分析：实现计划已生成" + `（${(state?.plan ?? "").length} 字符）`,
            "2. 实现：agent 已在隔离 worktree 完成编码",
            `3. 确定性检查 ${state?.checkOk ? "通过" : "失败"}：${state?.checkLabel ?? ""}` +
              `${fixRounds > 0 ? `（经 ${fixRounds} 轮自动修复）` : ""}`,
            `4. 语义验证：${passed}/${verdicts.length} reviewer 通过`,
            `5. 审批：${state?.approved ? "已批准" : "未批准"}`,
            "",
            "## 产物（已固化为分支 commit）",
            `- 分支：${state?.branch ?? "(未知)"}`,
            `- commit：${(state?.commitSha ?? "").slice(0, 8)}`,
            "- 变更统计：",
            ...(state?.diffStat ?? "")
              .split("\n")
              .filter(Boolean)
              .map((line) => `  ${line}`),
            `- worktree：${root}（按 cleanup 策略处理；分支保留）`,
            "",
            "回流方式：对目标仓库 `git merge` / `git cherry-pick` 该分支即可引入实现。",
          ].join("\n")

          return { output }
        },
        { topic: args.topic, checkCommand, reviewers },
      )
    },
  }
}
