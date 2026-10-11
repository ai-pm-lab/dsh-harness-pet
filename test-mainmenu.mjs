#!/usr/bin/env node
/**
 * test-mainmenu.mjs — 右键菜单不能有"调用了但没定义"的函数
 *
 * 为什么单独测这个：
 * 我用脚本改 `src/main.js` 时**锚点选错，一次吃掉了两个函数**
 * （`translateMenuItems` 的函数头和 `soundMenuItems` 整个函数）——
 * 而且 `node --check` **只报语法错**：函数头被吃掉时语法是合法的
 * （变成了"在另一个函数体里 return 一个数组"），
 * 真正炸的是**运行时点右键**：
 *
 *     ReferenceError: soundMenuItems is not defined
 *         at buildMenuTemplate (src/main.js:535)
 *
 * 也就是说：**语法检查抓不到这类错，测试也抓不到**（没有测试覆盖菜单构建）。
 * 这个文件就是补那一块。
 *
 * 做法：不做静态分析（正则找函数定义很容易被注释骗），
 * 而是**在 Electron 里真的把菜单建一遍**。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
let ok = true
const check = (label, pass, extra = '') => {
  console.log(`  ${pass ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!pass) ok = false
}

console.log('【1】菜单模板引用的函数都有定义')
const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
// 只看**顶格**的 function 定义 —— 缩进的是嵌套函数，不算
const defined = new Set([...src.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]))
for (const fn of ['styleMenuItems', 'soundMenuItems', 'translateMenuItems',
                  'bubbleMenuItems', 'dialogueMenuItems', 'buildMenuTemplate',
                  'applySoundSetting', 'applyStyle', 'availableStyles', 'activeStyle']) {
  check(`${fn} 有定义`, defined.has(fn))
}

console.log('\n【1.5】形象名要能从设置一路传到渲染层')
// 踩过的坑：`window-state.json` 里明明写着 style=yuexin-miao，
// 但**初始 loadFile 没带 query** —— 渲染层用默认值 'whale-girl'，
// 于是"切了月薪喵，重启又变回鲸鱼娘"，而且没有任何提示。
{
  // ⚠️ 正则别用 `[^)]*` 抓参数 —— 参数里有 `activeStyle()`，
  //    会在那个右括号处截断，把"带了 query"误判成没带（第一版就写成这样）。
  //    改成抓**整行**。
  const loadLines = src.split('\n').filter((l) => /win\.loadFile\(/.test(l))
  const withQuery = loadLines.filter((l) => l.includes('query'))
  check('初始加载带上 style', withQuery.length >= 2,
    `win.loadFile 共 ${loadLines.length} 处，带 query 的 ${withQuery.length} 处`)
  check('渲染层会读 query 里的 style',
    /URLSearchParams\(location\.search\)\.get\('style'\)/.test(
      fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')))
  // 同样别用点号转义玩花样，直接找那段字面量
  check('设置读盘时恢复全部字段（不只是 enabled）',
    src.includes('...raw.bubble'), 'loadSettingsFrom 里要有 ...raw.bubble')
}

console.log('\n【1.8】被双击/悬停时必须有反馈（不能全静默）')
// 踩过的坑：双击在非空闲状态**完全不响应**（有意设计，怕打断工作信息）。
// 但用户看到的是"双击没反应" —— 分不清"她在忙"和"功能坏了"。
// 这条测试保证每个"不打断"的分支里都**跟着一个反馈**。
{
  const pet = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.css'), 'utf8')
  check('有 nudge() 这个反馈函数', /function nudge\s*\(/.test(pet))
  // ⚠️ 别用 `/else\s*\{[^}]*nudge/` —— 分支里有模板字符串 `${logicalState}`，
  //    那个 `}` 会把 `[^}]*` 提前截断，**明明写了也判不过**（第一版就这么写的）。
  //    改成"nudge() 至少被调用过一次"，再看它是不是紧跟在 idle 判断之后。
  const nudgeCalls = (pet.match(/^\s*nudge\(\)\s*$/gm) ?? []).length
  // ⚠️ 第二版改成"非空闲也播动画"（用户的反馈是"双击没有动画，
  //    只是图画稍微扩大了一下"）—— 所以现在查的是 greet()。
  check('有 greet() 这个只播动画不改状态的函数', /function greet\s*\(/.test(pet))
  check('双击调了 greet()',
    /双击[\s\S]{0,600}?greet\(\)/.test(pet), '不管什么状态都要播动画')
  // ⚠️ **先剥掉注释再查。** 第一版直接在源码上搜，结果被我**自己写的注释**
  //    绊倒 —— greet() 的注释里解释了"reportMoment 和 reportState 是分开的"，
  //    于是"不调 reportState"这条永远失败。注释里提到某个函数名，
  //    和真的调用它，是两回事。
  const petCode = pet.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const greetBody = /function greet\s*\([\s\S]*?\n\}/.exec(petCode)?.[0] ?? ''
  check('greet() 里不改状态（不调 setState / reportState）',
    greetBody.length > 0 && !/setState\s*\(/.test(greetBody) && !/reportState/.test(greetBody),
    greetBody ? '改了状态就会打断工作信息、还会再响一声提示音' : '没找到 greet 函数体')
  // ⚠️ **光播动画不报「时刻」＝不说话。** 用户的反馈就是
  //    「双击没有显示对应的台词」—— 第一版 greet() 漏了这一步。
  check('greet() 报了「时刻」（否则气泡不说话）',
    /function greet[\s\S]{0,900}?reportMoment/.test(pet),
    "要说「在的！」或「我、我没睡！」")
  check('睡着时双击会唤醒', /function greet[\s\S]{0,400}?wakeUp\(\)/.test(pet))
  check('CSS 里有 .nudge 动画', /#pet\.nudge\s*\{/.test(css))
  check('nudge 用 scale 而不是 transform',
    /@keyframes pet-nudge[^}]*\{[^@]*scale:/.test(css) &&
    !/@keyframes pet-nudge[^@]*transform:/.test(css),
    'transform 被帧位移占用了，共用会打架')
  check('reduced-motion 里关掉了 nudge', /#pet\.nudge\s*\{\s*animation:\s*none/.test(css))
}

console.log('\n【1.9】庆祝不能被提前到达的 idle 打断')
// 踩过的坑：`readyUntil` 原来是在 `setState('ready')` **之后**才赋值的 ——
// 中间有个窗口期它还是 0，插件正好在那几毫秒里推 idle 的话，
// 上面那道"挡掉提前到达的 idle"就形同虚设，庆祝跳一次就被打断。
// 用户报的「跳跃循环只有一次」就是这个。
{
  const pet = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
  const iReady = pet.indexOf('readyUntil = clip === \'ready\'')
  const iSet = pet.indexOf('setState(clip)', iReady - 800)
  check('readyUntil 在 setState 之前赋值',
    iReady !== -1 && iSet !== -1 && iReady < iSet,
    iReady === -1 ? '没找到赋值' : `赋值@${iReady} setState@${iSet}`)
  check('有"挡掉提前到达的 idle"的逻辑',
    /clip === 'idle' && logicalState === 'ready' && Date\.now\(\) < readyUntil/.test(pet))
  check('庆祝自检会报"几趟"', /≈ \$\{trips\} 趟/.test(pet))
}

console.log('\n【1.95】预览页的按钮必须照着"素材自带的片段"建')
// 踩过的坑（两个叠在一起）：
//   ① 预览页原来直接读 `petDebug.CLIPS` —— 而 `ready`/`working` 是
//      `clipFor()` **按需构造**的，不在 CLIPS 里 → 这两个按钮**根本没出现**
//      （实测 18 个按钮里就是缺「工作中」和「完成庆祝」）。
//   ② 改成 clipFor 之后帧数还是错的 —— 因为 `boot()` 是 async，
//      `applyClips()` 在它里面，而预览页的脚本跑得更早，
//      那时拿到的是**兜底版**（月薪喵的「工作中」显示成 6 帧/位移，其实是鲸鱼娘那套）。
//      → 现在 `applyClips()` 之后广播 `pet:clips-ready`，预览页监听它重建。
{
  const pet = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
  const pv = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'preview.html'), 'utf8')
  check('petDebug 导出了 clipFor',
    /window\.petDebug = \{[\s\S]*?\bclipFor,/.test(pet),
    '不导出的话预览页拿不到按需构造的 ready/working')
  check('applyClips 之后广播 pet:clips-ready',
    /applyClips\(globalThis\.__DEMO_CLIPS[\s\S]{0,400}?pet:clips-ready/.test(pet))
  check('预览页用 clipFor 查片段（不是裸查 CLIPS）',
    /const pvClipFor = pvDebug\.clipFor/.test(pv) &&
    !/if \(!pvClips\[name\]\) continue/.test(pv) &&
    !/motionOf\(pvClips\[name\]\)/.test(pv),
    '裸查 CLIPS 会让 ready/working 用上兜底版')
  check('预览页监听 pet:clips-ready 并重建按钮',
    /addEventListener\('pet:clips-ready', buildButtons\)/.test(pv))
}

console.log('\n【1.97】右键菜单不该有「隐藏」+ 程序坞不显示图标')
// 用户要求：
//   ① 右键菜单去掉「隐藏胖头鱼」—— 藏起来就找不回来了（原来靠点程序坞图标找回，
//      现在程序坞也藏了，等于有去无回）
//   ② 程序坞里不显示图标 —— 她是常驻置顶的桌宠，不该占程序坞的位置
{
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const code = main.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  check('菜单里没有「隐藏/显示胖头鱼」这一项',
    !/隐藏胖头鱼|显示胖头鱼/.test(code),
    '藏起来就找不回来了')
  check('调用了 app.dock.hide()',
    /app\.dock\.hide\(\)/.test(code),
    '程序坞不该显示她')
  check('hideDockIcon 在 ready 之后被调用',
    /hideDockIcon\(\)/.test(code) && !/applyDockIcon\(\)/.test(code))
  check('设置窗口弹出时会抢焦点（accessory 身份下必须）',
    /app\.focus\(\{ steal: true \}\)/.test(code),
    '否则窗口会开在别的窗口后面')
}

console.log('\n【1.98】演示页的台词要跟 App 用同一份（用户改的那份）')
// 踩过的坑：话术有**两层** ——
//    1. `<userData>/dialogues/zh.md`  用户自己改的
//    2. `<App>/dialogues/zh.md`       内置默认
// 真 App 走 `dialogues.load(lang, userData)`，用户那份优先；
// 但 `build-demo.mjs` 原来是 `parse(read('dialogues/zh.md'))` —— **直接读内置**。
// 用户的反馈就是「月薪喵没有使用编辑台词那套台词，用的是默认的」。
{
  const bd = fs.readFileSync(path.join(ROOT, 'tools', 'build-demo.mjs'), 'utf8')
  check('演示页走 dialogues.load()（用户优先、内置兜底）',
    /dialoguesMod\.load\('zh'/.test(bd) &&
    !/dialoguesMod\.parse\(read\('dialogues\/zh\.md'\)\)/.test(bd),
    '直接 parse 内置那份会让演示页永远显示默认台词')
  check('userData 目录按平台推（和 Electron 的 app.getPath 一致）',
    /Library.*Application Support/.test(bd) && /APPDATA/.test(bd) && /XDG_CONFIG_HOME/.test(bd))
}

console.log('\n【1.99】「恢复默认台词」必须二次确认')
// 用户要求：二次确认后才正式重置。
// 原来点一下就直接 `fs.unlinkSync(userPath)` —— 不可逆，还没有任何提示。
{
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const code = main.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const i = code.indexOf("label: '恢复默认台词'")
  const seg = i === -1 ? '' : code.slice(i, i + 2600)
  check('点了之后先弹确认框', /dialog\.showMessageBox/.test(seg),
    '不能直接删，用户改的台词是不可逆的')
  check('默认按钮 / Esc 都落在「取消」上',
    /defaultId: 1/.test(seg) && /cancelId: 1/.test(seg),
    '手滑敲回车不该把台词弄没')
  check('用户点「取消」就直接返回，不动文件',
    /response !== 0[\s\S]{0,120}?return/.test(seg))
  check('删之前先备份',
    /copyFileSync/.test(seg) && /bak-before-reset/.test(seg),
    '万一用户改错了还能捞回来')
  check('删完立刻换回内置那份（不用重启）',
    /bubble\?\.setDialogues\?\.\(/.test(code),
    '不然用户会以为点了没反应')
}

console.log('\n【1.995】双击的动作要能回退（greet 不是每套都有）')
// 踩过的坑：`greet` 是月薪喵专属的片段（28 帧 GIF），鲸鱼娘和 Q版大肥鱼都没有。
// 直接 `playClip('greet')` 会拿不到片段 —— **双击毫无反应**。
// 启动日志里能看到 `动画自检: greet 没有定义`。
{
  const pet = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
  const code = pet.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  check('greet() 里做了「有 greet 用 greet，没有就用 wave」的判断',
    /clipFor\('greet'\)\s*\?\s*'greet'\s*:\s*'wave'/.test(code),
    '不做判断的话，没有 greet 的形象双击没反应')
  check('自检不对「没有的片段」报警',
    /if \(!c\) continue/.test(code) && !/没有定义/.test(code))
}

console.log('\n【1.996】演示页的产出路径（用户 2026-10-06 定的新规矩）')
// 规矩：桌宠项目的一切产物都放 `Study/桌宠文件/`，**不放桌面**。
// 演进：桌面 → 两处都写（漏过一次）→ 只写 `桌宠文件/`。
{
  const bd = fs.readFileSync(path.join(ROOT, 'tools', 'build-demo.mjs'), 'utf8')
  const code = bd.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  check('默认输出指向 Study/桌宠文件/',
    /桌宠文件/.test(code) && /胖头鱼演示文件\.html/.test(code),
    '不然产物会落到别处')
  check('默认输出**不再**指向桌面',
    !/Desktop[\s\S]{0,80}胖头鱼演示文件/.test(code),
    '用户明确说了不要放桌面')
  check('输出目录不存在会被创建（mkdirSync recursive）',
    /mkdirSync\(path\.dirname\(OUT\), \{ recursive: true \}\)/.test(code))
  check('DSH_DEMO_OUT 仍可覆盖输出路径',
    /process\.env\.DSH_DEMO_OUT/.test(bd))
}

console.log('\n【2】真的把菜单建一遍（这是唯一能抓到那类错的办法）')
const probe = path.join(ROOT, '.verify', '_menu.cjs')
fs.mkdirSync(path.dirname(probe), { recursive: true })
fs.writeFileSync(probe, `
const { app, Menu } = require('electron')
const path = require('node:path')
app.commandLine.appendSwitch('no-sandbox')
setTimeout(() => { console.error('超时'); process.exit(2) }, 25000)
app.whenReady().then(() => {
  try {
    // 直接 require 主进程模块会启动整个 app（含窗口），这里改成读源码求值
    // 会丢闭包 —— 所以干脆把 buildMenuTemplate 需要的部分**摘出来单独跑**。
    // 更实际的做法：等 app ready 后调一次真正的菜单构建。
    const main = require(path.join(__dirname, '..', 'src', 'main.js'))
    void main
    console.log('MAIN_LOADED_OK')
  } catch (e) {
    console.log('MAIN_LOAD_FAILED ' + e.message)
  }
  process.exit(0)
})
`)
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app',
  'Contents', 'MacOS', 'Electron')
if (!fs.existsSync(electron)) {
  console.log('  ⚠️  找不到 Electron，跳过运行时检查')
} else {
  const r = spawnSync(electron, ['--no-sandbox', probe], {
    encoding: 'utf8', timeout: 40000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  // ⚠️ 只要出现 "is not defined"，就是那类错误
  const undef = out.match(/ReferenceError: (\w+) is not defined/)
  check('主进程模块能加载、没有未定义引用',
    !undef, undef ? `未定义: ${undef[1]}` : (out.includes('MAIN_LOADED_OK') ? '已加载' : ''))
}
fs.rmSync(probe, { force: true })

console.log('\n【1.994】庆祝动画要跳 5 下（别只跳 1 下）')
// 踩过的坑：`clipFor()` **先查 manifest 的 `clips`**，
// 一旦某个形象在 manifest 里定义了 `ready`，代码里的
// `readyCycle() + JUMP_TIMES(=5)` 就被**顶掉了**。
// 我给 Q版大肥鱼写 manifest 时只写了 4 帧（1 个周期），
// 用户反馈「完成状态的循环只有一次」。
// → 在 manifest 里定义 `ready` 的形象，**必须自己把重复写进帧序里**。
{
  const dir = path.join(ROOT, 'assets')
  for (const id of fs.readdirSync(dir)) {
    const mf = path.join(dir, id, 'manifest.json')
    if (!fs.existsSync(mf)) continue
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
    const r = (m.clips || {}).ready
    if (!r) continue      // 没定义 → 走代码里的 readyCycle()，天然 5 次
    const uniq = new Set(r.frames).size
    const times = r.frames.length / uniq
    check(`${id}: manifest 的 ready 重复了多次（${r.frames.length} 帧 / ${uniq} 种 = ${times} 次）`,
      times >= 3,
      '只写 1 个周期的话，庆祝只会跳 1 下')
  }
}

console.log('\n【1.995】manifest 的 clips 引用的帧名必须真的存在')
// 踩过的坑（2026-10-06，接「成熟比例鲸鱼娘」时）：
// 我把 manifest 的 working 写成了 `work0 work1 work2`，
// 心想"我有 working_0/1/2 三帧，那不就是 work0/1/2 吗" —— **错了**。
// `FRAME_FILES` 里 work1 指的是**过渡帧** `working_0_1`，我没有那张：
//   work0 → working_0      work2 → working_1      work4 → working_2
// 结果 work1 加载不到、回退成 awake，表现是**笔记本一会儿有一会儿没有、整只在闪**。
// 当时**没有任何测试能抓到** —— 只有运行时一条「素材自检: ⚠️ 有画面没加载到」
// 的日志警告（还不影响退出码）。
// 所以补一条硬检查：clips 里出现的每个帧名，都要能对应到**磁盘上真有的图**。
{
  // ⚠️ 不用正则去匹配对象内容（容易被注释里的花括号骗，见文件头的教训）。
  //    这里按**花括号配对**把字面量整段切出来，再交给 JS 自己求值。
  const readObjectLiteral = (source, name) => {
    const at = source.indexOf(`const ${name} = {`)
    if (at < 0) return null
    const open = source.indexOf('{', at)
    let depth = 0
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') {
        depth--
        if (depth === 0) return new Function(`return (${source.slice(open, i + 1)})`)()
      }
    }
    return null
  }
  const petJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
  const FRAME_FILES = readObjectLiteral(petJs, 'FRAME_FILES')
  const STYLE_FRAMES = readObjectLiteral(petJs, 'STYLE_FRAMES')
  check('能从 pet.js 解析出 FRAME_FILES / STYLE_FRAMES',
    !!FRAME_FILES && !!STYLE_FRAMES,
    `FRAME_FILES ${FRAME_FILES ? Object.keys(FRAME_FILES).length : 0} 项`)

  if (FRAME_FILES && STYLE_FRAMES) {
    const dir = path.join(ROOT, 'assets')
    for (const id of fs.readdirSync(dir)) {
      const mf = path.join(dir, id, 'manifest.json')
      if (!fs.existsSync(mf)) continue
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
      const clips = m.clips || {}
      if (!Object.keys(clips).length) continue
      // 这套宠物自己的帧名会并进通用表（见 pet.js 的 STYLE_FRAMES 说明）
      const table = { ...FRAME_FILES, ...(STYLE_FRAMES[id] || {}) }
      const present = new Set(
        fs.readdirSync(path.join(dir, id)).filter((f) => f.endsWith('.webp')))
      for (const [clipName, c] of Object.entries(clips)) {
        if (!c || !Array.isArray(c.frames) || !c.frames.length) continue
        const uniq = [...new Set(c.frames)]
        const bad = uniq.filter((f) => {
          const file = table[f]
          return !file || !present.has(`${file}.webp`)
        })
        check(`${id} · ${clipName} 的 ${uniq.length} 个帧名都能对应到磁盘上的图`,
          bad.length === 0,
          bad.length ? `缺 ${bad.join(' ')}（会回退成 awake → 道具在闪）` : '')
      }
    }
  }
}

console.log('\n【1.995】缩放：夹取范围 / 底边锚定 / IPC 通道')
// 踩过的坑与设计约束：
//   · 下限 0.5 —— 再小看不清；**上限不设**（用户要先看放大效果）
//   · 缩放时必须**锚定底边中心**。只改尺寸而不动 (x,y) 的话，
//     宠物的脚会顺着往下跑（她站在窗口底部），看起来像"跳了一下"
//   · 窗口尺寸要用 winW()/winH() 取，不能引用基准常量去算几何
{
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const code = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  check('有 MIN_SCALE 且下限是 0.5', /MIN_SCALE\s*=\s*0\.5/.test(code))
  // ⚠️ 这条最初写的是"**不许**有上限"（用户说了"最大不限制"）。
  //    后来加了 MAX_SCALE = 8 —— 它不是产品限制，是**防爆阀**：
  //    实测正反馈事故里倍率飙到 16518%、窗口 3 万像素宽。
  //    所以判据改成"上限必须**足够宽松**（≥ 4 倍）"：
  //    既守住"正常使用摸不到天花板"，又保住"失控时有人兜底"。
  const maxMatch = code.match(/MAX_SCALE\s*=\s*([0-9.]+)/)
  check('上限存在且足够宽松（≥ 4 倍，正常使用碰不到）',
    Boolean(maxMatch) && Number(maxMatch[1]) >= 4,
    maxMatch ? `MAX_SCALE = ${maxMatch[1]}` : '没有 MAX_SCALE —— 失控时没人兜底')
  check('上限不是 1（那就成产品限制了）',
    !maxMatch || Number(maxMatch[1]) > 1)
  check('有 pet:resize 通道', /'pet:resize'/.test(mj))
  check('有 pet:resize-end 通道（写盘）', /'pet:resize-end'/.test(mj))
  check('有 pet:get-scale 通道', /'pet:get-scale'/.test(mj))
  check('缩放时锚定底边中心（横向补一半、纵向补整段）',
    /\(w - nw\) \/ 2/.test(code) && /y \+ \(h - nh\)/.test(code),
    '不锚定的话宠物的脚会往下跑')
  check('窗口尺寸走 winW()/winH()，不再直接引用基准常量',
    /width: winW\(\)/.test(code) && /height: winH\(\)/.test(code))
  check('缩放会夹到下限', /Math\.max\(MIN_SCALE, scale\)/.test(code))
  check('缩放后气泡跟着重新定位', /bubble\?\.reposition\(\)/.test(code))

  // 设置文件里要存 scale，且恢复时要在 bubble 那条判断**之前**
  check('读设置时恢复 scale', /Number\.isFinite\(raw\?\.scale\)/.test(code))
  check('写设置时存 scale', /scale: petScale/.test(code))

  // renderer 侧
  const pj = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
  check('手柄元素 id 和 index.html 对得上',
    /getElementById\('resize-handle'\)/.test(pj) &&
    fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8').includes('id="resize-handle"'))
  check('命中判定把守柄算进去了（否则手柄会闪）',
    /isOverHandle\(/.test(pj) && /const hot = opaque \|\| overHandle/.test(pj),
    '只认 isOpaqueAt 的话，鼠标一移向手柄就穿透、手柄消失，来回闪')
  check('手柄显示用了滞回（不是每次 mousemove 重判）',
    /HANDLE_HIDE_DELAY/.test(pj) && /setTimeout/.test(pj.slice(pj.indexOf('function noteHoverForHandle'))))
  check('双击手柄会 stopPropagation（否则会同时触发打招呼）',
    /function resetScale[\s\S]{0,300}stopPropagation/.test(pj))

  // preload 暴露
  const pl = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8')
  for (const api of ['resize', 'resizeEnd', 'getScale']) {
    check(`preload 暴露了 pet.${api}`, new RegExp(`${api}:`).test(pl))
  }
  // 自检 stub 也要同步（漏了自检会报 IPC=❌）
  const stub = fs.readFileSync(path.join(ROOT, 'test-selftest-stub.cjs'), 'utf8')
  for (const api of ['resize', 'resizeEnd', 'getScale']) {
    check(`自检 stub 也有 ${api}`, new RegExp(`${api}:`).test(stub),
      'stub 是手写的，preload 加了新方法就得同步补')
  }
}

console.log('\n【1.995b】缩放的三条防线（防正反馈失控）')
// 实测事故：拖一下手柄，倍率一路飙到 16518%（窗口 3 万像素宽），
// 窗口被甩到屏幕外几万像素，用户看到的是"没放大、反而飞走了"。
// 根因是渲染层用了视口坐标 clientX/clientY —— 窗口一移动它就变，形成正反馈。
{
  const pj = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const mcode = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  // 防线 1：屏幕坐标
  const moveFn = pj.slice(pj.indexOf('function moveResize'), pj.indexOf('function endResize'))
  check('moveResize 用 screenX/screenY（屏幕坐标）',
    /event\.screenX/.test(moveFn) && /event\.screenY/.test(moveFn),
    '用 clientX/clientY 会正反馈：窗口一移，坐标就变，倍率越滚越大')
  check('moveResize 里**没有** clientX/clientY',
    !/event\.client[XY]/.test(moveFn),
    '这两个是视口坐标，窗口移动后就变了')

  // 防线 2：渲染层安全阀
  check('渲染层有单次变化率夹取（防爆）',
    /lastSentScale \* 1\.6/.test(moveFn) && /lastSentScale \/ 1\.6/.test(moveFn),
    '正常拖动手速到不了这个变化率，撞上就是又出环了')

  // 防线 3：主进程硬上限
  check('主进程有 MAX_SCALE（兜底）', /MAX_SCALE\s*=\s*8/.test(mcode))
  check('pet:resize 夹了上限',
    /Math\.min\(MAX_SCALE, Math\.max\(MIN_SCALE, scale\)\)/.test(mcode))
  check('读盘恢复 scale 时也夹上限',
    /Math\.min\(MAX_SCALE, Math\.max\(MIN_SCALE, raw\.scale\)\)/.test(mcode),
    '否则被坏版本写坏的 165 倍会被读回来')

  // 拦截必须同步（await 之后才 preventDefault 就晚了）
  const beginFn = pj.slice(pj.indexOf('function beginResize'), pj.indexOf('/**\n * 拖动中'))
  check('beginResize 不是 async（拦截必须同步做）',
    !/async function beginResize/.test(pj),
    'await 之后才 preventDefault/stopPropagation 的话，事件早就传完了')
  check('beginResize 一进来就 preventDefault/stopPropagation',
    /function beginResize[\s\S]{0,400}?preventDefault/.test(beginFn),
    '不能在 await 之后')
  check('beginResize 用屏幕坐标算锚点',
    /window\.screenX \+ a\.x/.test(beginFn) && /window\.screenY \+ a\.y/.test(beginFn))
  check('beginResize 不再 await getScale（用缓存的 knownScale）',
    /const scale = knownScale/.test(beginFn))
}

console.log('\n【1.995c】缩放的单调性：一路往一个方向拖，倍率不能翻回来')
// 用户报的第二个 bug：
//   「向右下拖动放大，不松手改往左上拖会缩小，
//     但继续左上拖到一定距离会变为放大」
// 根因：算倍率用**到锚点的距离**（`hypot(现在-锚点)/起始距离`）——
// 距离是**没有方向的半径**，越过锚点之后重新变大，倍率就翻回去了。
// （「往东 100 米」和「往西 100 米」离原点的距离都是 100。）
// 修法：改用**位移在放大方向上的投影**（有正负，越过锚点后继续变负）。
{
  const pj = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
  // ⚠️ **必须剥掉注释再查。** 函数上方的注释里就写着 `hypot(...)` 用来解释
  //    旧算法 —— 不剥的话 `!/hypot/` 会被自己的注释判红（刚踩过）。
  const moveFn = pj.slice(pj.indexOf('function moveResize'), pj.indexOf('function endResize'))
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  check('用投影（位移 · 方向向量），不是到锚点的距离',
    /event\.screenX - startX\) \* ux/.test(moveFn) && /event\.screenY - startY\) \* uy/.test(moveFn))
  check('moveResize 的**代码**里没有 hypot（那就会退回"半径"）',
    !/hypot/.test(moveFn),
    'hypot 算的是无方向的距离，越过锚点会翻回去')
  check('起始时就存了方向向量 ux/uy 和起点 startX/startY',
    /ux, uy,/.test(pj) && /startX: event\.screenX/.test(pj))
  check('dist + proj 有下限（别算成 0 或负数）',
    /Math\.max\(dist \* 0\.1, dist \+ proj\)/.test(moveFn))

  // ── 真的跑一遍单调性 ──
  // 照 pet.js 的算法复刻：锚点在右下方向、沿 u 一路往回拖
  const anchorX = 1100, anchorY = 700
  const startX = 1194, startY = 794
  const dist = Math.max(24, Math.hypot(startX - anchorX, startY - anchorY))
  const ux = (startX - anchorX) / dist, uy = (startY - anchorY) / dist
  const clamp = (v) => Math.min(8, Math.max(0.5, v))
  const scaleOf = (d) => {
    const mx = startX + d * ux, my = startY + d * uy
    const proj = (mx - startX) * ux + (my - startY) * uy
    return clamp(1 * (Math.max(dist * 0.1, dist + proj) / dist))
  }
  const scaleOfOld = (d) => {           // 旧算法，用来确认"它真的会翻"
    const mx = startX + d * ux, my = startY + d * uy
    return clamp(1 * (Math.hypot(mx - anchorX, my - anchorY) / dist))
  }

  // ① 一路往左上拖（d 递减），倍率必须**单调不增**
  let mono = true
  let prev = Infinity
  for (let d = 60; d >= -300; d -= 5) {
    const v = scaleOf(d)
    if (v > prev + 1e-9) { mono = false; break }
    prev = v
  }
  check('一路往左上拖，倍率单调不增（不会半路翻回放大）', mono,
    mono ? '' : '越过锚点后又变大了 —— 就是用户报的那个 bug')

  // ② 反向：一路往右下拖，必须单调不减
  let mono2 = true
  prev = -Infinity
  for (let d = -60; d <= 300; d += 5) {
    const v = scaleOf(d)
    if (v < prev - 1e-9) { mono2 = false; break }
    prev = v
  }
  check('一路往右下拖，倍率单调不减', mono2)

  // ③ 反证：旧算法**确实会翻** —— 这条保证测试不是空转
  let oldFlips = false
  let oldPrev = Infinity
  for (let d = 60; d >= -300; d -= 5) {
    const v = scaleOfOld(d)
    if (v > oldPrev + 1e-9) { oldFlips = true; break }
    oldPrev = v
  }
  check('（反证）旧的"距离法"确实会翻回去', oldFlips,
    '如果它不翻，说明我复刻错了，上面两条也就没在验真的东西')
}

console.log('\n【1.993】桌宠不该在"非用户主动"的时候抢焦点')
// 用户报过「操作别的窗口时，桌宠状态变更会影响我的操作」。
// 实测结论（推 6 次状态，含 3 次 needsInput，前台应用一次都没被抢走）：
//   · **状态变更不抢焦点** —— 气泡用 showInactive、桌宠本身 focusable:false
//   · 但**启动那一下**用的是 win.show()，会抢 —— 已改成 showInactive
//   · 剩下的 app.focus({steal:true}) 只在**用户点菜单**时走（恢复台词 / 打开设置），
//     那是合理的：不抢的话对话框会开在别的窗口后面，用户以为点了没反应
{
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const code = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  check('桌宠窗口 focusable: false', /focusable:\s*false/.test(code))
  check('气泡窗口 focusable: false', (code.match(/focusable:\s*false/g) || []).length >= 2,
    '气泡和桌宠都不该抢焦点')
  check('气泡用 showInactive 显示', /bubbleWin\.showInactive\(\)/.test(code))
  check('桌宠启动用 showInactive（不是 show()）',
    /ready-to-show[\s\S]{0,80}showInactive/.test(code),
    'show() 会在启动时抢走焦点，打断用户正在打的字')
  check('代码里没有裸露的 win.show()',
    !/win\.show\(\)/.test(code),
    'win.show() 会抢焦点；桌宠显示一律走 showInactive')

  // app.focus({steal:true}) 允许存在，但必须都在"用户主动"的路径里
  const steals = (code.match(/app\.focus\(\{\s*steal:\s*true\s*\}\)/g) || []).length
  check(`app.focus({steal:true}) 只出现在菜单/设置路径（当前 ${steals} 处）`,
    steals <= 2,
    '多了就说明有地方在非用户主动时抢焦点')
}

console.log('\n【1.992】切换形象后 clips 必须重新推送（once → on）')
// 用户报的照片证据：working 播到一半插进一帧**站立姿势**（awake）。
// 根因是 `did-finish-load` 用了 `once` —— 切换形象会 loadFile 重新加载，
// 第二次的 did-finish-load 没有人接，clips 不再推送：
//   CLIPS['working'] 空 → 走 workingCycle()（work0~work6）
//   → 素材只有 work0~work2 → 缺帧回退 awake → 插帧
{
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const code = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  check('did-finish-load 用 on（不是 once）',
    /did-finish-load',\s*\(\)\s*=>/.test(code) && !/once\('did-finish-load'/.test(code),
    'once 的话切换形象后 clips 不再推送，working 会退回代码兜底并插进站立帧')
  check('did-finish-load 里推了 pet:clips',
    /did-finish-load[\s\S]{0,400}pet:clips/.test(code))
  check('did-finish-load 里推了 pet:frame-bounds',
    /did-finish-load[\s\S]{0,400}pet:frame-bounds/.test(code),
    '包围盒同理 —— 不重推的话摸头判定会用到上一个形象的')
  check('applyStyle 走 loadFile 重新加载（所以必须用 on）',
    /function applyStyle[\s\S]{0,400}loadFile/.test(code))

  // 兜底路径本身要有"缺帧会回退"的说明，别把回退当成 bug 删了
  const pj = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
  check('showFrame 的缺帧回退还在（那是新素材边做边看的必需品）',
    /缺帧.*用 awake 顶替/.test(pj))
}

console.log('\n【1.991】睡着时任何交互都要叫醒，并重新计时')
// 用户报：「各形象在睡着状态时，双击/摸头后都是继续睡。
//          能不能改成有交互后都醒来，后续没有动作再继续计时」
//
// 根因：`wakeUp()` 原来是"异步"的 ——
//   playClip('startle', { onDone: () => setState('idle') })
// 状态要等 startle 播完才变。但调用方（双击 / 摸头 / 悬停）紧接着就
// playClip 别的动画，把 startle 顶掉 → onDone 永不触发 →
// logicalState 一直停在 'sleep' → 那个动画播完回到 back（= 'sleep'）→ 又睡了。
{
  const pj = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
  const code = pj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  const wake = code.slice(code.indexOf('function wakeUp'), code.indexOf('function showSessionBadge'))
  check('wakeUp 里同步调 setState（不等动画播完）',
    /setState\('idle'\)/.test(wake),
    '异步的话调用方一顶掉 startle，状态就永远停在 sleep')
  check('wakeUp 里 setState 在 playClip 之前',
    wake.indexOf("setState('idle')") < wake.indexOf("playClip('startle'"),
    '顺序反了就等于没修')
  check('wakeUp 仍然清 sleepTimer（重新计时靠 setState 里的 scheduleSleep）',
    /clearTimeout\(sleepTimer\)/.test(wake))
  check('setState 里非 sleep 状态会重新排睡眠计时',
    /if \(state !== 'sleep'\) scheduleSleep\(\)/.test(code))

  // 三条调用路径都要能走到 wakeUp
  const wave = code.slice(code.indexOf('function wave'), code.indexOf('function greet'))
  check('wave（悬停）睡着时也放行（不再被 !== idle 拦掉）',
    /logicalState !== 'idle' && !isAsleep/.test(wave),
    '只写 !== idle 的话睡着时直接 return，根本叫不醒')
  check('wave 里调了 wakeUp', /wakeUp\(\)/.test(wave))

  const greet = code.slice(code.indexOf('function greet'), code.indexOf('function nudge'))
  check('greet（双击）里调了 wakeUp', /wakeUp\(\)/.test(greet))
  check('greet 的 back 在 wakeUp 之后才取（否则会回到 sleep）',
    greet.indexOf('wakeUp()') < greet.indexOf('const back'),
    'wakeUp 同步化之后 back 才是 idle；顺序反了就会 playClip(\'sleep\')')

  check('摸头的 onStroke 里调了 wakeUp',
    /onStroke:[\s\S]{0,200}wakeUp\(\)/.test(code))
}

console.log('\n【1.990】首次启动引导 + 版本号同步')
// 体检（§1.9）列出的阻塞项：宠物无边框、无程序坞图标 ——
// 新用户看到的只是屏幕角落多了个小人，**不知道能右键、能拖、能缩放**。
// 所以第一次启动要说一段引导，且**只说一次**。
{
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const pj = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
  const pl = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8')
  const code = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  check('有 pet:is-first-run 通道', /'pet:is-first-run'/.test(mj))
  check('有 pet:welcomed 通道（记下"说过了"）', /'pet:welcomed'/.test(mj))
  check('preload 暴露 isFirstRun / markWelcomed',
    /isFirstRun:/.test(pl) && /markWelcomed:/.test(pl))
  check('有 pet:say 通道（气泡是另一个窗口，渲染层碰不到它的 DOM）',
    /'pet:say'/.test(mj) && /sayExternal:/.test(pl))

  // ⚠️ 判据必须是**独立标记文件**，不能是"window-state.json 在不在"
  check('首次启动的判据用独立标记文件',
    /welcomedPath/.test(code) && /checkFirstRun/.test(code),
    '用 window-state.json 会被别处写回的位置骗过 —— 标记文件才可靠')
  check('引导文案里有"右键"和"拖"（这是新用户最不知道的两件事）',
    /右键我/.test(pj) && /小三角/.test(pj))

  // ⚠️ markWelcomed 必须在 setTimeout **里面**、说完之后
  const gi = pj.indexOf("'你好呀，我是胖头鱼")
  const mk = pj.indexOf('window.pet.markWelcomed?.()', gi)
  const end = pj.indexOf('}, TIMING.greetingDelayMs + 400)', gi)
  check('markWelcomed 在 sayExternal 之后、setTimeout 之内',
    gi > 0 && mk > gi && end > mk,
    '写在 setTimeout 外面的话它会同步立即执行，比"问是不是首次"还早 —— 引导会被跳过')

  // 版本号三处一致（脚本 + 测试都守一道）
  // ⚠️ 用文件顶部已经 import 的 spawnSync —— .mjs 里没有 CommonJS 的 require。
  //    实测踩过：直接写 require('node:child_process') 报 ReferenceError。
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'sync-version.mjs'), '--check'], { encoding: 'utf8' })
  const same = r.status === 0
  check('package.json / Info.plist / 台词文件的版本号一致', same,
    '不一致的话「改了版本才覆盖台词」的逻辑会失效')
  check('LICENSE 存在', fs.existsSync(path.join(ROOT, 'LICENSE')),
    '没有 LICENSE 别人不知道代码能不能用')
}

console.log('\n【1.989】插件没接上时主动说一句')
// 实测踩过：清空重装漏了「跑 install-plugin.mjs」这一步，
// 桌宠**正常显示、能拖能点，但永远停在"空闲"，而且不报任何错** ——
// 看起来就像"DSH 没活干"，用户会以为桌宠坏了。
{
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const code = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  check('有 watchForPlugin', /function watchForPlugin/.test(code))
  check('用 bridge.isConnected() 判断（不是猜的）',
    /watchForPlugin[\s\S]{0,600}bridge\.isConnected\(\)/.test(code))
  check('在 startBridge() 之后才检查',
    code.indexOf('watchForPlugin()') > code.indexOf('startBridge()'))
  check('提示文案里有**具体命令**（光说"没接上"用户不知道做什么）',
    /install-plugin\.mjs/.test(mj) && /profile/.test(mj))
  check('文案同时覆盖"没用 DSH"的情况（两种情况的表象一样）',
    /没用 DSH/.test(mj) || /忽略我/.test(mj))
  check('延迟可以环境变量覆盖（方便测试，生产默认 30 秒）',
    /PET_PLUGIN_HINT_MS/.test(mj))
  check('定时器 unref（不拖住退出）', /timer\.unref/.test(mj))
  check('连上了就**不提示**（有提前 return）',
    /isConnected\(\)\)\s*\{[\s\S]{0,200}return/.test(code))
}

console.log('\n【1.988】默认形象 + 菜单顺序')
{
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const pj = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
  const mjCode = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const pjCode = pj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  // ① 默认形象是一个**具名常量**，不是散在各处的字面量
  //
  //    原来 `'whale-girl'` 在 main.js 里写了 3 遍、pet.js 里 1 遍。
  //    改默认形象要改 4 处，漏一处就是"装完看到的和预览看到的不一样"。
  const defMatch = mjCode.match(/const DEFAULT_STYLE = '([^']+)'/)
  check('main.js 有 DEFAULT_STYLE 常量', !!defMatch,
    defMatch ? `= ${defMatch[1]}` : '')
  const DEF = defMatch ? defMatch[1] : null

  check('bubbleSettings 的初值用的是常量（不是字面量）',
    /style: DEFAULT_STYLE/.test(mjCode))
  check('读配置的兜底用的是常量',
    /raw\.bubble\.style[\s\S]{0,60}DEFAULT_STYLE/.test(mjCode))
  check('activeStyle 空列表的兜底用的是常量',
    /styles\.length === 0\) return DEFAULT_STYLE/.test(mjCode))

  // ② ⚠️ **渲染层的兜底必须和主进程一致。**
  //    两边是独立进程，拿不到同一个常量，只能各写一份 —— 所以只能靠测试守。
  const petDef = pjCode.match(/get\('style'\) \|\| '([^']+)'/)
  check('pet.js 的兜底和 main.js 的 DEFAULT_STYLE 一致',
    !!petDef && petDef[1] === DEF,
    petDef ? `pet.js=${petDef[1]}  main.js=${DEF}` : '在 pet.js 里没找到')

  // ③ 演示页也有一份默认值，同样要一致
  const dmb = fs.readFileSync(path.join(ROOT, 'tools', 'build-demo.mjs'), 'utf8')
  const dbDef = dmb.match(/const DEFAULT_STYLE = '([^']+)'/)
  check('build-demo.mjs 的默认形象也一致',
    !!dbDef && dbDef[1] === DEF, dbDef ? `= ${dbDef[1]}` : '')

  // ④ 菜单顺序按 manifest 的 order 排（不再靠目录名）
  check('availableStyles 读了 manifest 的 order 字段',
    /Number\.isFinite\(data\.order\)/.test(mjCode))
  check('availableStyles 按 order 排序',
    /styles\.sort\(/.test(mjCode) && /a\.order/.test(mjCode))
  // ⚠️ 没写 order 的要有确定的位置（排最后），否则菜单顺序会随文件系统变
  check('没写 order 的排到最后（有确定兜底值）',
    /order \?\? Number\.MAX_SAFE_INTEGER/.test(mjCode))

  // ⑤ 真的扫一遍 assets/，确认排序结果就是预期的那个顺序
  const assetsDir = path.join(ROOT, 'assets')
  const rows = []
  for (const e of fs.readdirSync(assetsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const mf = path.join(assetsDir, e.name, 'manifest.json')
    if (!fs.existsSync(mf)) continue
    let d = {}
    try { d = JSON.parse(fs.readFileSync(mf, 'utf8')) } catch { /* 坏了也列出来 */ }
    rows.push({ id: e.name, name: d.name || e.name, order: Number.isFinite(d.order) ? d.order : Number.MAX_SAFE_INTEGER })
  }
  rows.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id.localeCompare(b.id)))

  const EXPECT = ['big-fish', 'whale-mature', 'whale-girl', 'yuexin-miao']
  check('菜单顺序 = Q版大肥鱼 / 成熟鲸鱼娘 / 鲸鱼娘 / 月薪喵',
    JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(EXPECT),
    rows.map((r) => `${r.order}.${r.name}`).join(' → '))

  check('默认形象 = Q版大肥鱼（big-fish）', DEF === 'big-fish', `实际 ${DEF}`)

  // ⑥ 每套的 order 必须唯一 —— 重了的话排序结果取决于目录扫描顺序
  const orders = rows.map((r) => r.order).filter((o) => o !== Number.MAX_SAFE_INTEGER)
  check('每套的 order 都不重复（重了顺序会飘）',
    new Set(orders).size === orders.length, orders.join(','))
}

console.log('\n【1.987】macOS 专有 API 前面必须有守卫')
{
  // 为什么单独测这条：
  // `app.dock` **只有 macOS 有**，Windows 上是 `undefined`。
  // 原来 `hideDockIcon()` 里写的是：
  //
  //     app.dock.hide()                                          // ← 先调用
  //     if (process.platform !== 'darwin' || !app.dock) return   // ← 后守卫
  //
  // **在 macOS 上永远正常**，所以一直没暴露；真跑到 Windows 上会抛
  // `TypeError: Cannot read properties of undefined`，而且这个函数在
  // app ready 之后就被调用 —— **窗口都建不出来**。
  //
  // 这类 bug 用眼睛 review 很容易漏（"守卫在下面啊"），所以机器来守。
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  // 去掉注释再找 —— 注释里也会出现 `app.dock.hide()` 这几个字
  const code = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  // 每个"只存在于某个平台"的 API，配上它的守卫写法
  const PLATFORM_APIS = [
    { api: 'app.dock', guard: /process\.platform !== 'darwin'[\s\S]{0,40}app\.dock/,
      why: 'app.dock 只有 macOS 有，Windows 上是 undefined' },
  ]

  for (const { api, guard, why } of PLATFORM_APIS) {
    const callRe = new RegExp(api.replace('.', '\\.') + '\\.\\w+\\s*\\(', 'g')
    const calls = [...code.matchAll(callRe)]
    if (calls.length === 0) {
      check(`${api} 没有调用点（那就不用守）`, true)
      continue
    }
    const firstCall = calls[0].index
    const g = code.match(guard)
    check(`${api} 的守卫在**第一次调用之前**`, !!g && g.index < firstCall,
      g
        ? (g.index < firstCall ? `守卫@${g.index} < 首次调用@${firstCall}` : `⚠️ 守卫@${g.index} 在调用@${firstCall} **后面**`)
        : `没找到守卫（${why}）`)
  }

  // ⚠️ 这条检查本身要能被反向验证：把守卫删掉，上面那条必须变红。
  //    （手工验过：删掉 `if (process.platform !== 'darwin' ...) return` 之后确实红了）
  check('app.dock 的调用点都在同一个函数里（守卫才能覆盖到）',
    (() => {
      const calls = [...code.matchAll(/app\.dock\.\w+\s*\(/g)].map((m) => m.index)
      if (calls.length < 2) return true
      // 两次调用之间不能出现顶格的 `}`（那意味着跨函数了）
      const seg = code.slice(calls[0], calls[calls.length - 1])
      return !/\n\}\n/.test(seg)
    })())
}

console.log('\n【1.986】接 DSH 由 App 自己做（不能叫用户跑命令）')
{
  // 为什么单独测这条：
  // 原来桌宠接 DSH 靠**仓库根目录的 install-plugin.mjs**，提示文案写的是
  //     「跑一下 node install-plugin.mjs --profile desktop」
  // 这在 macOS 开发者机器上说得通 —— 但 **Windows 用户装的是 .exe**：
  //   ① 没有那个项目目录   ② 多半没装 Node.js
  // 而且那个脚本**根本没打进安装包**。等于给了一条没法照做的提示。
  //
  // 现在改由 App 自己做（`src/dsh-plugin.js`）。这几条守的就是它。

  const dpPath = path.join(ROOT, 'src', 'dsh-plugin.js')
  check('有 src/dsh-plugin.js', fs.existsSync(dpPath))
  const dp = fs.existsSync(dpPath) ? fs.readFileSync(dpPath, 'utf8') : ''
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')

  // ① 必须是**托管区块**（只动那一段，不碰用户其他配置），而且要能撤销
  check('写的是托管区块（有开始/结束标记）',
    /MARK_PREFIX = '# --- dsh-harness-pet managed/.test(dp) && /MARK_END =/.test(dp))
  check('识别按**前缀**匹配（版本号会变，不能用完整字面量）',
    /startsWith\(MARK_PREFIX\)/.test(dp))
  check('有 remove()（能一键断开）', /function remove \(patchPath\)/.test(dp))
  check('写之前先备份（YAML 写坏了能找回来）',
    /copyFileSync\(patchPath, patchPath \+ '\.dsh-harness-pet\.bak'\)/.test(dp))

  // ② 入口必须指向 index.js —— Node 的 ESM 不支持目录导入，
  //    写成目录 = 插件**静默不加载**且不报错
  check('插件入口指向 index.js（不是目录）',
    /path\.join\(pluginDir\(\), 'index\.js'\)/.test(dp))

  // ③ ⚠️⚠️ **最要命的一条：插件不能留在 app.asar 里。**
  //    DSH 是普通 Node 进程，托管区块里写的是真实文件路径 ——
  //    asar 里的路径对它不是文件。所以必须走 extraResources。
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const extra = pkg.build?.extraResources ?? []
  const hasPlugin = extra.some((e) =>
    (typeof e === 'string' ? e : e.from) === 'pet-plugin')
  check('package.json 把 pet-plugin 作为 extraResources 发出去',
    hasPlugin, JSON.stringify(extra))
  // 反过来说：files 里**不该**再包含它（那会同时进 asar，两处重复）
  const filesList = pkg.build?.files ?? []
  check('files 里没有 pet-plugin（避免两边各一份）',
    !filesList.some((f) => String(f).includes('pet-plugin')))

  // ④ 打包后要靠 process.resourcesPath 找它
  check('用 process.resourcesPath 找打包后的位置',
    /process\.resourcesPath/.test(dp))
  check('开发模式有兜底路径（resourcePath 里没有就回仓库）',
    /__dirname, '\.\.', 'pet-plugin'/.test(dp))

  // ⑤ 菜单里要能点，不能只是一行状态文字
  check('菜单里有 dshMenuItems()', /function dshMenuItems \(\)/.test(mj))
  check('菜单接线了（...dshMenuItems()）', /\.\.\.dshMenuItems\(\)/.test(mj))
  check('菜单项里能 install / remove',
    /dshPlugin\.install\(/.test(mj) && /dshPlugin\.remove\(/.test(mj))

  // ⑥ ⚠️ 文案里**不能再出现**叫用户跑命令的字样
  //    （那正是这次要修的东西；写死在这里防止哪天又被写回去）
  const codeOnly = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  check('运行时文案里没有「node install-plugin.mjs」',
    !/node install-plugin\.mjs/.test(codeOnly))

  // ⑦ 启动时先接一次（不等那 30 秒的兜底提示）
  check('启动时先调一次 autoInstall', /dshPlugin\.autoInstall\(\)/.test(mj))

  // ⑧ 没装 DSH 时不能报错、不能打扰用户
  //
  //  ⚠️ **这条真的跑一遍，不用正则。**
  //     一开始我写的是 `/catch \{\s*return \[\]\s*\}/` —— 结果没匹配上，
  //     因为 `return []` 后面跟了一句注释。**正则很容易被这种无关的东西绊倒**，
  //     而它真正想验的是行为："DSH 不存在时会不会抛"。
  //     把 DSH_HOME 指到一个不存在的目录，跑一次看结果 —— 这才是真的验了。
  {
    const r = spawnSync(process.execPath, ['-e', `
      process.env.DSH_HOME = '/nonexistent-dsh-home-for-test'
      const p = require(${JSON.stringify(dpPath)})
      const a = p.autoInstall()
      console.log(JSON.stringify({ action: a.action, profiles: p.listProfiles().length }))
    `], { encoding: 'utf8', timeout: 15000 })
    let out = null
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()) } catch { /* 解析失败就是 null */ }
    check('DSH 不存在时：不抛、不报错、action = no-dsh',
      r.status === 0 && out && out.action === 'no-dsh' && out.profiles === 0,
      out ? JSON.stringify(out) : `退出码 ${r.status} 输出 ${JSON.stringify((r.stdout || '').slice(0, 80))}`)
  }

  // ⑧b 路径解析：三平台 + `$DSH_HOME` 覆盖
  //
  //  依据是 **DSH 自己文档里写的那行**（在它的 app.asar 里）：
  //      | `dshHome` | `$DSH_HOME` or `~/.dsh` |
  //  所以我们的优先级必须和它一致 —— 不一致的话，「DSH 找得到、我们找不到」。
  {
    const r = spawnSync(process.execPath, ['-e', `
      const path = require('path')
      const mod = require(${JSON.stringify(dpPath)})
      const out = {}
      // ① 默认：homedir/.dsh
      delete process.env.DSH_HOME
      out.fallback = mod.resolveDshHome()
      // ② 显式覆盖优先
      process.env.DSH_HOME = '/tmp/custom-dsh'
      out.custom = mod.resolveDshHome()
      // ③ 空白字符串不算覆盖（容易被误当成"设过了"）
      process.env.DSH_HOME = '   '
      out.blank = mod.resolveDshHome()
      // ④ 尾随空格要去掉
      process.env.DSH_HOME = ' /tmp/padded '
      out.padded = mod.resolveDshHome()
      console.log(JSON.stringify(out))
    `], { encoding: 'utf8', timeout: 15000 })
    let out = null
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()) } catch { /* ignore */ }
    const home = os.homedir()
    check('默认用 ~/.dsh（和 DSH 文档一致）',
      out && out.fallback === path.join(home, '.dsh'), out ? out.fallback : `退出码 ${r.status}`)
    check('$DSH_HOME 优先于 ~/.dsh', out && out.custom === '/tmp/custom-dsh', out ? out.custom : '')
    check('空白字符串**不算**设过（退回 ~/.dsh）',
      out && out.blank === path.join(home, '.dsh'), out ? JSON.stringify(out.blank) : '')
    check('$DSH_HOME 的尾随空格被去掉', out && out.padded === '/tmp/padded', out ? JSON.stringify(out.padded) : '')
  }

  // ⑨ ⚠️ **必须接「所有」profile，不是「挑一个」。**
  //
  //    DSH 有几种形态（官方桌面端 / 浏览器形态 / 从源码跑），
  //    **每种在 ~/.dsh/profiles/ 下有自己的一个 profile**：
  //    实测这台机器上就有 `desktop`（官方桌面端）和 `web`（浏览器形态）。
  //    一开始这里写的是"挑一个接" —— **那是错的**：
  //    用户两种形态都用的话，另一种下她会**毫无反应**，
  //    而且不看代码根本不知道为什么。
  check('autoInstall 遍历**所有** profile（不是只挑一个）',
    /for \(const p of profiles\)/.test(dp))
  check('返回值带 profiles 数组（说清动了哪几个）',
    /profiles: touched\.map/.test(dp))
  // 反过来说：不能有"只取第一个"的写法
  check('没有 profiles[0] 这种"只挑一个"的残留',
    !/const target = profiles\[0\]/.test(dp))
  // ⑩ 幂等：连跑两次，第二次不能改文件
  //    （不幂等的话每次启动都会改 cordis.patch.yml →
  //      触发 DSH 的 live-reload watcher → 插件一直重挂载）
  {
    const r = spawnSync(process.execPath, ['-e', `
      const fs = require('fs'), os = require('os'), path = require('path')
      const p = require(${JSON.stringify(dpPath)})
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshhome-'))
      process.env.DSH_HOME = tmpHome
      // 造两个假 profile
      for (const n of ['desktop', 'web']) {
        fs.mkdirSync(path.join(tmpHome, 'profiles', n), { recursive: true })
        fs.writeFileSync(path.join(tmpHome, 'profiles', n, 'cordis.patch.yml'), '# empty\\n')
      }
      const a = p.autoInstall()
      const files = ['desktop','web'].map((n) => fs.readFileSync(path.join(tmpHome,'profiles',n,'cordis.patch.yml'),'utf8'))
      const b = p.autoInstall()
      const files2 = ['desktop','web'].map((n) => fs.readFileSync(path.join(tmpHome,'profiles',n,'cordis.patch.yml'),'utf8'))
      console.log(JSON.stringify({
        first: a.action, firstProfiles: a.profiles,
        second: b.action,
        same: JSON.stringify(files) === JSON.stringify(files2),
        both: files.every((f) => f.includes('dsh-harness-pet managed')),
      }))
      fs.rmSync(tmpHome, { recursive: true, force: true })
    `], { encoding: 'utf8', timeout: 20000 })
    let out = null
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()) } catch { /* ignore */ }
    // ⚠️ 失败信息里**一定要带 stderr**。
    //    写这条测试时踩到：spawn 出来的脚本因为模板字符串把 `\n` 变成了真换行
    //    而语法错误、退出码 1 —— 但断言只印了"退出码 1"，
    //    于是白查了一轮。**子进程的报错必须透出来。**
    const why = `退出码 ${r.status}  stderr=${JSON.stringify((r.stderr || '').trim().split('\n').slice(0, 3).join(' / '))}`
    check('两个 profile 都接上了',
      out && out.both === true, out ? `first=${out.first} 动了 ${JSON.stringify(out.firstProfiles)}` : why)
    check('第二次跑不改文件（幂等 —— 不然会一直触发 DSH 重载）',
      out && out.second === 'already' && out.same === true,
      out ? `second=${out.second} 内容一致=${out.same}` : '')
  }
}

// ⚠️ 最后再兜一层：**check() 外面抛的异常也要说出来。**
//
//    踩到过：ESM 里误用了 `require` → `ReferenceError` 直接冒到顶层 →
//    一个 ❌ 都没打，只有退出码 1 —— 看起来像"测试挂了但不知哪挂了"。
//    （node 自己会打堆栈，但堆栈混在一大堆 ✅ 里很容易被划过去。）
process.on('uncaughtException', (e) => {
  console.log(`\n  ❌ 测试脚本自己崩了（不是被测代码的问题）：${e.message}`)
  console.log(`     ${(e.stack || '').split('\n')[1]?.trim() || ''}`)
  process.exit(1)
})

console.log('\n【1.985】设置弹窗：**点外面不关**，只能点按钮 / 按 Esc')
{
  // ⚠️ 这条是**反向断言**，专门防止有人再改回去。
  //
  // 经过：
  //   用户报「右击打开弹窗，点弹窗外不关」—— **指的是右键菜单**，
  //   我理解成了这个设置弹窗，于是给它加了 `blur → close` 和配套的草稿。
  //   用户实测反馈：**「设置弹窗点外面不要关闭，这个要点击固定按钮才能关闭」**。
  //
  // 为什么必须让它保持"点外面不关"：
  //   **这个窗口里要填 API Key。** 用户的典型动作是"切到浏览器复制 Key"，
  //   失焦就关会把刚填的全弄丢 —— 那比"关不掉"严重得多。
  //   （我当初就写下了这个风险，然后还是加了。教训。）
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const pre = fs.readFileSync(path.join(ROOT, 'src', 'settings-preload.js'), 'utf8')
  const st = fs.readFileSync(path.join(ROOT, 'src', 'settings', 'settings.js'), 'utf8')
  const code = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  // ① 设置窗口**不能**绑 blur 关闭
  const settingsFn = code.slice(code.indexOf('function openSettingsWindow'))
  const until = settingsFn.indexOf('\nfunction ')
  const body = until > 0 ? settingsFn.slice(0, until) : settingsFn
  check('设置窗口**没有**绑 blur → close',
    !/settingsWin\.on\('blur'/.test(body))
  check('设置窗口里没有 close() 挂在失焦上',
    !/blur'[\s\S]{0,300}settingsWin\.close\(\)/.test(body))

  // ② 三个"明确关闭"的入口要在 —— 关不掉也不行
  check('有保存后关闭（closeSettingsWindow）',
    /function closeSettingsWindow/.test(code) && /settings:save[\s\S]{0,400}closeSettingsWindow/.test(code))
  check('有取消按钮通道（settings:cancel）',
    /settings:cancel/.test(code) && /cancel:[\s\S]{0,80}settings:cancel/.test(pre))
  check('Esc 也能关（键盘用户）',
    /key === 'Escape'[\s\S]{0,80}cancel\(\)/.test(st))

  // ③ 配套的"草稿"机制也要一起撤掉 ——
  //    它的存在理由就是"失焦会关"，现在不关了，留着是死代码，
  //    而且会让"点了取消、重新打开旧内容又回来"，反而困惑。
  check('草稿机制已撤掉（settingsDraft）', !/settingsDraft/.test(mj))
  check('草稿 IPC 通道已撤掉（settings:draft）',
    !/settings:draft/.test(mj) && !/settings:draft/.test(pre))
  check('渲染层不再上报草稿', !/window\.settings\.draft/.test(st))
  check('preload 不再暴露 draft', !/draft:\s*\(/.test(pre))
}

console.log('\n【1.984】右键菜单：弹出期间不能是「点击穿透」')
{
  // 用户实测报的：**Windows 上右键弹出菜单后，点菜单外面菜单不关。**
  //
  // 桌宠窗口默认是"整窗穿透鼠标"的（`setIgnoreMouseEvents(true, {forward:true})`）
  // —— 这本来是为了"她挡住的桌面还能点"。但**原生菜单是从这个窗口弹出来的**：
  // 窗口既然在穿透，点菜单外面那一下就会穿透过去，
  // 菜单收不到该有的 dismiss。所以弹出期间必须临时设成可交互。
  //
  // ⚠️ 另一条路走不通，别去试：**宠物窗口是 `focusable: false`**，
  //    它永远不获得焦点 ⇒ `browser-window-blur` 兜底不会触发。
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const code = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  const popup = code.indexOf('Menu.buildFromTemplate(items).popup(')
  check('找到菜单 popup 的调用点', popup > 0)

  // ① popup 之前要 setInteractive(true)
  const before = code.slice(Math.max(0, popup - 400), popup)
  check('弹菜单前把窗口设成可交互（关掉穿透）',
    /setInteractive\(true\)/.test(before))

  // ② popup 要带 callback，而且回调里恢复穿透
  const after = code.slice(popup, popup + 500)
  check('popup 传了 callback（菜单关闭时触发）', /callback:\s*\(\)\s*=>/.test(after))
  check('callback 里恢复穿透（setInteractive(false)）',
    /callback:[\s\S]{0,400}setInteractive\(false\)/.test(after))

  // ③ ⚠️ 窗口必须还是 focusable: false ——
  //    这是需求（"绝不抢焦点"），不能为了让菜单好关就把它改成 true。
  //    勾选菜单项时抢焦点会把用户正在打字的输入框弄丢焦点。
  check('宠物窗口仍是 focusable: false（别为了菜单把它改了）',
    /focusable: false/.test(code))

  // ④ setInteractive 本身要真的调 setIgnoreMouseEvents
  check('setInteractive 调了 setIgnoreMouseEvents',
    /function setInteractive[\s\S]{0,200}setIgnoreMouseEvents/.test(code))

  // ⑤ ⚠️⚠️ **真正的原因：`focusable: false` 让窗口不可激活。**
  //
  //    第一版只改了"点击穿透" —— **没用**（用户实测反馈）。
  //    Windows 上 `focusable: false` 会给窗口带上 WS_EX_NOACTIVATE，
  //    而原生弹出菜单需要**一个能激活的宿主窗口**才能进入系统的模态菜单循环；
  //    宿主不可激活时系统不认为菜单"有主"，点外面就不知道该 dismiss 哪个。
  //
  //    所以弹菜单期间要临时 `setFocusable(true)` + `focus()`，关闭时恢复。
  check('弹菜单前临时 setFocusable(true)',
    /setInteractive\(true\)[\s\S]{0,900}setFocusable\(true\)/.test(code))
  check('setFocusable 限在 Windows（文档里 macOS 无此选项）',
    /platform === 'win32'[\s\S]{0,200}setFocusable/.test(code))
  check('菜单关闭后恢复 setFocusable(false)',
    /callback:[\s\S]{0,400}setFocusable\(false\)/.test(code))
  // ⑥ 恢复要防"窗口已经没了"
  check('恢复前检查窗口还在（isDestroyed）',
    /isDestroyed\(\)[\s\S]{0,120}setFocusable\(false\)/.test(code))
}

console.log('\n【1.983】调试项不能出现在用户拿到的包里')
{
  // 用户实测反馈：**"模拟出错的选项没有去掉"**。
  //
  // 那条是开发时验"出错常驻"用的（那条链路平时很难复现）——
  // 但对普通用户来说，"模拟一次出错"是个**看不懂、也不敢点**的东西。
  //
  // ⇒ 用 `app.isPackaged` 卡住：开发模式看得见，打出来的包里没有。
  //
  // ⚠️ 插件那边收到 `test-error` 的处理**要留着** —— 开发时还得用。
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const pj = fs.readFileSync(path.join(ROOT, 'pet-plugin', 'index.js'), 'utf8')

  check('「模拟一次出错」那一项存在', /模拟一次出错/.test(mj))
  check('它被 app.isPackaged 卡住（打包后不显示）',
    /app\.isPackaged \? \[\] : \[[\s\S]{0,600}模拟一次出错/.test(mj))
  // 插件侧的处理留着 —— 开发时还要用
  check('插件仍然支持 test-error（开发要用，别一起删了）',
    /test-error/.test(pj))

  // ⚠️ 顺手扫一遍**所有**菜单项，确认没有别的调试项漏网。
  //    判据：`label:` 后面那段字符串里出现「模拟 / 调试 / 测试 / debug」，
  //    而且那一项没有被 app.isPackaged 包住。
  {
    const lines = mj.split('\n')
    const suspects = []
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/label:\s*['"`]([^'"`]{2,})['"`]/)
      if (!m) continue
      if (!/模拟|调试|测试|debug|DEBUG/.test(m[1])) continue
      // 往前 40 行找 app.isPackaged —— 找到就算已经被卡住
      const around = lines.slice(Math.max(0, i - 40), i + 1).join('\n')
      if (/app\.isPackaged/.test(around)) continue
      suspects.push(`${i + 1}:${m[1]}`)
    }
    check('没有别的水调试项漏网（都没被 app.isPackaged 卡住的）',
      suspects.length === 0, suspects.join(' / '))
  }
}

console.log(`\n${ok ? '✅ 菜单相关检查通过' : '❌ 有问题'}`)
process.exit(ok ? 0 : 1)
