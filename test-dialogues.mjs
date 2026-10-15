/**
 * test-dialogues.mjs — 话术双层查找的测试
 *
 * 为什么要它：话术是**用户会去改的东西**，而"用户改坏了"这件事
 * 必须有确定的降级行为 —— 不能让他改错一个格式就整个气泡不说话。
 *
 * 这里踩过的坑：`parse()` 对格式不对的内容**不抛异常**，只返回空对象，
 * 所以最初只靠 try/catch 是抓不到"改坏了"的。**是这套测试抓出来的。**
 *
 * 跑：node test-dialogues.mjs
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.dirname(fileURLToPath(import.meta.url))
const dialogues = require(path.join(ROOT, 'src', 'dialogues.js'))

let pass = 0
let fail = 0
function check (name, ok, extra = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`)
  ok ? pass++ : fail++
}

// 临时 userData —— 不要碰真实的那份
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-dlg-'))

try {
  // ① 没有用户副本 → 用内置
  let t = dialogues.load('zh', tmp)
  check('没有用户副本时用内置', Object.keys(t).length > 0, `${Object.keys(t).length} 个状态`)

  // ② 建副本
  const r = dialogues.ensureUserCopy('zh', tmp)
  check('ensureUserCopy 能建出副本', r.created && fs.existsSync(r.path))
  check('副本路径在 userData 下', r.path.startsWith(tmp))

  // ③ 改副本 → 用户那份生效
  fs.writeFileSync(r.path, '## idle\n- 用户自己写的台词\n')
  t = dialogues.load('zh', tmp)
  check('改了副本之后用用户那份', t.idle?.lines?.[0] === '用户自己写的台词',
    JSON.stringify(t.idle?.lines))

  // ④ 再 ensureUserCopy 不能覆盖用户内容
  dialogues.ensureUserCopy('zh', tmp)
  check('再次 ensure 不覆盖用户内容',
    fs.readFileSync(r.path, 'utf8').includes('用户自己写的'))

  // ⑤ 用户把文件改坏 → 必须退回内置，而不是整个不说话
  //    （这是最初漏掉的那条：parse 不抛异常，只返回空对象）
  fs.writeFileSync(r.path, '这是一坨完全不符合格式的乱码 {{{')
  t = dialogues.load('zh', tmp)
  check('改坏后退回内置（不能整个瘫掉）', Object.keys(t).length > 0, `${Object.keys(t).length} 个状态`)

  // ⑥ 空文件同理
  fs.writeFileSync(r.path, '')
  t = dialogues.load('zh', tmp)
  check('空文件也退回内置', Object.keys(t).length > 0)

  // ⑦ 删掉副本 → 回到内置
  fs.unlinkSync(r.path)
  t = dialogues.load('zh', tmp)
  check('删掉副本后回到内置', Object.keys(t).length > 0)

  // ⑧ 内置那份本身要能解析出内容（防止有人改坏了内置）
  const builtin = dialogues.load('zh', path.join(tmp, 'nonexistent'))
  check('内置话术本身有效', Object.keys(builtin).length > 0, `${Object.keys(builtin).length} 个状态`)

  // ⑨ [fixed] 标记的状态必须存在 —— 需求 4 说它们不可关闭
  const fixed = Object.entries(builtin).filter(([, s]) => s.fixed).map(([k]) => k)
  check('有 [fixed] 状态（需求 4 的"固定开启"）', fixed.length > 0, fixed.join(', '))

  // ⑩ 标题后面跟中文注释也要能解析。
  //    ⚠️ 这条是**回归测试**：原来的正则结尾有个 `$`，
  //    `## idle 空闲` 整行匹配不上 —— 结果是**静默地一个状态都不解析**，
  //    用户只看到"气泡不会说话"，完全不知道是自己加了个注释。
  const variants = [
    ['## idle', 'idle', false],
    ['## idle [fixed]', 'idle', true],
    ['## idle 空闲', 'idle', false],
    ['## idle 空闲 [fixed]', 'idle', true],
    ['## idle [fixed] 空闲', 'idle', true],
  ]
  let allOk = true
  for (const [header, wantKey, wantFixed] of variants) {
    const t2 = dialogues.parse(`${header}\n- 测试\n`)
    const keys = Object.keys(t2)
    if (keys[0] !== wantKey || Boolean(t2[wantKey]?.fixed) !== wantFixed) {
      allOk = false
      console.log(`      ↳ ${JSON.stringify(header)} → ${JSON.stringify(keys)} fixed=${t2[wantKey]?.fixed}`)
    }
  }
  check('标题可带中文注释（且 [fixed] 位置随意）', allOk)

  // ⑪ 中文注释不该被当成状态名
  check('中文标题不会被误认成状态',
    Object.keys(dialogues.parse('## 格式\n\n正文\n')).length === 0)

  // ⑫ 用户副本"缺状态"时要提示出来
  //    「升级不覆盖用户内容」的另一面：内置加了新状态，用户不会知道。
  {
    const r2 = dialogues.ensureUserCopy('zh', tmp)
    // 造一份"缺了 working 和 ready"的旧副本
    fs.writeFileSync(r2.path, '## idle\n- 只有这一个状态\n')
    const logs = []
    const origWarn = console.warn
    console.warn = (...a) => { logs.push(a.join(' ')); origWarn(...a) }
    dialogues.load('zh', tmp)
    console.warn = origWarn
    const warned = logs.some((l) => l.includes('没有的状态') && l.includes('working'))
    check('用户副本缺状态时会警告', warned)
    fs.unlinkSync(r2.path)
  }

  // ⑬ 不认识的 `##` 标题不能把后面的台词串到上一个状态里。
  //    ⚠️ 回归测试：原来这里只清 `level` 不清 `state`，于是
  //    「## 我瞎编的状态」下面的台词会跑进**上一个状态**的台词表 ——
  //    用户完全看不出问题，只是 idle 多了一句莫名其妙的话。
  {
    const t3 = dialogues.parse([
      '## idle',
      '- 原有的一句',
      '',
      '## 我瞎编的状态',       // 中文开头，不会被认成状态
      '- 这句不该跑进 idle',
      '',
      '## working',
      '- 工作的话',
      '',
    ].join('\n'))
    const ok = t3.idle?.lines?.length === 1 &&
               t3.working?.lines?.length === 1 &&
               !Object.values(t3).some((v) => v.lines.includes('这句不该跑进 idle'))
    check('不认识的 ## 标题会结束当前块（台词不串段）', ok,
      `idle ${t3.idle?.lines?.length} 句 / working ${t3.working?.lines?.length} 句`)
  }

  // ⑭ 加了不会被触发的状态名时要警告 —— 否则用户写了台词却发现永远不说
  {
    const logs = []
    const origWarn = console.warn
    console.warn = (...a) => { logs.push(a.join(' ')); origWarn(...a) }
    dialogues.parse('## idle\n- 正常\n\n## myCustomState\n- 永远不会说的话\n')
    console.warn = origWarn
    check('未知状态名会警告', logs.some((l) => l.includes('不会被触发') && l.includes('myCustomState')))
  }

  // ⑯ 序号：解析、剥离、每档独立、重复顺延
  //    模型是「纯覆盖 + 备份」，序号**不再用于跨文件合并** ——
  //    它只用来给用户自己看清楚哪句是哪句，以及说"改 #3 那句"。
  {
    // 前端只看到纯文本
    const tp = dialogues.parse('## idle\n- #7 台词里有个井号 # 也没事\n')
    check('序号会被剥掉，前端看到纯文本',
      tp.idle.lines[0] === '台词里有个井号 # 也没事', tp.idle.lines[0])
    check('剥掉之后序号记在 lineIds 里', tp.idle.lineIds[0] === 7)

    // 不写号会自动补
    const ta = dialogues.parse('## idle\n- 第一句\n- 第二句\n')
    check('没写号会自动补', JSON.stringify(ta.idle.lineIds) === '[1,2]',
      JSON.stringify(ta.idle.lineIds))

    // 每档独立
    const tl = dialogues.parse('## x\n- #1 主一\n### 升级 10s\n- #1 档一\n')
    check('每档内独立编号（都从 #1 开始）',
      tl.x.lineIds[0] === 1 && tl.x.escalate[0].lineIds[0] === 1)

    // ⚠️ 回归：写重了要自动顺延，而且**不能连锁挪号**。
    //    第一版用 `id + 1`，结果手滑那个挪到 #3 时把本来没写重的 #3 挤到 #4 ——
    //    一句写错、后面全变。改成从**全块最大号 +1** 往后发。
    const td = dialogues.parse('## idle\n- #1 一\n- #2 二\n- #2 手滑\n- #3 三\n')
    check('重复号只挪那一个，不连锁',
      JSON.stringify(td.idle.lineIds) === '[1,2,4,3]',
      JSON.stringify(td.idle.lineIds))
    check('重复时原来的号都还在',
      td.idle.lines.length === 4 && new Set(td.idle.lineIds).size === 4)

    // 代码块里的示例不能当台词
    const tf = dialogues.parse('```\n## fake\n- #1 假的\n```\n\n## real\n- #1 真的\n')
    check('代码块里的示例不会被解析', !tf.fake && tf.real?.lines?.[0] === '真的')
  }

  // ⑯b 「纯覆盖 + 备份」模型
  {
    const dir2 = path.join(tmp, 'overwrite')
    const file = () => path.join(dir2, 'dialogues', 'zh.md')
    const read = () => fs.readFileSync(file(), 'utf8')

    const r1 = dialogues.ensureUserCopy('zh', dir2)
    check('首次会建出副本', r1.created === true && fs.existsSync(file()))
    check('副本头部记了版本号', /builtin-version:\s*\S/.test(read()))
    check('副本内容就是内置那份',
      dialogues.stripMark(read()) === fs.readFileSync(path.join(ROOT, 'dialogues', 'zh.md'), 'utf8'))

    // 用户改了 → App 不许动它
    fs.appendFileSync(file(), '\n## idle\n- #99 我自己加的\n')
    const mine = read()
    dialogues.ensureUserCopy('zh', dir2)
    check('用户改过之后，同版本不会被动', read() === mine)
    check('用户加的台词还在', dialogues.parse(read()).idle.lines.includes('我自己加的'))

    // 模拟版本升级：改掉文件头记的版本号
    fs.writeFileSync(file(), read().replace(/builtin-version: \S+/, 'builtin-version: 0.0.0'))
    const before = fs.readdirSync(path.join(dir2, 'dialogues'))
    const r2 = dialogues.ensureUserCopy('zh', dir2)
    const after = fs.readdirSync(path.join(dir2, 'dialogues'))
    const baks = after.filter((f) => /\.bak$/.test(f))

    check('版本变了会覆盖成新内置',
      dialogues.stripMark(read()) === fs.readFileSync(path.join(ROOT, 'dialogues', 'zh.md'), 'utf8'))
    check('覆盖前留了备份', baks.length === 1, baks.join(', '))
    check('备份文件名带时间戳', /\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.bak$/.test(baks[0] ?? ''), baks[0])
    // ⚠️ 回归：时间戳要用**本地时间**。
    //    第一版用的 `toISOString()`（UTC），实测文件时间 19:08 而备份名是 11-08，
    //    差 8 小时 —— 用户按文件名找备份会对不上号。
    {
      const now = new Date()
      const want = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      check('时间戳是本地时间（不是 UTC）', (baks[0] ?? '').includes(want),
        `备份 ${baks[0]} / 本地年月 ${want}`)
    }
    check('备份里是用户改过的那份',
      fs.readFileSync(path.join(dir2, 'dialogues', baks[0]), 'utf8').includes('我自己加的'))
    const notice = dialogues.takeUpdateNotice()
    // ⚠️ **不要写死版本号。** 第一版这里断言 `to === '0.1.0'`，
    //    结果 package.json 一升到 0.2.0 测试就红 —— 而代码完全没问题。
    //    版本是随时会变的数据，测试该比的是"它等于当前 package.json 的版本"。
    const pkgVersion = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
    check('给出了升级提示（主进程据此弹窗）', notice && notice.to === pkgVersion,
      notice ? `${notice.from} → ${notice.to}（当前 ${pkgVersion}）` : '(无)')
    check('提示里的备份路径是真的', notice && fs.existsSync(notice.backup))
    check('提示取过一次就清掉（不重复弹）', dialogues.takeUpdateNotice() === null)
    void before
  }

  // ⑰ 中文名映射表要和话术里的状态一一对应
  //    **漏一个，界面上就会直接显示英文 key** —— 用户看到 `patAngry` 不知道那是什么。
  //    实测就是这个原因加的：菜单是中文，但**日志和预览页全是英文**，
  //    因为映射只写在了 main.js 里，渲染层根本拿不到。
  {
    const { STATE_LABELS } = require(path.join(ROOT, 'src', 'state-labels.js'))
    const missing = Object.keys(builtin).filter((k) => !STATE_LABELS[k])
    check('每个状态都有中文名', missing.length === 0,
      missing.length ? `缺: ${missing.join(', ')}` : `${Object.keys(builtin).length} 个都有`)

    const extra = Object.keys(STATE_LABELS).filter((k) => !(k in builtin))
    check('映射表里没有多余的状态名', extra.length === 0, extra.join(', '))

    // 三个显示点都必须用同一份，不能再各写各的
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
    const bubbleSrc = fs.readFileSync(path.join(ROOT, 'src', 'bubble-controller.js'), 'utf8')
    const petSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
    check('main.js 用的是共享表', mainSrc.includes("require('./state-labels')"))
    check('bubble-controller 用的是共享表', bubbleSrc.includes("require('./state-labels')"))
    check('pet.js 读的是全局表', petSrc.includes('STATE_LABELS'))
    // ⚠️ **必须真的按浏览器方式加载一次。**
    //    原来这里只查了"文件里有没有出现 STATE_LABELS 这个词" —— 太弱，
    //    完全没抓到命名撞车（全局叫 STATE_LABELS，赋给它的对象也是
    //    `{STATE_LABELS, labelWithKey}` → 页面上查 working 永远 undefined）。
    //    表现是：页面上"有表"，但状态名照样显示英文。
    {
      const vm = await import('node:vm')
      const src = fs.readFileSync(path.join(ROOT, 'src', 'state-labels.js'), 'utf8')
      const sandbox = {}
      sandbox.globalThis = sandbox          // 浏览器里没有 module，只有 globalThis
      vm.createContext(sandbox)
      vm.runInContext(src, sandbox)
      check('浏览器侧：全局表是映射表本身（不是包了一层的对象）',
        sandbox.STATE_LABELS?.working === '工作中',
        `working → ${JSON.stringify(sandbox.STATE_LABELS?.working)}`)
      check('浏览器侧：状态数量对得上',
        Object.keys(sandbox.STATE_LABELS ?? {}).length === Object.keys(STATE_LABELS).length)
      check('浏览器侧：stateLabelOf 中文(英文) 写法可用',
        sandbox.stateLabelOf?.('patAngry') === '被惹毛(patAngry)',
        sandbox.stateLabelOf?.('patAngry'))
    }

    for (const [name, f] of [['index.html', 'src/renderer/index.html'],
                             ['preview.html', 'src/renderer/preview.html']]) {
      const h = fs.readFileSync(path.join(ROOT, f), 'utf8')
      check(`${name} 引入了 state-labels.js`, h.includes('state-labels.js'))
    }
  }

  // ⑱ 每个状态都应该有中文注释（提醒：加了新状态别忘了写）
  const noNote = Object.entries(builtin).filter(([, s]) => !s.note).map(([k]) => k)
  check('内置状态都带中文说明', noNote.length === 0,
    noNote.length ? `缺: ${noNote.join(', ')}` : `${Object.keys(builtin).length} 个都有`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log()

// ── 常用状态必须有「循环」台词 ──────────────────────────────────────────
//
// 踩过的坑：`idle` **只有升级（40s 起）、没有循环** ——
// 于是她进入空闲后说一句，然后**一直静默到 40 秒**才「开始困倦」。
// 用户看到的就是"待机没有循环台词"。
//
// `working` / `sleep` 是"要持续很久"的状态，同理。
{
  const md = fs.readFileSync(path.join(ROOT, 'dialogues', 'zh.md'), 'utf8')
  const st = dialogues.parse(md)
  for (const name of ['idle', 'working', 'sleep']) {
    const lv = (st[name]?.escalate ?? []).find((x) => x.repeat)
    check(`${name} 有 ### 循环 台词`, Boolean(lv),
      lv ? `每 ${lv.everyMs / 1000}s` : '没有循环 → 说一句之后就彻底安静了')
    if (lv) check(`${name} 的循环里有台词`, lv.lines.length > 0, `${lv.lines.length} 句`)
  }
}

if (fail) {
  console.log(`❌ ${fail} 项失败（通过 ${pass}）`)
  process.exit(1)
}
console.log(`✅ 话术测试全过（${pass} 项）`)
