#!/usr/bin/env node
/**
 * dump-spec.cjs — 把**当前这套桌宠的完整规格**导出成 JSON
 *
 * 为什么要有它：做第二套宠物时，唯一可靠的"标准"就是**已经跑通的这一套**。
 * 手写一份规格文档一定会和代码漂移（这个项目已经吃过好几次亏：
 * 菜单漏映射、README 写"四个节点"实际是六个…）。
 *
 * 所以规格**从运行时代码里读**，不是从文档里抄：
 *   · `CLIPS`        —— 有哪些动画、几帧、靠什么动
 *   · `IDLE_CHAIN`   —— 待机链的节点和权重
 *   · `FRAME_FILES`  —— 需要哪些图、文件叫什么
 *   · `dialogues`    —— 每个状态说哪些话、几档催促
 *
 * ⚠️ 不解析源码文本 —— `pet.js` 是普通 `<script>`，里面 `const CLIPS = {`
 *    这类字符串在注释里也出现过，正则抠出来的东西会错（踩过）。
 *    直接在 Electron 里加载真页面、读 `window.petDebug`，拿到的就是真的。
 *
 * 用法：`npm run dump:spec`（或 `node tools/dump-spec.cjs [输出路径]`）
 */

const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const OUT = process.argv[2] && !process.argv[2].startsWith('-')
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'pet-spec.json')

app.commandLine.appendSwitch('no-sandbox')
app.disableHardwareAcceleration()
setTimeout(() => { console.error('❌ 超时'); process.exit(2) }, 40000)

/** 这个片段靠什么动 —— 和预览页用的是同一套判断。 */
function motionOf (clip) {
  const uniq = new Set(clip.frames).size
  const axes = []
  if (Array.isArray(clip.offsetX)) axes.push('x')
  if (Array.isArray(clip.offsetY)) axes.push('y')
  if (uniq > 1 && axes.length) return 'morph+shift'
  if (uniq > 1) return 'morph'
  if (axes.length) return 'shift'
  return 'still'          // ⚠️ still 里也包含"多帧同图又没位移"（假动画）
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 700, height: 600, show: false,
    webPreferences: { contextIsolation: true } })
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'preview.html'))
  await new Promise((r) => setTimeout(r, 2200))

  const dbg = await win.webContents.executeJavaScript(`(() => {
    const d = window.petDebug
    return {
      clips: JSON.parse(JSON.stringify(d.CLIPS)),
      frames: JSON.parse(JSON.stringify(d.FRAME_FILES)),
      chain: JSON.parse(JSON.stringify(d.idleChain || [])),
    }
  })()`)


  const dlg = require(path.join(ROOT, 'src', 'dialogues.js'))
  const table = dlg.parse(fs.readFileSync(path.join(ROOT, 'dialogues', 'zh.md'), 'utf8'))

  const spec = {
    $comment: '由 tools/dump-spec.cjs 从运行时代码导出，不要手改 —— 改 pet.js 后重新 dump',
    dumpedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    // 素材规格（做新宠物要照这个来）
    asset: {
      // ⚠️ **每套形象实际做了哪些帧。**
      //
      //    上面那个 `frames` 是"**代码需要**哪些帧"（来自 FRAME_FILES），
      //    而 `assets/<id>/` 里是"**实际做了**哪些"。两者**本来就可能不同** ——
      //    老形象缺后来新增的动画帧是正常的（whale-girl 就缺 startle_2~6 /
      //    ready_5 / wave_3 这 7 张，运行时 showFrame 会回退到 awake）。
      //
      //    不记这个的话，只看 `frames` 会以为"规格 33 张但目录只有 26 张 = 出错了"，
      //    test-petspec.mjs 就是这么误报的。
      styles: (() => {
        const base = path.join(ROOT, 'assets')
        const out = {}
        let ids = []
        try { ids = fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory()) } catch {}
        for (const id of ids) {
          let files = []
          try { files = fs.readdirSync(path.join(base, id)).filter((f) => f.endsWith('.webp')) } catch {}
          out[id] = { has: files.sort(), count: files.length }
        }
        return out
      })(),
      styleDir: 'assets/<style-id>/',
      frameSize: 512,
      format: 'webp',
      sourceKeep: 'pet-art/character/*.png（原图，别删）',
      background: '纯绿幕 #00FF00（AI 生成用，之后抠掉）',
      naming: '文件名 = FRAME_FILES 里的值；逻辑名可以不一样（比如 ready2 → ready）',
    },
    // 需要哪些图
    frames: Object.entries(dbg.frames).map(([logical, file]) => ({ logical, file: `${file}.webp` })),
    // 有哪些动画
    clips: Object.entries(dbg.clips).map(([name, c]) => ({
      name,
      frames: c.frames,
      frameCount: c.frames.length,
      durations: c.durations,
      loop: Boolean(c.loop),
      holdLast: Boolean(c.holdLast),
      motion: motionOf(c),
      offsetX: c.offsetX ?? null,
      offsetY: c.offsetY ?? null,
    })),
    // 每个状态说什么
    dialogues: Object.fromEntries(Object.entries(table).map(([k, v]) => [k, {
      fixed: v.fixed,
      note: v.note,
      lines: v.lines,
      escalate: (v.escalate ?? []).map((e) => ({
        afterMs: e.afterMs, everyMs: e.everyMs ?? e.afterMs,
        repeat: Boolean(e.repeat), lines: e.lines,
      })),
    }])),
    // 待机链：空闲时按权重随机抽一个节点播
    idleChain: dbg.chain.map((n) => ({
      name: n.name, weight: n.weight, frames: n.clip.frames, motion: motionOf(n.clip),
    })),
    idleChainTotalWeight: dbg.chain.reduce((a, n) => a + n.weight, 0),
  }

  // ⚠️⚠️ **别把输出写到脚本自己身上。**
  //
  //     实测踩过：命令行多带了一个参数（`--no-sandbox`），它被 **Electron 自己吃掉了** ——
  //     于是 `process.argv[2]` 变成了**脚本路径**，被当成"用户指定的输出路径"，
  //     一写就把 `dump-spec.cjs` 整个换成 JSON。
  //     表相很迷惑：`pet-spec.json` 没更新，而脚本变成一个看不懂的 JSON。
  //
  // ⚠️ **这里必须 `throw`，不能用 `process.exit()`。**
  //    这段在 `executeJavaScript(...).then(...)` 的回调里 ——
  //    实测 `process.exit(2)` **不生效**：拒绝消息打出来了，下一行 `writeFileSync`
  //    照样执行，脚本还是被毁。`throw` 一定会中断这条链。
  if (path.resolve(OUT) === path.resolve(__filename)) {
    throw new Error(
      '拒绝写入：算出来的输出路径就是脚本自己（这会毁掉 dump-spec.cjs）。\n'
      + `  OUT = ${OUT}\n`
      + '  常见原因：命令行里多带了 Electron 自己的参数（如 --no-sandbox），\n'
      + '            它会被 Electron 吃掉，导致 argv[2] 变成脚本路径。\n'
      + '  用法：npm run dump:spec  [输出路径]'
    )
  }

  fs.writeFileSync(OUT, JSON.stringify(spec, null, 2) + '\n')
  console.log(`✅ 规格已导出: ${OUT}`)
  console.log(`   ${spec.frames.length} 张图 / ${spec.clips.length} 个动画 / ${Object.keys(spec.dialogues).length} 个状态`)
  const fake = spec.clips.filter((c) => c.frameCount > 1 && c.motion === 'still')
  if (fake.length) console.warn(`   ⚠️ 有假动画（多帧同图又没位移）: ${fake.map((c) => c.name).join(' ')}`)
  process.exit(0)
})
