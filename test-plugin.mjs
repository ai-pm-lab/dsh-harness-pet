#!/usr/bin/env node
/**
 * test-plugin.mjs — 独立验证插件逻辑
 *
 * 为什么要这个：`desktop` profile 的补丁大概率要重启 DSH 才生效，
 * 而重启会中断当前对话。所以先用一个测试替身把整条链路跑一遍：
 *
 *   假 ctx（记录事件订阅） → 插件 → WebSocket → 真 bridge → 收状态
 *
 * 这样能验证：插件语法、事件订阅、状态推导、握手、通信协议。
 * 唯一没验证的是"DSH 会不会加载它"—— 那个必须重启才知道。
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

const require = createRequire(import.meta.url)
const bridge = require('./src/bridge.js')

const HERE = path.dirname(new URL(import.meta.url).pathname)
const TMP = path.join(HERE, '.plugin-test')

// ── 记录收到的状态 ──
const received = []
let connected = false

// ── 起一个真的桥接服务（和 App 用的是同一份代码）──
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

await bridge.start({
  stateDir: TMP,
  onState: (msg) => {
    received.push(msg.state)
    console.log(`  ← 收到状态: ${msg.state}   (${msg.detail?.reason ?? ''})`)
  },
  onConnectionChange: (c) => {
    connected = c
    console.log(`  ← 连接变化: ${c ? '已连接' : '已断开'}`)
  },
})

// ── 造一个假 ctx ──
const handlers = new Map()
const disposers = []

const ctx = {
  on (event, handler) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(handler)
    return () => {}
  },
  effect (fn) {
    // ⚠️ 收集的是 fn 的**返回值**（清理函数），不是 fn 本身。
    // 之前错把 fn 也收进去，清理阶段会把 setup 又执行一遍。
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
}

function fire (event, ...args) {
  const list = handlers.get(event) ?? []
  if (!list.length) {
    console.log(`  ⚠️  没有监听器订阅 ${event}`)
    return
  }
  for (const h of list) h(...args)
}

// ── 加载插件 ──
console.log('\n【1】加载插件')
const plugin = await import(path.join(HERE, 'pet-plugin/index.js'))
console.log(`  插件名: ${plugin.name}`)
console.log(`  inject: ${JSON.stringify(plugin.inject)}`)
if (typeof plugin.apply !== 'function') {
  console.error('  ❌ 没有导出 apply 函数')
  process.exit(1)
}
console.log('  ✅ 导出形式正确（export function apply）')

console.log('\n【2】激活插件（把 bridgePath 指向测试目录）')
plugin.apply(ctx, {
  verbose: true,
  // 关键：真实运行时用默认路径（App 的 userData），测试时指向临时目录
  bridgePath: path.join(TMP, 'bridge.json'),
})
console.log(`  已注册的事件: ${[...handlers.keys()].join(', ')}`)

// 等插件连上
await new Promise((r) => setTimeout(r, 2500))
console.log(`\n  连接状态: ${connected ? '✅ 已连接' : '❌ 未连接'}`)
if (!connected) {
  console.error('  ❌ 插件没能连上桥接服务')
  process.exit(1)
}

// ── 演练状态机 ──
console.log('\n【3】演练状态流转')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const agent = { id: 'fake-agent' }

console.log('  → agent/created')
fire('agent/created', agent)
await sleep(200)

console.log('  → agent/status = running（期望 working）')
fire('agent/status', { agent, status: 'running' })
await sleep(300)

console.log('  → approval/asked（期望 needsInput）')
fire('session/event', {}, { type: 'approval/asked' })
await sleep(300)

console.log('  → approval/decided（期望回到 working）')
fire('session/event', {}, { type: 'approval/decided' })
await sleep(300)

console.log('  → agent/status = idle（期望 ready 闪一下，再回 idle）')
fire('agent/status', { agent, status: 'idle' })
await sleep(3200)

console.log('  → agent/error（期望 blocked —— 出错要能打断庆祝）')
fire('agent/error', { agent })
await sleep(300)

// ── 庆祝窗口 ──
// 这块是踩坑的重点：任务做完后的庆祝必须能播完。
// 实测问题是 DSH 会因为后台活动报告 agent 在跑，把庆祝切成"工作中"。
console.log('\n【3b】庆祝窗口')
fire('agent/status', { agent, status: 'running' })
await sleep(200)
fire('agent/status', { agent, status: 'idle' })   // 进入庆祝窗口
await sleep(300)

const beforeNoise = received.length
console.log('  → 窗口内 agent 又报 running（期望**不**切换）')
fire('agent/status', { agent, status: 'running' })
await sleep(400)
const suppressed = received.length === beforeNoise
console.log(`     ${suppressed ? '✅ 已挡住' : '❌ 被切走了：' + received.slice(beforeNoise).join(', ')}`)
if (!suppressed) okWindow = false

console.log('  → 窗口内收到 user/message（期望**立刻**让位）')
fire('session/event', null, { type: 'user/message' })
await sleep(400)
const yielded = received.length > beforeNoise
console.log(`     ${yielded ? '✅ 已让位' : '❌ 没反应'}`)
if (!yielded) okWindow = false

// ── 结果 ──
console.log('\n【4】结果')
console.log(`  收到的状态序列: ${received.join(' → ')}`)

/**
 * 断言助手。这个文件原来是把 `ok` 手动翻来翻去，加一组新检查时
 * 很容易忘了翻 —— 所以补一个 check，新的检查都用它。
 * （老的写法保留不动，避免动到已经稳的测试。）
 */
let ok = true
function check (label, pass, hint) {
  if (pass) { console.log(`  ✅ ${label}`); return true }
  ok = false
  console.error(`  ❌ ${label}${hint ? '  ' + hint : ''}`)
  return false
}

let okWindow = true
const expect = ['working', 'needsInput', 'working', 'ready', 'idle', 'blocked']
for (const e of expect) {
  if (!received.includes(e)) { console.error(`  ❌ 缺少期望状态: ${e}`); ok = false }
}
if (ok) console.log('  ✅ 所有期望状态都出现了')
if (!okWindow) ok = false
else console.log('  ✅ 庆祝窗口行为正确')

// 验证 waterfall 不截胡
console.log('\n【5】验证不介入 DSH 决策（waterfall 透传）')
let nextCalled = false
const delegated = { ok: 'delegate' }
const waterfallHandlers = handlers.get('user-questions/request') ?? []
if (!waterfallHandlers.length) {
  console.error('  ❌ 没订阅 user-questions/request')
  ok = false
} else {
  for (const h of waterfallHandlers) {
    // 模拟 Cordis 的 waterfall：把 next 传进去，看返回值是否原样透传
    const returned = h({ id: 'q1' }, () => { nextCalled = true; return delegated })
    const passThrough = returned === delegated
    console.log(`  next() 被调用: ${nextCalled ? '✅ 是' : '❌ 否'}`)
    console.log(`  返回值原样透传: ${passThrough ? '✅ 是' : '❌ 否（waterfall 链会断）'}`)
    if (!nextCalled || !passThrough) ok = false
  }
}

console.log('\n【6】清理')
for (const dispose of disposers) {
  try { dispose() } catch { /* 忽略 */ }
}
bridge.stop()
await sleep(300)
fs.rmSync(TMP, { recursive: true, force: true })
console.log('  ✅ 已清理')

console.log('\n【新】出错要常驻，直到用户确认（三种停止方式）')
// 用户需求：「错误状态需要常驻，包括状态帧画、台词、长时间未查阅，
//            用户查看 dsh 窗口时再停止」
// ⚠️ 插件原来是 `setTimeout(() => publish('错误已过期'), 4100)` ——
//    **4.1 秒后自己撤销**，和"常驻"直接冲突，用户很可能根本没看到那 4 秒。
{
  const pj = fs.readFileSync(path.join(ROOT, 'pet-plugin', 'index.js'), 'utf8')
  const code = pj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  check('deriveState 不再用"4 秒窗口"判 blocked',
    !/lastErrorAt < 4000/.test(code),
    '时间窗会让它到点自己走掉，和"常驻"冲突')
  check('blocked 的判据是"出过错且用户没确认"',
    /lastErrorAt > 0 && !errorAcknowledged/.test(code))
  // ⚠️ 必须查**剥掉注释**的 code —— 注释里写着旧代码长什么样
  //    （"原来是 setTimeout(() => publish('错误已过期'), 4100)"），
  //    不剥的话这条断言永远失败。同一个坑在别处也踩过。
  check('noteError 里不再自己撤销',
    !/错误已过期/.test(code),
    '原来那个 4.1 秒的 setTimeout 是常驻做不成的直接原因')
  check('noteError 会清掉 ready 窗口（出错比庆祝重要）',
    /const noteError[\s\S]{0,300}readyUntil = 0/.test(pj))

  // 三种停止方式
  check('停止方式①：agent 恢复活动时清掉 blocked',
    /status === 'running' && lastErrorAt > 0/.test(pj))
  check('停止方式②：收到 ack 请求时清掉',
    /msg\.kind === 'ack'/.test(pj))
  check('停止方式③（桌宠侧）：确认时反向通知插件',
    /kind: 'ack'/.test(fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')))
  check('有个手动触发错误的入口（方便验证这条链路）',
    /msg\.kind === 'test-error'/.test(pj))

  // 桌宠侧：点一下和切前台都要通知插件，光撤气泡不够
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const ackBlock = mj.slice(mj.indexOf("ipcMain.on('pet:acknowledge'"), mj.indexOf('ipcMain.on', mj.indexOf("ipcMain.on('pet:acknowledge'") + 10))
  check('点一下她 → 撤气泡 **并且** 通知插件',
    /bubble\?\.acknowledge/.test(ackBlock) && /kind: 'ack'/.test(ackBlock),
    '只撤气泡的话，状态还在 blocked、动画还举着手，下次 publish 又推回来')
}

console.log(`\n${ok ? '✅ 插件逻辑验证通过' : '❌ 有问题'}`)
process.exit(ok ? 0 : 1)
