# node:test 测试里 gated promise 与 assert.rejects 顺序死锁

日期：2026-10-03

## 问题现象

`npx tsx --test tests/smoke/semaphore.test.ts` 完全无输出地挂起（连 `TAP version 13` 都不打印），npm test 同样超时。模块单独 import 与独立 probe 脚本均正常。

## 排查过程

- 最小复现文件（同 import + 一个简单 test）通过 → 问题在测试体而非模块。
- 定位到「slot released after failure」用例：

```ts
const first = semaphore.run(async () => { await gate.promise; throw new Error("boom") })
const second = semaphore.run(async () => "ok")
await assert.rejects(() => first, /boom/)  // 等 first reject
gate.resolve()                             // 永远执行不到 → 死锁
```

## 根因

`first` 只有在 `gate.resolve()` 之后才会 reject，而 `gate.resolve()` 排在 `await assert.rejects` 后面——经典顺序死锁。测试事件循环卡死后，node:test 的输出也一并挂起，导致「无输出挂起」的假象，容易误判为模块加载问题。

## 解决方案

先放行 gate 再 await：

```ts
await Promise.resolve()   // 让 second 入队
gate.resolve()            // 放行 first
await assert.rejects(() => first, /boom/)
assert.equal(await second, "ok")
```

## 预防/注意事项

- 写 gated/deferred 测试时，检查「谁在等谁」：凡 `await X` 依赖 gate，gate 的 resolve 必须发生在 await 之前（或由并发任务/定时器触发）。
- node:test 无输出挂起 ≠ 模块问题；先用最小用例二分定位测试体。
