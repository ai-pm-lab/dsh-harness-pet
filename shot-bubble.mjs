#!/usr/bin/env node
/**
 * shot-bubble.mjs — 把气泡渲染成图片，用来验收排版
 *
 * 为什么需要它：气泡的排版问题（比如宽度塌缩成一字一行）靠读 CSS 很难发现，
 * 而每次改完都让用户看一眼、回报一次，来回成本太高。
 * 这里用 Electron 把 src/bubble/index.html 真渲染一遍并截图。
 *
 * 用法：
 *   node shot-bubble.mjs                  # 截几张典型长度
 *   node shot-bubble.mjs "自定义文字"       # 截指定文字
 *
 * ⚠️ 会和正在运行的桌宠抢单实例锁，所以脚本会先把桌宠关掉、截完再启动回来。
 *
 * ⚠️ **已知限制：第一张截图的 alpha 不准。**
 * 第一次 show() 之后截到的气泡是半透明的（alpha≈118），后面几张都正常。
 * 原因在截图管线：内容全透明的窗口 Chromium 不一定提交新帧，
 * 淡入过渡要等到有东西强制一次合成才推进。
 * 实测真实 App 里的气泡是纯白不透明的（用户截图可证），所以这是工具的限制、不是产品问题。
 *
 * 所以这个脚本用来验**排版**（宽度、换行、高度），不要用它验像素透明度。
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const electron = require('electron')

const OUT = path.join(__dirname, '.verify')
fs.mkdirSync(OUT, { recursive: true })

/** 典型长度覆盖：短句 / 中等 / 长到要换行 / 英文长词 */
const SAMPLES = process.argv[2]
  ? [process.argv[2]]
  : [
      '完成啦！🎉',
      '有个操作要你点头 ✋',
      '……（默默放下手）',
      '你是不是把我忘了，我举着手好累的，快点回来看看我呀',
      'Responsive layout check with a verylongunbreakablewordinside',
      'OK',
    ]

// 窗口尺寸从 main.js 里读，别在这里再写一份 ——
// 写两份的话，改了 main.js 忘了这里，截图工具就会验证一个不存在的布局。
const mainSrc = fs.readFileSync(path.join(__dirname, 'src', 'main.js'), 'utf8')
const BUBBLE_W = Number(/const BUBBLE_W = (\d+)/.exec(mainSrc)[1])
const BUBBLE_H = Number(/const BUBBLE_H = (\d+)/.exec(mainSrc)[1])
console.log(`▶ 气泡窗口尺寸（读自 main.js）: ${BUBBLE_W}×${BUBBLE_H}`)

const mainScript = path.join(OUT, '_shot-main.cjs')
fs.writeFileSync(mainScript, `
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = ${JSON.stringify(__dirname)}
const OUT = ${JSON.stringify(OUT)}
const SAMPLES = ${JSON.stringify(SAMPLES)}

app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: ${BUBBLE_W},
    height: ${BUBBLE_H},
    // ⚠️ 必须真正显示出来再截图。
    // 隐藏窗口会被 Chromium 节流，CSS 过渡几乎不推进 ——
    // 之前用 show: false 截出来的气泡是半透明的（淡入只走到 46%）。
    show: true,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'bubble-preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })

  await win.loadFile(path.join(ROOT, 'src', 'bubble', 'index.html'))
  win.showInactive()   // 不抢焦点地显示；隐藏窗口的动画会被节流

  // 预热：窗口刚显示时合成器还没就绪，第一次 capturePage 会截到半透明的中间帧。
  // 丢掉这一次，后面的截图才可靠。
  await new Promise((r) => setTimeout(r, 500))
  await win.webContents.capturePage()

  const results = []
  for (let i = 0; i < SAMPLES.length; i++) {
    const text = SAMPLES[i]
    // 直接调渲染层的 show()，绕开 IPC
    await win.webContents.executeJavaScript(
      \`window.bubble.show(\${JSON.stringify({ text, durationMs: 0 })})\`
    )
    await new Promise((r) => setTimeout(r, 600))   // 等入场动画结束（160ms 过渡，留足余量）

    const measured = await win.webContents.executeJavaScript(\`
      (() => {
        const b = document.getElementById('bubble').getBoundingClientRect()
        const t = document.getElementById('text').getBoundingClientRect()
        return { bubbleW: Math.round(b.width), bubbleH: Math.round(b.height), textW: Math.round(t.width) }
      })()
    \`)

    // 用深色底截图，方便看透明区域和描边
    const image = await win.webContents.capturePage()
    const file = path.join(OUT, \`bubble-\${i}.png\`)
    fs.writeFileSync(file, image.toPNG())
    results.push({ text, ...measured, file })
  }

  fs.writeFileSync(path.join(OUT, 'bubble-measure.json'), JSON.stringify(results, null, 2))
  console.log('SHOT_RESULT ' + JSON.stringify(results))
  app.exit(0)
})
`)

console.log('▶ 关掉正在运行的桌宠（避免单实例锁冲突）')
spawn('bash', ['-c', `
  LOCK=$(readlink "$HOME/Library/Application Support/胖头鱼 · DSH 桌宠/SingletonLock" 2>/dev/null | sed 's/.*-//')
  for pid in $(pgrep -f "Study/pet-app" 2>/dev/null) \${LOCK:-}; do kill -9 "$pid" 2>/dev/null; done
`], { stdio: 'inherit' })

await new Promise((r) => setTimeout(r, 4000))

const child = spawn(electron, [mainScript], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
})

let out = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => { out += d })

await new Promise((resolve) => child.on('exit', resolve))

const line = out.split('\n').find((l) => l.startsWith('SHOT_RESULT '))
if (line) {
  const results = JSON.parse(line.slice('SHOT_RESULT '.length))
  console.log('\n气泡排版实测：')
  console.log('  文字宽度  气泡宽度  气泡高度   内容')
  for (const r of results) {
    const flag = r.bubbleW < 40 ? '  ❌ 塌缩了' : (r.bubbleH > 150 ? '  ⚠️ 快超出窗口' : '  ✅')
    console.log(`  ${String(r.textW).padStart(6)}  ${String(r.bubbleW).padStart(7)}  ${String(r.bubbleH).padStart(7)}   ${r.text.slice(0, 24)}${flag}`)
    console.log(`          computed opacity=${r.opacity}  class.show=${r.hasShow}`)
  }
  console.log(`\n截图在 ${OUT}/bubble-*.png`)
} else {
  console.error('❌ 没拿到结果，原始输出：\n' + out.slice(-2000))
}

console.log('\n▶ 重新启动桌宠')
spawn('bash', ['-c', `cd ${JSON.stringify(__dirname)} && open -n 胖头鱼（开发版）.app`], { stdio: 'inherit', detached: true }).unref()
