/**
 * dump-clips.cjs — 把「每套形象的每个动作片段」dump 成 JSON，给 make-gifs.py 用。
 *
 * ── 为什么要用 Electron 跑一遍，而不是直接读 manifest ──
 *
 * **「动作」不只在 manifest 里。** 代码里还构造了一堆：
 *   · `workingCycle()` —— 按这套素材有几张自适应
 *   · `readyCycle() + JUMP_TIMES` —— 庆祝要重复 5 次
 *   · `IDLE_CHAIN` —— 待机是 6 个小动作按权重随机抽（不是单个片段）
 *   · `sleep` / `wave` / `startle` 也各有构造逻辑
 *
 * 只读 manifest 会**漏掉一半**，而且 `clipFor()` 的优先级
 * （manifest 优先、代码兜底）也没法在 JSON 里体现。
 * ⇒ 所以**起一个真的渲染层，直接问它** —— 拿到的一定是运行时真正在播的东西。
 *
 * ── 为什么不截图 ──
 *
 * `clipFor()` 给的是**帧名**，`FRAME_FILES` 给的是**文件名** ——
 * 两个一拼就是源图路径。直接用 512×512 的源图合成，
 * **像素 1:1 零损失**，也不用管窗口大小、缩放、抗锯齿。
 * 截图反而会引入一堆噪声（实测：截图比对会被"帧间差异只有几像素"骗到）。
 *
 * ⚠️ **但 `offsetY` 必须带上** —— 那是渲染时才应用的上下位移，
 *    跳跃类的动作（`ready`）全靠它。只拿帧图会做成"原地换图"。
 *
 * ── 用法 ──
 *   node tools/run-electron.mjs --no-sandbox tools/dump-clips.cjs [--out x.json]
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const STYLES = ['big-fish', 'whale-mature', 'whale-girl', 'yuexin-miao']

// 要 dump 的片段名。
// ⚠️ 这里面有 manifest 定义的（wave/working/ready/startle），
//    也有代码构造的（sleep/greet），还有待机链上的节点（awake/blink/…）。
//    `clipFor()` 对没有的返回 undefined —— 那是正常的，跳过就好。
const CLIPS = [
  // 十个状态对应的动作
  'working', 'ready', 'wave', 'startle', 'sleep',
  // 待机链上的节点（`IDLE_CHAIN`）
  'awake', 'blink', 'slowBlink', 'blinkTwice', 'eat', 'stretch',
  // 别的
  'greet',
]

app.commandLine.appendSwitch('no-sandbox')
app.disableHardwareAcceleration()

/** 把 `durations` 里的 `[min, max]` 区间折成一个数（取中值）。 */
function foldDuration (d, seed) {
  if (Array.isArray(d) && d.length === 2 && typeof d[0] === 'number' && typeof d[1] === 'number') {
    // ⚠️ 用调用方给的随机数，别在渲染层里再摇一次 —— 那样每次 dump 出来的不一样
    return Math.round(d[0] + (d[1] - d[0]) * seed)
  }
  return d
}

app.whenReady().then(async () => {
  const out = { styles: {}, generatedAt: new Date().toISOString() }

  // ⚠️ **一个窗口反复 loadFile，不要每套建一个新的。**
  //    踩到过：`win.destroy()` 之后立刻 `new BrowserWindow()` + `loadFile`，
  //    第二套会随机报 `ERR_FAILED (-2) loading …` —— 建/毁太快有竞争。
  //    复用一个窗口就没这问题。
  const win = new BrowserWindow({
    width: 300, height: 340, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'test-selftest-stub.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  })
  const logs = []
  win.webContents.on('console-message', (_e, _l, msg) => logs.push(msg))

  const failed = []
  for (const style of STYLES) {
    // ⚠️ `loadFile` 的第二个参数带 query —— 渲染层靠 `?style=` 决定加载哪套
    try {
      await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'), { query: { style } })
    } catch (e) {
      // 一套加载失败不该让整个 dump 白跑 —— 记下来，继续下一套
      console.log(`  ${style.padEnd(14)} ❌ 加载失败: ${e.message}`)
      failed.push(style)
      continue
    }
    // 等 `boot()`（async）跑完 + 图片加载完。和演示页验证用的是同一个值。
    await new Promise((r) => setTimeout(r, 3500))

    // ⚠️⚠️ **这一步不能省。**
    //
    //    这个窗口里**没有主进程**，所以没人在启动时推 manifest 的 `clips` ——
    //    `applyClips()` 只拿到了 `__DEMO_CLIPS`（这里没有），于是
    //    `clipFor()` **全走代码兜底**。
    //
    //    踩到过：dump 出来 4 套的 `working` 都是 `7种/12帧`（兜底路径），
    //    而 Q版大肥鱼的 manifest 明明写的是 4 帧 ——
    //    **dump 的和真 app 里播的不是一回事**。
    //
    //    ⇒ 手动把 manifest 的 clips 塞进去（`clipFor` 读的就是 `CLIPS` 这个对象）。
    //      规范化逻辑和 `applyClips()` 保持一致：`durations` 缺了按 200ms 补。
    const mfPath = path.join(ROOT, 'assets', style, 'manifest.json')
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'))
    const rawClips = mf.clips || {}
    await win.webContents.executeJavaScript(`(() => {
      const CL = window.petDebug.CLIPS
      const src = ${JSON.stringify(rawClips)}
      let n = 0
      for (const [name, c] of Object.entries(src)) {
        if (!c || !Array.isArray(c.frames) || !c.frames.length) continue
        CL[name] = {
          frames: c.frames.slice(),
          durations: Array.isArray(c.durations) && c.durations.length
            ? c.durations.slice()
            : c.frames.map(() => c.durationMs ?? 200),
          ...(Array.isArray(c.offsetY) ? { offsetY: c.offsetY.slice() } : {}),
          ...(Array.isArray(c.offsetX) ? { offsetX: c.offsetX.slice() } : {}),
          ...(c.loop != null ? { loop: Boolean(c.loop) } : {}),
          ...(c.holdLast != null ? { holdLast: Boolean(c.holdLast) } : {}),
        }
        n++
      }
      return n
    })()`)

    const dumped = await win.webContents.executeJavaScript(`(() => {
      const FR = window.petDebug.FRAME_FILES
      const res = { clips: {}, frameFiles: FR }
      const names = ${JSON.stringify(CLIPS)}
      for (const n of names) {
        let c = null
        try { c = window.petDebug.clipFor(n) } catch (e) { c = null }
        if (!c || !c.frames || !c.frames.length) continue
        // 帧名 → 文件名（拿不到的就是这套没这张，如实标出来）
        const files = c.frames.map((f) => FR[f] ?? null)
        res.clips[n] = {
          frames: c.frames,
          files,
          durations: c.durations,
          offsetY: c.offsetY ?? null,
          loop: Boolean(c.loop),
          holdLast: Boolean(c.holdLast),
          missing: c.frames.filter((f) => !FR[f]),
        }
      }
      // 待机链也带上 —— 它说明 idle 不是一个片段，而是几个节点按权重抽
      res.idleChain = (window.petDebug.idleChain || [])
        .map((n) => ({ name: n.name, weight: n.weight, frames: n.clip?.frames ?? [],
                       durations: n.clip?.durations ?? null }))
      return res
    })()`)

    // 区间时长折成确定值：用固定的种子（0.5 = 中值），保证每次 dump 一样
    for (const [name, c] of Object.entries(dumped.clips)) {
      const raw = c.durations
      if (Array.isArray(raw)) {
        c.durationsFolded = raw.map((d, i) => {
          const f = foldDuration(d, 0.5)
          return Array.isArray(f) ? f[0] : f
        })
        c.hasRanges = raw.some((d) => Array.isArray(d))
      } else {
        c.durationsFolded = c.frames.map(() => (typeof raw === 'number' ? raw : 300))
        c.hasRanges = false
      }
    }

    out.styles[style] = dumped
    // 标出每个片段是「manifest 声明的」还是「代码兜底的」—— 这两者行为不一样
    const declared = new Set(Object.keys(rawClips))
    {
      const jsObj = 'window.petDebug.CLIPS'
      for (const [name, c] of Object.entries(dumped.clips)) {
        c.source = declared.has(name) ? 'manifest' : 'code'
      }
    }
    const n = Object.keys(dumped.clips).length
    const withRange = Object.values(dumped.clips).filter((c) => c.hasRanges).length
    const fromMf = Object.values(dumped.clips).filter((c) => c.source === 'manifest').length
    console.log(`  ${style.padEnd(14)} ${String(n).padStart(2)} 个片段`
      + `（manifest 声明 ${fromMf} / 代码兜底 ${n - fromMf}）`
      + (withRange ? `，${withRange} 个含区间时长已折中值` : ''))
    const missing = Object.entries(dumped.clips)
      .filter(([, c]) => c.missing.length)
      .map(([k, c]) => `${k}:${c.missing.join('/')}`)
    if (missing.length) console.log(`  ${' '.repeat(14)} ⚠️ 缺帧: ${missing.join('  ')}`)
  }
  if (failed.length) console.log(`\n  ⚠️ ${failed.length} 套加载失败: ${failed.join(', ')}`)
  win.destroy()

  const argOut = process.argv.find((a) => a.startsWith('--out='))
  const outPath = argOut ? argOut.slice(6) : path.join(ROOT, '.verify', 'clips.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log(`\n  ✅ ${outPath}`)
  app.exit(0)
})
