/**
 * shot-pet.mjs — 把宠物窗口的摸头效果渲染出来截图
 *
 * 为什么需要它：
 * 摸头的日志显示"计到 13 下、冒了 5 次爱心"，但用户说"没有效果"。
 * **日志只能证明代码跑了，证明不了用户看得见。**
 * 这个工具把渲染结果直接抓下来，让"看得见/看不见"变成可以自己核对的事实，
 * 而不是继续靠猜。
 *
 * ⚠️ 两点是抄 shot-bubble.mjs 的，缺一不可：
 *   ① 用 `.cjs` 临时脚本 spawn Electron —— Electron 主进程直接跑 .mjs 会报
 *      `Cannot read properties of undefined (reading 'exports')`
 *   ② 窗口必须 **show: true** —— 隐藏窗口会被 Chromium 节流，
 *      CSS 过渡几乎不推进，截出来是半透明的
 *
 * 用法:
 *   node shot-pet.mjs                      # 抓：常态 / 下压 / 爱心
 *   node shot-pet.mjs --frame ready_1      # 换一帧
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

// 窗口尺寸和帧名都从真实代码里读，别另外维护一份
//
// ⚠️ **两个名字都要认。** 做"可拖动缩放"时把 main.js 里的
//    `WIN_W / WIN_H` 改名成了 `BASE_W / BASE_H`（它们现在是"1 倍缩放时的
//    基准尺寸"，窗口实际尺寸还要乘 petScale），但这个脚本没跟着改 ——
//    于是 `exec(...)` 返回 null，启动就崩：
//        TypeError: Cannot read properties of null (reading '1')
//
//    **这个脚本坏了很久没人发现**，因为 `npm test` 里虽然带着它，
//    但平时跑的是单测那条链。是"发布前把每个 script 都真跑一遍"才查出来的。
const readSize = (src, ...names) => {
  for (const n of names) {
    const m = new RegExp(`const ${n} = (\\d+)`).exec(src)
    if (m) return Number(m[1])
  }
  throw new Error(`main.js 里找不到尺寸常量（试过 ${names.join(' / ')}）—— 改名了就来这里补一个`)
}
const mainSrc = fs.readFileSync(path.join(__dirname, 'src', 'main.js'), 'utf8')
const WIN_W = readSize(mainSrc, 'BASE_W', 'WIN_W')
const WIN_H = readSize(mainSrc, 'BASE_H', 'WIN_H')
const frame = process.argv.includes('--frame')
  ? process.argv[process.argv.indexOf('--frame') + 1]
  : 'idle_pillow_awake'
console.log(`▶ 宠物窗口（读自 main.js）: ${WIN_W}×${WIN_H}   帧: ${frame}`)

const mainScript = path.join(OUT, '_shot-pet-main.cjs')
fs.writeFileSync(mainScript, `
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = ${JSON.stringify(__dirname)}
const OUT = ${JSON.stringify(OUT)}
const WIN_W = ${WIN_W}
const WIN_H = ${WIN_H}
const FRAME = ${JSON.stringify(frame)}

app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIN_W, height: WIN_H,
    // ⚠️ 必须真正显示：隐藏窗口会被节流，CSS 动画几乎不推进
    show: true,
    transparent: true, frame: false, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  })

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'))
  await new Promise(r => setTimeout(r, 1800))

  const shoot = async (name, script) => {
    await win.webContents.executeJavaScript(script)
    await new Promise(r => setTimeout(r, 400))
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, 'pet-' + name + '.png'), img.toPNG())
    console.log('   ok ' + name)
  }

  const setFrame = "document.getElementById('pet').src = '../../assets/whale-girl/" + FRAME + ".webp'"

  await shoot('0-normal', setFrame)
  await shoot('1-press', setFrame + "; document.getElementById('pet').classList.add('pat-press')")
  await shoot('2-heart', "const h=document.getElementById('heart');h.classList.remove('show');void h.offsetWidth;h.classList.add('show')")
  // 并发会话角标（数量 3）
  await shoot('3-badge', "document.getElementById('badge').textContent='3';document.getElementById('badge').classList.add('show')")
  // ⚠️ 必须硬退出。
  // app.quit() 之后进程因为还有挂着的渲染层定时器而不退，
  // 外面 spawn 的人就一直等 —— 之前这个脚本要卡好几分钟。
  process.exit(0)
})
`)

const child = spawn(electron, [mainScript], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe'],
  // ⚠️ 必须清掉这个变量。
  // 本机环境里有 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 Node 跑 ——
  // require('electron') 拿到的是 npm 包而不是内置模块，于是 app 是 undefined，
  // 报 "Cannot read properties of undefined (reading 'commandLine')"。
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
})
let tail = ''
child.stdout.on('data', (d) => { tail += d })
child.stderr.on('data', (d) => { tail += d })
child.on('exit', () => {
  // ⚠️ **渲染层报错必须让这个脚本失败。**
  //
  // 踩过：headZone() 里漏了 const 声明，渲染层一启动就
  // "Uncaught ReferenceError: left is not defined"，整个摸头瘫痪 ——
  // 而四项测试全绿，因为它们都不加载渲染层。
  // 这个脚本是唯一会真正跑一遍渲染层的地方，所以错误检查必须放在这里。
  const bad = tail.split('\n').filter((l) => /Uncaught|is not defined|is not a function/.test(l))
  if (bad.length) {
    console.error('\n  ❌ 渲染层有报错:\n    ' + bad.slice(0, 5).join('\n    '))
    process.exitCode = 1
    return
  }
  const shots = fs.readdirSync(OUT).filter((f) => f.startsWith('pet-0-'))
  if (shots.length === 0) {
    console.error('\n  ❌ 没截到图 —— 渲染层多半没跑起来')
    process.exitCode = 1
    return
  }
  console.log(`\n  ✅ 渲染层无报错，截图在 ${path.relative(process.cwd(), OUT)}/pet-*.png`)
})
