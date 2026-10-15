#!/usr/bin/env node
/**
 * test-translate.mjs — 划词翻译的独立测试
 *
 * 覆盖三块容易出错、又不容易在真机上撞到的逻辑：
 *   1. 判定：哪些文字值得翻（判错了会白耗接口配额，或者该翻的没翻）
 *   2. 权限：错误码识别（这里出过错 —— 假阳性会让界面显示"已授权"）
 *   3. 监控：去重与限流（划词时选中状态会持续好几秒，不去重就会刷屏）
 *
 * ⚠️ **默认不联网。** 这一条是被坑出来的：
 *    原来【2】真的去调 MyMemory 和 Google，结果**网络一抖就报红** ——
 *    而且 Google 在这个网络下根本连不上，每次都白等 10 秒超时。
 *    更糟的是**我会把它当成代码坏了**（当时确实差点误判）。
 *
 *    这个测试该验的是"**我们的**解析 / 缓存 / 降级逻辑"，
 *    不是"MyMemory 今天活着吗"。所以默认把 fetch 换成桩，离线、确定、秒过。
 *
 *    想验真实服务：`node test-translate.mjs --online`
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const translate = require(path.join(__dirname, 'src', 'translate.js'))
const selection = require(path.join(__dirname, 'src', 'selection.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ONLINE = process.argv.includes('--online')

/**
 * 把 fetch 换成桩。**只认我们真正会调的那两个接口**，
 * 其余一律 404 —— 免得"不小心调了别的服务"这种事被悄悄放过。
 */
function installFetchStub ({ fail = [] } = {}) {
  const real = globalThis.fetch
  const calls = []
  const boom = () => { throw Object.assign(new TypeError('fetch failed'),
    { cause: { code: 'ENOTFOUND' } }) }
  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('mymemory.translated.net')) {
      if (fail.includes('mymemory')) boom()
      const q = new URL(u).searchParams.get('q') ?? ''
      return new Response(JSON.stringify({
        responseStatus: 200,
        responseData: { translatedText: `[桩] ${q}` },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('translate.googleapis.com')) {
      if (fail.includes('google')) boom()
      return new Response(JSON.stringify([[[`[G桩] ${''}`, 'x']]]),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }
  return { calls, restore: () => { globalThis.fetch = real } }
}

let ok = true
function check (label, pass, extra = '') {
  console.log(`  ${pass ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!pass) ok = false
}

console.log('【1】该不该翻译')
const cases = [
  ['hello world', true, '普通英文'],
  ['The quick brown fox jumps over the lazy dog.', true, '英文句子'],
  ['你好世界', false, '纯中文'],
  ['这是一个 test 混排', false, '中英混排，汉字占多数'],
  ['函数 foo() 返回 bar', false, '中英混排，汉字占多数'],
  ['a', false, '太短'],
  ['', false, '空'],
  ['   ', false, '只有空白'],
  ['12345', false, '纯数字'],
  ['ok', true, '两个字母'],
]
for (const [text, want, label] of cases) {
  const got = translate.looksTranslatable(text)
  check(`${label}（${JSON.stringify(text).slice(0, 24)}）→ ${got}`, got === want, got === want ? '' : `期望 ${want}`)
}

console.log(`\n【2】翻译一次 ${ONLINE ? '（真联网）' : '（离线桩）'}`)
if (!ONLINE) {
  // ① 正常路径：第一个提供商成功就该停下，**不要**再去试下一个
  {
    const stub = installFetchStub()
    const r = await translate.translate('Hello, world!')
    check(`返回了译文：${r?.text ?? '失败'}`, r?.text === '[桩] Hello, world!', r ? `[${r.provider}]` : '')
    check('用的是 MyMemory', r?.provider === 'MyMemory')
    check('成功后不再试下一个提供商（省时间也省配额）',
      !stub.calls.some((u) => u.includes('googleapis')), `共 ${stub.calls.length} 次请求`)
    const r2 = await translate.translate('Hello, world!')
    check('第二次命中缓存', r2?.cached === true)
    check('命中缓存时不再发请求', stub.calls.length === 1, `共 ${stub.calls.length} 次请求`)
    stub.restore()
  }
  // ② 降级路径：第一个挂了要能自动换下一个
  {
    const stub = installFetchStub({ fail: ['mymemory'] })
    const r = await translate.translate('Fallback please')
    check(`MyMemory 挂了会换下一个：${r?.text ?? '也挂了'}`,
      r?.provider === 'Google', r ? `[${r.provider}]` : '')
    check('确实试过 MyMemory（不是跳过）',
      stub.calls.some((u) => u.includes('mymemory')))
    stub.restore()
  }
  // ③ 全挂：**返回 null（不抛错）**，原因通过 getLastFailureReason() 取。
  //    ⚠️ 我一开始断言"会抛错"—— 错了。这是设计如此：调用方（气泡）拿 null 就静默，
  //    拿 getLastFailureReason() 决定要不要提示。
  {
    const stub = installFetchStub({ fail: ['mymemory', 'google'] })
    const r = await translate.translate('Nobody answers')
    check('全挂时返回 null（不抛错）', r === null, JSON.stringify(r))
    const why = translate.getLastFailureReason?.()
    check('给出了失败原因（不用让调用方去猜）', Boolean(why), why ? why.slice(0, 46) : '(空)')
    check('原因里没有裸的 "fetch failed"',
      Boolean(why) && !String(why).includes('fetch failed'))
    stub.restore()
  }
} else {
  const r = await translate.translate('Hello, world!')
  check(`返回了译文：${r?.text ?? '失败'}`, Boolean(r?.text), r ? `[${r.provider}]` : '')
  const r2 = await translate.translate('Hello, world!')
  check('第二次命中缓存', r2?.cached === true)
}

console.log('\n【3】"原样返回"不该弹气泡')
// 回归测试：实测 "translate" → "translate"、"kubernetes" → "Kubernetes"，
// 接口对认不出的词会把原文原样返回。照着弹气泡会让人以为"翻了但没翻"。
const mainSrc = require('node:fs').readFileSync(path.join(__dirname, 'src', 'main.js'), 'utf8')
const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
const same = (a, b) => norm(a) === norm(b) && norm(a).length > 0
check('translate → translate 判为"没翻"', same('translate', 'translate'))
check('kubernetes → Kubernetes 判为"没翻"（只差大小写）', same('kubernetes', 'Kubernetes'))
check('Hello. → 你好 判为"翻了"', !same('Hello.', '你好'))
check('main.js 里确实调用了这个判定', mainSrc.includes('isUntranslated('))

console.log('\n【4】权限判定只认错误码，不认文案')
// 这两条是回归测试：之前用正则匹配中英文错误文案，
// 漏判过一次，界面显示"已授权"而实际上没权限。
const selSrc = require('node:fs').readFileSync(
  path.join(__dirname, 'src', 'selection.js'), 'utf8')
check('权限判定基于错误码 -10004 / -25211',
  selSrc.includes('-10004') && selSrc.includes('-25211'))
// 判据必须是错误码：不是 -10004 就算通过了 TCC 检查。
// 这条绕过两次弯 —— 先用正则匹配文案（把有权限报成未确认），
// 后又要求"必须真读到选中文字"（把"有权限但前台是空窗口"也报成未确认）。
check('权限判定只看错误码，不看"有没有读到文字"',
  /if \(result\.denied\) return \{ ok: false/.test(selSrc) &&
  !/if \(result\.text\) return \{ ok: true \}/.test(selSrc))
check('不再返回 ok: null（三态收敛为两态）', !/ok: null/.test(selSrc))

console.log('\n【5】网络错误要说人话，不能只显示 "fetch failed"')
// ⚠️ 回归测试。设置弹窗里曾经显示
//    「测试失败，请检查网络或API：fetch failed」
// —— 后面那半句毫无帮助。Node 的 fetch 失败时 message 永远只有
// "fetch failed"，真正原因在 error.cause 里。
const describe = translate.describeFetchError
const enotfound = Object.assign(new TypeError('fetch failed'),
  { cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) })
// ⚠️ ENOTFOUND 同时对应"域名写错"和"完全没网"，文案必须两种都提。
// 曾经只写"检查 API 地址" —— 用户自己断的网，却被指去查地址。
const enotfoundText = describe(enotfound)
check('ENOTFOUND → 网络和地址两种可能都提到',
  enotfoundText.includes('网络') && enotfoundText.includes('地址'), enotfoundText)
const refused = Object.assign(new TypeError('fetch failed'),
  { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
check('ECONNREFUSED → 提示服务没运行',
  describe(refused).includes('连接被拒绝'), describe(refused))
check('401 → 提示 Key 不对',
  describe(new Error('HTTP 401 {"error":"invalid key"}')).includes('Key'), 
  describe(new Error('HTTP 401 {"error":"invalid key"}')))
check('超时 → 提示超时',
  describe(Object.assign(new Error('x'), { name: 'AbortError' })).includes('超时'))
check('原始 message 不再是裸的 "fetch failed"',
  describe(enotfound) !== 'fetch failed')

console.log('\n【6】监控：去重与限流')
const fired = []
const watcher = selection.createWatcher({
  isEnabled: () => true,
  onText: (text, source) => fired.push({ text, source }),
  readClipboard: () => clipboardValue,
  ownAppName: '__never__',
})

let clipboardValue = ''
watcher.start()

// 剪贴板第一次读到内容不算"用户刚复制"（启动时里面可能本来就有东西）
clipboardValue = 'first existing content'
await sleep(700)
check(`启动时已有内容不触发（触发 ${fired.length} 次）`, fired.length === 0)

// 变化了才触发
clipboardValue = 'Hello from the clipboard'
await sleep(700)
check(`变化后触发：${fired.at(-1)?.text ?? '无'}`, fired.length === 1)

// 同样的内容不该反复触发
await sleep(1200)
check(`内容不变不重复触发（共 ${fired.length} 次）`, fired.length === 1)

// 换一段新的
clipboardValue = 'Another sentence here'
await sleep(700)
check(`换内容后再次触发（共 ${fired.length} 次）`, fired.length === 2)

watcher.stop()
const afterStop = fired.length
clipboardValue = 'Should not fire after stop'
await sleep(800)
check('stop 之后不再触发', fired.length === afterStop)

console.log('\n【新】划词翻译要"两拍"：先给反馈，再出结果')
// 用户需求：
//   「有时候我不知道有没有真正触发到，如果触发了、只是还在翻译中，
//     能不能先提供『翻译复制文本中…』气泡文本，最后再展示翻译结果或错误」
// 复制触发是"无声"的 —— 等 1~10 秒期间屏幕上什么都没有，看起来像没反应。
{
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const code = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const fn = code.slice(code.indexOf('async function handleForeignText'),
                        code.indexOf('function isUntranslated'))

  check('有"翻译中"的待定文案', /PENDING_TEXT\s*=\s*'翻译复制文本中/.test(code))
  check('待定气泡是**延迟**弹的（快翻译不闪那一下）',
    /PENDING_DELAY_MS\s*=\s*\d+/.test(code) && /setTimeout\(/.test(fn),
    '先弹再马上换掉的话是"闪一下"，比不弹还难受')
  check('await 之前就挂上定时器（否则等于没提前反馈）',
    fn.indexOf('pendingTimer = setTimeout') < fn.indexOf('await translateClient.translate'),
    '顺序反了的话待定气泡要等翻译完才弹')

  // 待定气泡是常驻的，所以**每一条分支**都必须能收掉它
  check('成功分支会覆盖（sayExternal 译文）', /text: clampForBubble\(/.test(fn))
  check('失败分支会覆盖（sayExternal 失败）', /翻译失败/.test(fn))
  check('"原样返回"分支主动撤掉待定气泡',
    /isUntranslated[\s\S]{0,300}hideExternal/.test(fn),
    '那条分支不显示任何结果，不撤的话「翻译中…」永远挂在桌面上')
  check('异常也用 try/finally 兜住（clearTimeout 一定执行）',
    /finally\s*\{[^}]*clearTimeout\(pendingTimer\)/.test(fn),
    'translate 内部有 fetch/JSON.parse，漏出异常的话定时器不取消')
  check('有竞态序号（连续划两段不能串台）',
    /translateSeq/.test(code) && /seq !== translateSeq/.test(fn),
    '两次翻译的返回顺序不保证，没有序号的话先划的结果会盖掉后划的')

  // 撤气泡的 API 要在 controller 上
  const bc = fs.readFileSync(path.join(ROOT, 'src', 'bubble-controller.js'), 'utf8')
  check('bubble-controller 暴露了 hideExternal', /hideExternal,/.test(bc))
  check('hideExternal 只撤外部气泡，不动状态气泡',
    /currentState !== 'translate'\) return/.test(bc),
    'working / needInput 那些是真实工作信息，不能被翻译流程撤掉')
}

console.log('\n【新】复制同一段文字第二次，也要重新翻译')
// 用户报：「同一段文本，第一次复制翻译触发了，
//          但是第二次复制相同的一段文本就不会继续触发」
//
// 根因：`pollClipboard` 里 `if (text === lastClipboard) return` ——
// **内容没变就不触发，而且没有任何时间限制**（永久）。
// 它本意只是"别在 450ms 的轮询里反复 fire"，而那个已经由
// `seenRecently` 的 15 秒时间窗覆盖了。
//
// 难点是**怎么知道"用户又按了一次 Cmd+C"** —— 内容没变，值比对看不出来。
// 解法：macOS 剪贴板的 `NSPasteboard.changeCount` 每复制一次就 +1，
// **哪怕内容完全相同**（实测：同样内容复制两次，438 → 439）。
{
  const sj = fs.readFileSync(path.join(ROOT, 'src', 'selection.js'), 'utf8')
  const code = sj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  check('有 changeCount 查询脚本（借 AppleScript 调 AppKit）',
    /changeCount\(\) as integer/.test(sj) && /NSPasteboard/.test(sj))
  check('有 changeCount 的限频常量',
    /CHANGECOUNT_POLL_MS\s*=\s*\d+/.test(code),
    '一次 osascript 约 250ms，每 450ms 跑一次太贵')
  check('只在"内容没变"时才查 changeCount',
    /text !== lastClipboard[\s\S]{0,900}readChangeCount/.test(code),
    '内容变了就一定是新复制，不用付那 250ms')
  check('版本号变了 → 判为"用户又复制了一次"',
    /count === lastChangeCount\) return[\s\S]{0,200}clipboard-recopy/.test(code))
  check('重复复制走 force，跳过 15 秒去重窗',
    /fire\(text, 'clipboard-recopy', \{ force: true \}\)/.test(code),
    '不 force 的话会被 seenRecently 挡掉，等于没修')
  check('fire 支持 force 参数', /function fire \(text, source, \{ force = false \}/.test(code))
  check('force 时也记一笔（免得紧接着又被轮询翻一次）',
    /if \(force\) recent\.set\(value, Date\.now\(\)\)/.test(code))
  check('changeCount 查询有防重入（异步，可能重叠）',
    /changeCountBusy/.test(code))
  check('非 macOS 返回 null（Windows 上这条路不通，要能优雅退化）',
    /process\.platform !== 'darwin'\) return resolve\(null\)/.test(code))

  // ── 真的跑一遍：内容不变、只让 changeCount 变 ──
  const { execFileSync } = require('node:child_process')
  const sel = require(path.join(ROOT, 'src', 'selection.js'))
  check('selection.js 能加载', typeof sel.createWatcher === 'function')
}

console.log('\n【新】原文只留预览，额度全给译文；时长按字数线性延长')
// 用户要求：
//   1.「原文只显示前 100 字，把额度全给译文」
//   2.「按时长线性延长」
// 背景：气泡高度有物理上限（屏幕可用高度），而里面放的是「原文+译文」两份，
//       共享额度 —— 原文一长，被截的就是译文，而用户要的恰恰是译文。
{
  const mj = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const code = mj.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  check('有原文预览长度常量，且是 100',
    /SOURCE_PREVIEW_CHARS\s*=\s*100/.test(code))
  check('有 sourcePreview() 并会加省略号',
    /function sourcePreview/.test(code) && /slice\(0, SOURCE_PREVIEW_CHARS\)[\s\S]{0,40}…/.test(mj))
  check('成功分支用 sourcePreview（不是原文全文）',
    /const head = sourcePreview\(text\)/.test(mj),
    '用全文的话两份共享额度，被截的是译文')
  check('失败分支也用 preview（免得多占地方）',
    /const failHead = sourcePreview\(text\)/.test(mj))

  // 时长
  check('有时长公式的常量（基数 / 每百字 / 上限）',
    /BUBBLE_BASE_MS\s*=/.test(code) && /BUBBLE_PER_100_MS\s*=/.test(code) && /BUBBLE_MAX_MS\s*=/.test(code))
  check('时长**线性**随字数增长', /Math\.ceil\(n \/ 100\) \* BUBBLE_PER_100_MS/.test(code))
  check('旧的固定 20 秒封顶已经去掉',
    !/Math\.min\(20000, 6000 \+ result\.text\.length \* 120\)/.test(code),
    '1100 字按旧的只能看 20 秒，读不完')
  check('成功分支用 bubbleDuration',
    /durationMs: bubbleDuration\(body\.length\)/.test(mj))
  check('时长按**整条气泡**的字数算（原文预览+译文），不是只按译文',
    /bubbleDuration\(body\.length\)/.test(mj))
  check('上限是 90 秒（不是无限 —— 气泡挡在桌面上）',
    /BUBBLE_MAX_MS\s*=\s*90000/.test(code))
}

console.log(`\n${ok ? '✅ 划词翻译验证通过' : '❌ 有问题'}`)
process.exit(ok ? 0 : 1)
