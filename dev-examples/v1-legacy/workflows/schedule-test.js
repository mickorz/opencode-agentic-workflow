// schedule 功能验收脚本：最小单 agent workflow（Phase 1 MVP 用）
export const meta = { name: "schedule_test", description: "Schedule 定时触发验收" }

const now = await agent("请回复当前时间与一句话状态：schedule-test 已执行", { label: "汇报" })
log(`schedule-test 完成：${now}`)
return { status: "ok", reply: now }
