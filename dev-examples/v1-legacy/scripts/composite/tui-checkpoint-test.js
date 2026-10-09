// TUI checkpoint B 通道验收（P2-4 补漏）：侧栏应显示 [等待人工确认] -> [已批准]
// TUI 前台执行时 checkpoint 会弹权限确认对话框——先看侧栏等待态，再批准
export const meta = { name: 'tui_checkpoint', description: 'checkpoint 侧栏状态验收' }
phase('闸门')
const gate = await checkpoint('侧栏应显示等待人工确认，批准后继续——请点允许')
phase('收尾')
const done = await agent('回复固定文本：闸门通过')
return { gate, done }
