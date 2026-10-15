#!/usr/bin/env node
/**
 * test-bubble.mjs — 气泡调度器的独立测试
 *
 * 为什么不靠真机验证升级催促：
 * 桌宠的桥接**只保留一个连接**，测试驱动器一连上就会把真插件踢下线，
 * 而插件立刻重连、又推回 working，把 needsInput 顶掉。
 * 所以"保持某个状态 30 秒"在真机上做不到 —— 只能在这里测。
 *
 * 用一个几百毫秒的升级档代替 30 秒，逻辑完全一样。
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { createController } = require(path.join(__dirname, 'src', 'bubble-controller.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const shown = []
let hidden = 0

const dialogues = {
  // idle 原本没有升级档。加一个是为了验 restart：
  // 睡着/醒来时 logicalState 一直是 idle，靠 restart 重置它的升级计时器。
  idle: {
    name: 'idle', fixed: false, lines: ['空闲台词'],
    escalate: [{ afterMs: 300, lines: ['idle 升级档'] }],
  },
  needsInput: {
    name: 'needsInput',
    fixed: true,
    lines: ['需要确认'],
    escalate: [
      { afterMs: 300, lines: ['L1 催促'] },
      { afterMs: 800, lines: ['L2 不耐烦'] },
    ],
  },
  blocked: { name: 'blocked', fixed: true, lines: ['出错了'], escalate: [] },
  wave: { name: 'wave', fixed: false, lines: ['在的！'], escalate: [] },
  // 带「循环」档的状态：给"要持续很久的状态"用（工作中、睡着）。
  // 不循环的话她进入这种状态后说一句就彻底安静了，用户以为她挂了。
  working: {
    name: 'working', fixed: false, lines: ['开始干活'],
    escalate: [{ afterMs: 200, lines: ['循环台词'], repeat: true }],
  },
  // 「首次 + 间隔」：先等久一点，之后密一点。
  // 用例就是 working —— 刚开工别一直烦人（45s），拖久了就该频繁冒话（每 10s）。
  bossy: {
    name: 'bossy', fixed: false, lines: ['开始'],
    escalate: [{ afterMs: 300, everyMs: 100, lines: ['密集台词'], repeat: true }],
  },
  startle: { name: 'startle', fixed: false, lines: ['我没睡！'], escalate: [] },
}

const settings = { enabled: { idle: true, filtered: false } }

// 抽成工厂：后面验 restart 时要再建一个独立的 controller
function makeDeps () {
  return {
    dialogues,
    settings,
    getPetBounds: () => ({ x: 100, y: 500, width: 220, height: 240 }),
    getBubbleSize: () => ({ width: 300, height: 170 }),
    // 角色头顶距宠物窗口顶边。真实值是 29（宠物窗口 220×240，
    // 而图片是正方形按宽 100% 缩放，上方空出 20px，再加原画布顶部留白）。
    characterHeadOffset: () => 29,
    workArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    onShow: (p) => shown.push(p),
    onHide: () => { hidden += 1 },
    // 位置断言要读最后一次移动。⚠️ 不能写 `controller._moved` ——
    // makeDeps() 在 controller 定义之前就执行了，会 ReferenceError。
    // 用一个模块级变量接住，外面再取。
    onMove: (x, y) => { moved = { x, y } },
  }
}

let moved = null
const controller = createController(makeDeps())
controller._moved = null                      // 兼容下面已有的读法
Object.defineProperty(controller, '_moved', { get: () => moved })

let ok = true
function check (label, pass) {
  console.log(`  ${pass ? '✅' : '❌'} ${label}`)
  if (!pass) ok = false
}

console.log('【1】状态切换会弹气泡')
controller.onState('idle')
await sleep(50)
check(`弹出「${shown.at(-1)?.text}」`, shown.at(-1)?.text === '空闲台词')

console.log('\n【2】升级催促：同一状态待够时长会换话')
controller.onState('needsInput')
await sleep(50)
const first = shown.at(-1)?.text
check(`首条是「${first}」`, first === '需要确认')

await sleep(350)
const l1 = shown.at(-1)?.text
check(`300ms 后升级到「${l1}」`, l1 === 'L1 催促')

await sleep(550)
const l2 = shown.at(-1)?.text
check(`800ms 后升级到「${l2}」`, l2 === 'L2 不耐烦')

console.log('\n【3】状态一变，升级就停（不该再催上一个状态）')
controller.onState('blocked')
await sleep(50)
const beforeCount = shown.length
await sleep(900)   // 足够再触发两档 needsInput 的升级
check(`没有多余的催促（新增 ${shown.length - beforeCount} 条）`, shown.length === beforeCount)

console.log('\n【4】被关掉的状态不说话')
controller.onState('filtered')   // dialogues 里没有 → 静默
const beforeFiltered = shown.length
await sleep(100)
check('没有说话术里不存在的状态', shown.length === beforeFiltered)
check(`调用了隐藏（共 ${hidden} 次）`, hidden > 0)

console.log('\n【5】固定状态不受开关影响')
settings.enabled.needsInput = false
controller.onState('needsInput')
await sleep(50)
check('needsInput 标了 fixed，仍会说话', shown.at(-1)?.text === '需要确认')

console.log('\n【6】气泡位置')
// ⚠️ 位置公式里必须含 characterHeadOffset —— 宠物窗口里角色头顶下方
// 还有 29px 的空白（图片是正方形按宽 100% 缩放，上方空出 20px，
// 再加原画布顶部留白）。漏掉它的话气泡会离她头顶空出一大截。
//
//   窗口 y = 宠物顶边 + 头顶偏移 + 尾巴尖距底边 - 气泡窗口高
//          = 500 + 29 + 8 - 170 = 367
const expectedY = 500 + 29 + 8 - 170
check(`放在宠物上方（y=${controller._moved?.y}，期望 ${expectedY}）`,
  controller._moved?.y === expectedY)

// 单独盯住这个偏移 —— 防的正是"公式里漏掉某一项"这类错误。
// （只在算式上验，不动 controller._moved —— 清掉它会让后面的水平断言拿不到值）
check('位置公式确实用到了 characterHeadOffset',
  expectedY !== 500 + 8 - 170, `含偏移 ${expectedY}，不含则是 ${500 + 8 - 170}`)
// 水平居中：100 + 220/2 - 300/2 = 60
check(`水平居中（x=${controller._moved?.x}，期望 60）`, controller._moved?.x === 60)

console.log('\n【7】时刻：打招呼不影响状态计时')
controller.onState('needsInput')
await sleep(50)
const stateBefore = controller.getState()
const sinceBefore = controller.getStateSince()

controller.onMoment('wave')
await sleep(50)
check(`弹出「${shown.at(-1)?.text}」`, shown.at(-1)?.text === '在的！')
check('状态没被改掉', controller.getState() === stateBefore)
check('状态计时没被重置', controller.getStateSince() === sinceBefore)

console.log('\n【8】时刻有冷却，不会刷屏')
const countBefore = shown.length
controller.onMoment('wave')
controller.onMoment('wave')
await sleep(50)
check(`连续触发只算一次（新增 ${shown.length - countBefore} 条）`, shown.length === countBefore)

console.log('\n【9】关闭的状态连时刻也不说')
settings.enabled.wave = false
// 绕开冷却直接验 isEnabled
check('isEnabled(wave) = false', controller.isEnabled('wave') === false)

console.log('\n【9.5】restart：重新进入同一个状态要重置升级计时')
// 这条是回归测试。用户实测抓到的 bug：
//   logicalState 一直是 idle（睡着/醒来是 idle 内部的事，状态名没变），
//   wakeUp() 不通知气泡 → 升级计时器继续累加 →
//   **她早就被摸醒了，2 分钟后还在说「（说梦话）不要抢我的鱼」**。
{
  const c2 = createController(makeDeps())
  c2.onState('idle')
  await sleep(50)
  const t0 = c2.getStateSince()
  check('进入 idle 后 StateSince 有值', typeof t0 === 'number' && t0 > 0)

  await sleep(30)
  // 相同状态、不带 restart → 不该重置（插件可能重复推）
  c2.onState('idle')
  check('相同状态不带 restart → 不重置', c2.getStateSince() === t0)

  await sleep(30)
  // 带 restart → 必须重置
  c2.onState('idle', { restart: true })
  check('带 restart → 重置了计时', c2.getStateSince() > t0)

  // 而且升级计时器要跟着重排 —— 重置之后仍然"从 0 开始等 300ms"再升级。
  // ⚠️ 判定要看**那条特定的台词**，不能用 shown.length：
  //    另一个 controller（上面那个）也在往同一个数组里写，会污染计数。
  const before = shown.filter((x) => x.text === 'idle 升级档').length
  await sleep(400)          // 越过 300ms 那一档
  const after = shown.filter((x) => x.text === 'idle 升级档').length
  check(`重置后升级计时器重排了（升级档出现 ${after - before} 次）`, after > before)

  c2.destroy()
}

console.log('\n【9.7】循环档：持续状态要反复说话，不能说完一句就安静')
{
  const c3 = createController(makeDeps())
  const before = shown.length
  c3.onState('working')
  await sleep(50)
  const afterEnter = shown.length - before
  check(`进入时说了一句（新增 ${afterEnter} 条）`, afterEnter === 1)

  // 200ms 一档，等 700ms 应该循环说 3 次左右
  await sleep(700)
  const repeats = shown.slice(before).filter((x) => x.text === '循环台词').length
  check(`循环档反复说了（${repeats} 次）`, repeats >= 2,
    repeats >= 2 ? '' : '⚠️ 只说一次就停了 = 没有循环')
  c3.destroy()
}

console.log('\n【9.8】循环的「首次 + 间隔」：先等久一点，之后密一点')
{
  const c4 = createController(makeDeps())
  const before = shown.length
  const hits = () => shown.slice(before).filter((x) => x.text === '密集台词').length

  c4.onState('bossy')
  await sleep(220)
  check(`首次按 afterMs 等（220ms 时还没到 300ms）`, hits() === 0, `已说 ${hits()} 次`)

  await sleep(150)            // 越过 300ms
  const first = hits()
  check(`首次到点说了（${first} 次）`, first === 1)

  // 之后应该按 everyMs=100ms 重复，而不是继续按 300ms
  await sleep(450)
  const more = hits() - first
  check(`之后按 everyMs 重复（450ms 内又说了 ${more} 次）`, more >= 3,
    more >= 3 ? '' : '⚠️ 还是按首次的 300ms 在重复')
  c4.destroy()
}

console.log('\n【9.9】需要确认 / 出错：气泡常驻，时段台词到点才换')
// 回归：这两个状态**在等人**，气泡说 9 秒就消失的话用户很容易整段错过。
// 实测反馈："时间段内一直展示台词，到了下一个时间段就显示对应时段的台词"。
{
  const c5 = createController(makeDeps())
  const before = shown.length
  const last = () => shown[shown.length - 1]

  c5.onState('needsInput')
  await sleep(50)
  check('进入时说了话', shown.length > before && last().text === '需要确认')
  check('常驻：durationMs 是 0（渲染层据此不排隐藏定时器）',
    last().durationMs === 0, `durationMs=${last().durationMs}`)

  // 熬过 300ms 那一档，应该换成时段台词，而且**照样常驻**
  await sleep(400)
  check('到时段会换台词', last().text === 'L1 催促', last().text)
  check('换完之后还是常驻', last().durationMs === 0, `durationMs=${last().durationMs}`)

  // 状态一变就要立刻收起来，不能卡住
  c5.onState('idle')
  await sleep(60)
  check('状态变了就换成新台词（不会卡住）', last().text === '空闲台词', last().text)
  check('新状态不是常驻', last().durationMs > 0, `durationMs=${last().durationMs}`)
  c5.destroy()
}

console.log('\n【10】清理')
controller.destroy()
const afterDestroy = shown.length
await sleep(500)
check('destroy 后不再有催促', shown.length === afterDestroy)
check('升级催促确实发生过', shown.some((x) => x.text.startsWith('L')))

console.log('\n【新】长翻译不能超出气泡窗口（按文本长度自适应高度）')
// 用户报：翻译一段较长的英文时，气泡在 `(is…` 处被截断。
// 两层原因：
//   ① 译文被模型截断 —— 请求体里没给 max_tokens，用了服务端默认（有的只有 512）
//   ② 气泡窗口固定 364×288，body 是 overflow:hidden —— 长文本被硬裁
// 这里测的是 ②：高度必须**按文本长度算**。
{
  const bc = require('./src/bubble-controller.js')
  check('导出了 estimateHeight / fitText',
    typeof bc.estimateHeight === 'function' && typeof bc.fitText === 'function')

  const MAXH = 900
  const h = (n) => bc.estimateHeight('中'.repeat(n), '', MAXH)

  check('短文本用最小高度（不浪费屏幕）', h(10) <= 120, `10 字 → ${h(10)}px`)
  check('文本越长窗口越高', h(600) > h(300) && h(300) > h(150),
    `150→${h(150)}  300→${h(300)}  600→${h(600)}`)
  check('不会超过上限', h(5000) <= MAXH, `5000 字 → ${h(5000)}px`)
  check('同样的输入永远同样的高度（纯函数，不依赖窗口大小）',
    h(300) === h(300) && bc.estimateHeight('abc', '', 900) === bc.estimateHeight('abc', '', 900),
    '依赖渲染结果的话会形成正反馈，历史上把气泡塌缩成一字一行')

  // 装得下的字数要明显比旧的多
  const capacity = (cap) => Math.floor((cap - 46) / 20) * 22
  check(`自适应后能装 900 字以上（旧的固定 288px 只能装 ${capacity(288)} 字）`,
    capacity(MAXH) >= 900, `现在能装约 ${capacity(MAXH)} 字`)

  // 超上限时**显式截断**，而不是让窗口默默裁
  const over = bc.fitText('中'.repeat(5000), '', MAXH)
  check('超过上限时显式截断并加省略号', over.truncated && over.text.endsWith('…'),
    '默默裁掉的话用户看到半句话还不知道后面有内容')
  const under = bc.fitText('中'.repeat(50), '', MAXH)
  check('没超上限时一个字都不动', !under.truncated && under.text.length === 50)

  // 主进程侧：窗口高度得用当前值，不能再写常量
  const mj0 = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const mj = mj0
  const code = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  check('onMove 用 bubbleSize.height（不是常量 BUBBLE_H）',
    /width: BUBBLE_W, height: bubbleSize\.height/.test(code),
    '写常量的话长文本还是会被裁')
  check('有 setBubbleHeight 且会夹到上下限',
    /setBubbleHeight:/.test(code) && /Math\.max\(BUBBLE_H, Math\.min\(maxH/.test(code))
  check('bubble-controller 会调 setBubbleHeight',
    /setBubbleHeight\?\.\(/.test(fs.readFileSync(path.join(ROOT, 'src', 'bubble-controller.js'), 'utf8')))

  // ── 上限比例：用户要求提到 100%（占满工作区）──
  check('导出了 MAX_HEIGHT_RATIO', typeof bc.MAX_HEIGHT_RATIO === 'number',
    '主进程要靠它夹窗口高度，各写一份字面量迟早对不上')
  check('上限比例是 100%（用户要求"上限提高 100%"）',
    bc.MAX_HEIGHT_RATIO === 1.0, `当前 ${bc.MAX_HEIGHT_RATIO}`)
  check('主进程引用的是同一个常量，不是自己写一份',
    /bubbleController\.MAX_HEIGHT_RATIO/.test(mj0),
    '两处各写一份的话，会出现"渲染层以为装得下、主进程却夹掉了"')

  // 1080p 屏（workArea ≈ 1055px）下能装多少
  {
    const work = 1055
    const cap = Math.floor(work * bc.MAX_HEIGHT_RATIO)
    const fit = bc.fitText('中'.repeat(1200), '', cap)
    check(`上限 ${cap}px 时，1200 字的原文基本装得下（截到 ${fit.text.length} 字）`,
      fit.text.length >= 1000,
      '原文上限是 1200 字符，装不下的部分会被显式加 …')
  }

  // ── clampForBubble 不该再是瓶颈 ──
  // 用户问「气泡高度是否可以不限制」，一量才发现真正的瓶颈不在高度，
  // 而是主进程先把文本砍到了 220 字 —— 自适应完全没被用上
  // （原文 400 字 → 砍到 221 字 → 气泡只用到 266px，而上限是 1055px）。
  {
    const lim = code.match(/BUBBLE_HARD_LIMIT\s*=\s*(\d+)/)
    check('clampForBubble 的兜底上限足够宽松（≥ 5000 字）',
      Boolean(lim) && Number(lim[1]) >= 5000,
      lim ? `BUBBLE_HARD_LIMIT = ${lim[1]}` : '没有找到 —— 会不会又退回 220 那种小值')
    check('旧的 220 字瓶颈已经去掉',
      !/BUBBLE_MAX_CHARS\s*=\s*220/.test(code),
      '220 字的话，气泡高度自适应等于白做')

    // 真的量一遍：400 字的内容不该被主进程砍
    const bc2 = require(path.join(ROOT, 'src', 'bubble-controller.js'))
    const cap = Math.floor(1055 * bc2.MAX_HEIGHT_RATIO)
    const f400 = bc2.fitText('中'.repeat(400), '', cap)
    check('400 字的内容在 1080p 上能完整显示（不再被砍到 221）',
      !f400.truncated, `截断=${f400.truncated}`)
    const f1100 = bc2.fitText('中'.repeat(1100), '', cap)
    check('1100 字也能完整显示', !f1100.truncated)
    const f1500 = bc2.fitText('中'.repeat(1500), '', cap)
    check('1500 字才到屏幕上限并显式截断', f1500.truncated && f1500.text.endsWith('…'))
  }
  // ── 尾巴的几何 ──
  // ⚠️ 这一组原来查的是 `#tail { margin-top: ... }`（那时尾巴还是 #wrap 的
  //    flex 子项）。现在改成 #bubble 的子元素 + 绝对定位（left:50% / bottom），
  //    完整的检查在下面「气泡尾巴必须绝对定位在气泡底部正中」那一组。
  //    这里只留一句防止有人把定位方式改回去。
  {
    const css = fs.readFileSync(path.join(ROOT, 'src', 'bubble', 'bubble.css'), 'utf8')
    const rule = css.slice(css.indexOf('#tail {'), css.indexOf('}', css.indexOf('#tail {')))
    check('#tail 不再用 margin-top 定位（已迁到绝对定位）',
      !/margin-top/.test(rule), '见下面那组完整检查')
  }

  // ① 的修复：请求必须显式带 max_tokens
  const tj = fs.readFileSync(path.join(ROOT, 'src', 'translate.js'), 'utf8')
  check('大模型请求带 max_tokens', /max_tokens:\s*\d+/.test(tj),
    '不给的话用服务端默认，长段落会被硬截断且不报错')
}

console.log('\n【新】气泡尾巴必须绝对定位在气泡底部正中')
// 用户报「气泡变长会导致气泡尖角异常」+ 截图里尾巴偏右。
// 根因：#tail 原来是 #wrap 的 flex 子项，靠 align-items:center 居中 ——
// 而 #bubble 是**另一个** flex 子项、也靠自己居中。
// 两个"各自居中"的东西，一旦 #bubble 的 max-width:100% 生效就可能算不到一起。
// 现在改成 #bubble 的子元素 + 绝对定位，永远贴气泡底部正中。
{
  const html = fs.readFileSync(path.join(ROOT, 'src', 'bubble', 'index.html'), 'utf8')
  const css = fs.readFileSync(path.join(ROOT, 'src', 'bubble', 'bubble.css'), 'utf8')
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')

  // #tail 必须在 #bubble 里面
  const bub = html.slice(html.indexOf('<div id="bubble">'), html.indexOf('</div>', html.lastIndexOf('id="tail"')))
  check('#tail 是 #bubble 的子元素', bub.includes('id="tail"'),
    '放回 #wrap 里的话又会靠"两边各自居中"对齐，迟早对不上')

  const tailRule = code.slice(code.indexOf('#tail {'), code.indexOf('}', code.indexOf('#tail {')))
  check('#tail 用 position: absolute', /position:\s*absolute/.test(tailRule))
  check('#tail 用 left: 50% + 负 margin 居中',
    /left:\s*50%/.test(tailRule) && /margin-left:\s*-6px/.test(tailRule),
    '自身宽 12px，所以负 margin 是 -6px')
  check('#tail 不再用 margin-top 定位（那是 flex 子项时代的写法）',
    !/margin-top/.test(tailRule))
  check('#bubble 是 position: relative（绝对定位的参照）',
    /#bubble\s*\{[^}]*position:\s*relative/.test(code))

  // 竖直方向：中心要落在气泡里面，否则会露白肩膀
  const tailRule2 = code.slice(code.indexOf('#tail {'), code.indexOf('}', code.indexOf('#tail {')))
  const bm = tailRule2.match(/bottom:\s*(-?[\d.]+)px/)
  if (bm) {
    const center = Number(bm[1]) + 6        // 元素 12px 高，中心在下边上方 6px
    check('尾巴中心落在气泡里（左右顶点被盖住）', center <= -2, `中心 ${center}px`)
    check('尖角仍露在气泡外', center + 8.5 > 2, `尖角 ${(center + 8.5).toFixed(1)}px`)
  } else {
    check('#tail 有 bottom', false)
  }
}

console.log('\n【新】翻译优先级最高：状态台词不许顶掉译文')
// 用户要求：
//   「状态变更台词会刷新当前翻译，能否将翻译作为权重最高，
//     任何时候均以翻译内容为主要展示，翻译展示时间结束后
//     再根据当前状态显示对应台词」
// 翻译是用户**主动要看的**，而状态台词是背景信息 ——
// 翻到一半被「在干了 老登」顶掉，那段译文就白翻了。
{
  const bc = require(path.join(ROOT, 'src', 'bubble-controller.js'))
  const shown = []
  const dialogues = {
    idle: { lines: ['待机台词'] }, working: { lines: ['工作中台词'] },
    needsInput: { lines: ['需要确认台词'] },
  }
  const c = bc.createController({
    dialogues, settings: { enabled: {}, style: 'x' },
    getPetBounds: () => ({ x: 0, y: 0, width: 220, height: 240 }),
    characterHeadOffset: () => 29, getBubbleSize: () => ({ width: 364, height: 288 }),
    workArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    onShow: (p) => shown.push(p.text), onHide: () => shown.push('(隐藏)'), onMove: () => {},
  })
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const said = () => shown.filter((x) => x !== '(隐藏)')

  c.onState('idle'); await wait(40)
  shown.length = 0
  c.sayExternal({ text: '这是译文', durationMs: 700 })
  await wait(40)
  check('翻译能上屏', said().includes('这是译文'), JSON.stringify(said()))

  shown.length = 0
  c.onState('working')                       // 翻译期间推状态
  await wait(40)
  check('翻译展示期间，状态台词**不覆盖**译文', said().length === 0,
    said().length ? `被顶掉了：${JSON.stringify(said())}` : '译文保住了')

  shown.length = 0
  await wait(900)                            // 等翻译到点
  check('翻译结束后，**补说**当前状态的台词', said().includes('工作中台词'),
    JSON.stringify(said()))

  // ⚠️⚠️ **三条会说话的路径都要挡，一条漏了就白做。**
  //    实测漏过一次：只在 onState 里挡了，结果双击/摸头触发的「时刻」台词
  //    照样把译文顶掉（日志：`说（时刻 startle）：唔……几点了？`）。
  //    另一条容易漏的是**升级催促** —— 它不经 onState，直接调 say()。
  const paths = [
    ['状态变更 onState', () => c.onState('working')],
    ['时刻 onMoment',    () => c.onMoment('wave')],
    ['摸头时刻',         () => c.onMoment('pat')],
  ]
  for (const [name, fn] of paths) {
    c.sayExternal({ text: '【译文】', durationMs: 600 })
    await wait(30)
    shown.length = 0
    fn()
    await wait(150)
    check(`翻译期间「${name}」不说话`, said().length === 0,
      said().length ? `被顶掉了：${JSON.stringify(said())}` : '')
  }
  // 升级催促（working 的 escalate afterMs=0 会在进入时排一个）
  {
    const c2 = bc.createController({
      dialogues: { working: { lines: ['工作中'], escalate: [{ afterMs: 60, lines: ['催促'] }] } },
      settings: { enabled: {}, style: 'x' },
      getPetBounds: () => ({ x: 0, y: 0, width: 220, height: 240 }),
      characterHeadOffset: () => 29, getBubbleSize: () => ({ width: 364, height: 288 }),
      workArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      onShow: (x) => shown.push(x.text), onHide: () => {}, onMove: () => {},
    })
    // ⚠️ 锁是**每个 controller 各自一份**的 —— 必须在这一个实例上上锁。
    //    （第一版写成 c.sayExternal 却测 c2，两个不同实例，当然锁不住。）
    c2.sayExternal({ text: '【译文】', durationMs: 500 })
    await wait(30)
    shown.length = 0
    c2.onState('working')
    await wait(200)
    check('翻译期间「升级催促」也不说话', shown.length === 0,
      shown.length ? `被顶掉了：${JSON.stringify(shown)}` : '')
    c2.destroy()
  }

  // 待定气泡被撤掉时也要解锁，否则她再也不说话
  c.sayExternal({ text: '待定…', durationMs: 0 })
  await wait(30)
  c.hideExternal()
  shown.length = 0
  c.onState('idle')
  await wait(40)
  check('撤掉待定气泡后要解锁（否则之后所有台词都被压掉）',
    said().includes('待机台词'), JSON.stringify(said()))
  c.destroy()

  // 静态：三个变量必须声明在 onState 使用点之前（let 有暂时性死区）
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bubble-controller.js'), 'utf8')
  const lines = src.split('\n')
  const decl = lines.findIndex((l) => l.includes('let translateUntil'))
  const use = lines.findIndex((l) => l.includes('Date.now() < translateUntil'))
  check('translateUntil 声明在 onState 使用点之前（防暂时性死区）',
    decl >= 0 && use >= 0 && decl < use, `声明第 ${decl + 1} 行 / 使用第 ${use + 1} 行`)
}

console.log('\n【新】"举着手等你"的状态：常驻 + 催促 + 三种停止方式')
// 用户需求：「错误状态需要常驻，包括状态帧画、台词、长时间未查阅，
//            用户查看 dsh 窗口时再停止」
// 前三条 bubble-controller 本来就有；这一组测"什么时候停" —— 三种方式：
//   ① agent 恢复活动（状态一变 onState 自然换气泡）
//   ② 点一下她（acknowledge）
//   ③ 前台切到 DSH（attention.js）
{
  const bc = require(path.join(ROOT, 'src', 'bubble-controller.js'))
  const shown = []
  const dialogues = {
    blocked: { lines: ['出错了……'], escalate: [{ afterMs: 60, lines: ['卡在这儿了，你看看？'] }] },
    working: { lines: ['在跑了'] },
    idle: { lines: ['待机'] },
  }
  const mk = () => bc.createController({
    dialogues, settings: { enabled: {}, style: 'x' },
    getPetBounds: () => ({ x: 0, y: 0, width: 220, height: 240 }),
    characterHeadOffset: () => 29, getBubbleSize: () => ({ width: 364, height: 288 }),
    workArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    onShow: (p) => shown.push(p.text), onHide: () => shown.push('(隐藏)'), onMove: () => {},
  })
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const said = () => shown.filter((x) => x !== '(隐藏)')

  // ── 常驻 + 催促 ──
  const c = mk()
  shown.length = 0
  c.onState('blocked'); await wait(40)
  check('blocked 的气泡是常驻的（durationMs = 0）',
    shown.includes('出错了……') && bc.DISPLAY_MS.blocked === 0)
  shown.length = 0
  await wait(150)
  check('长时间没人理 → 升级催促', said().includes('卡在这儿了，你看看？'), JSON.stringify(said()))

  // ── 停止方式 ②：点一下她 ──
  shown.length = 0
  c.acknowledge()
  await wait(180)
  check('点一下 → 撤掉常驻气泡、之后不再催', said().length === 0,
    said().length ? `还在说：${JSON.stringify(said())}` : '')
  shown.length = 0
  c.onState('working'); await wait(40)
  check('确认之后，状态变化照样说话（确认不是"静音"）',
    said().includes('在跑了'), JSON.stringify(said()))
  // ⚠️ 断言必须看 **(隐藏) 有没有出现** —— 只看 `said()` 的话，
  //    `acknowledge()` 撤掉气泡只是 push 一个 '(隐藏)'，会被过滤掉，
  //    于是"撤了"和"没撤"看起来一模一样（反向验证时发现的）。
  check('working 时点一下**不撤**（那是"查余额"的语义）', (() => {
    const n = shown.filter((x) => x === '(隐藏)').length
    c.acknowledge()
    return shown.filter((x) => x === '(隐藏)').length === n
  })())
  c.destroy()

  // ── 停止方式 ①：agent 恢复活动 ──
  const c2 = mk()
  shown.length = 0
  c2.onState('blocked'); await wait(40)
  shown.length = 0
  c2.onState('working'); await wait(40)
  check('agent 恢复活动 → 常驻气泡自动换成新状态的台词',
    said().includes('在跑了'), JSON.stringify(said()))
  c2.destroy()
}

// ── 停止方式 ③：前台切到 DSH（attention.js）──
{
  const att = require(path.join(ROOT, 'src', 'attention.js'))
  check('attention 模块导出 createWatcher', typeof att.createWatcher === 'function')
  check('默认 App 名单里含浏览器（DSH 的 Web GUI 跑在那儿）',
    att.DEFAULT_APPS.some((a) => a.includes('safari') || a.includes('chrome')))
  check('默认名单里含终端（有人用 CLI 跑 dsh）',
    att.DEFAULT_APPS.some((a) => a.includes('terminal') || a.includes('iterm')))
  check('轮询间隔 ≥ 3 秒（osascript 一次约 250ms，不能太密）', att.POLL_MS >= 3000,
    `POLL_MS = ${att.POLL_MS}`)

  // 不在"举手"状态时**一次都不该查**
  let seen = 0
  const w = att.createWatcher({ shouldWatch: () => false, onSeen: () => { seen++ }, log: () => {} })
  await w.tick()
  check('shouldWatch 为 false 时不触发（也不该起 osascript）', seen === 0)
  w.stop()

  // main.js 侧的接线
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  check('main.js 里 shouldWatch 只认 blocked / needInput',
    /shouldWatch:[\s\S]{0,300}blocked[\s\S]{0,120}needInput/.test(mj))
  check('onSeen 走 acknowledge（和"点一下她"同一条路）',
    /onSeen:[\s\S]{0,200}acknowledge/.test(mj))
  check('attention 有 start 也有 stop（退出要停掉）',
    /attention\.start\(\)/.test(mj) && /attention\.stop\(\)/.test(mj))
}

console.log(`\n${ok ? '✅ 气泡调度器验证通过' : '❌ 有问题'}`)
process.exit(ok ? 0 : 1)
