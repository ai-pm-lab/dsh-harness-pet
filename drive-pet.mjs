#!/usr/bin/env node
/**
 * drive-pet.mjs — 扮演插件，直接驱动桌宠（演示 / 调试用）
 *
 * 用途：在 DSH 插件还没加载时，验证桌宠 App 这一侧的完整链路
 * （WebSocket 握手 → 状态接收 → 动画切换）。
 *
 * 用法：
 *   node drive-pet.mjs                    # 跑一遍完整剧本
 *   node drive-pet.mjs needsInput         # 只切到某个状态
 *   node drive-pet.mjs working needsInput ready idle   # 按顺序切
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

const HOME = process.env.HOME || ''
const BASE = `${HOME}/Library/Application Support`

/** Electron 用 productName 做 userData 目录名（和插件保持一致） */
const CANDIDATES = [
  `${BASE}/胖头鱼/bridge.json`,
]

async function findBridge () {
  for (const f of CANDIDATES) {
    try {
      const info = JSON.parse(await readFile(f, 'utf8'))
      if (info?.port && info?.token) return { info, file: f }
    } catch { /* 试下一个 */ }
  }
  return null
}

const found = await findBridge()
if (!found) {
  console.error('❌ 找不到 bridge.json —— 桌宠没在运行？')
  for (const f of CANDIDATES) console.error('   试过:', f.replace(HOME, '~'))
  process.exit(1)
}

const { info, file } = found
console.log(`✅ 找到桌宠: ${file.replace(HOME, '~')}`)
console.log(`   ws://127.0.0.1:${info.port}/pet`)

const ws = new WebSocket(`ws://127.0.0.1:${info.port}/pet`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sendState (state, note) {
  ws.send(JSON.stringify({ type: 'state', state, detail: { reason: note ?? 'drive-pet' } }))
  console.log(`   → ${state}${note ? '   (' + note + ')' : ''}`)
}

ws.addEventListener('open', async () => {
  ws.send(JSON.stringify({ type: 'hello', token: info.token, version: info.protocol ?? 1 }))
})

ws.addEventListener('message', async (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.type === 'welcome') {
    console.log('   ✅ 握手成功\n')

    const argv = process.argv.slice(2)
    const holdIdx = argv.indexOf('--hold')
    const holdOverride = holdIdx >= 0 ? Number(argv[holdIdx + 1]) : null
    const script = argv.filter((a, i) => a !== '--hold' && i !== holdIdx + 1)
    const sequence = script.length
      ? script.map((s) => ({
          state: s,
          // ready 的庆祝约 5.8 秒；--hold 可以显式指定（测升级催促要用）
          hold: holdOverride ?? (s === 'ready' ? 12000 : 4000),
        }))
      : [
          { state: 'idle', hold: 2000, note: '空闲' },
          { state: 'working', hold: 5000, note: 'agent 在跑 → 敲键盘' },
          { state: 'needsInput', hold: 8000, note: '需要你确认 → 举双手 ⭐' },
          { state: 'working', hold: 3000, note: '你确认了，继续跑' },
          { state: 'ready', hold: 12000, note: '任务完成 → 庆祝 10 秒' },
          { state: 'blocked', hold: 4000, note: '出错了' },
          { state: 'idle', hold: 3000, note: '回到空闲' },
        ]

    console.log('【剧本开始】请看着屏幕右下角\n')
    for (const step of sequence) {
      sendState(step.state, step.note)
      await sleep(step.hold)
    }

    console.log('\n【剧本结束】')
    ws.close()
    process.exit(0)
  }
})

ws.addEventListener('error', (e) => {
  console.error('❌ 连接失败:', e.message ?? e)
  process.exit(1)
})

ws.addEventListener('close', () => {
  console.log('   连接已关闭')
  process.exit(0)
})

// 安全阀：最多跑 60 秒
setTimeout(() => { console.log('\n⏱ 超时退出'); process.exit(0) }, 60000)
