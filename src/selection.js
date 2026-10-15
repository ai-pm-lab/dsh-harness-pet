/**
 * selection.js — 取用户选中的文字
 *
 * ⚠️ **目前只用剪贴板监听这一条路。**
 *
 * ── 划词监听（AXSelectedText）为什么停用 ──
 *
 * 本来想做"选中就自动翻译"。权限也拿到了（系统设置里给 Electron.app 打了勾），
 * 但实测在 Safari 上读不到 —— 把焦点元素和整条祖先链都打出来看过：
 *
 *     app=Safari
 *       AXWebArea     AXSelectedText=无      ← 连它都没有
 *       AXScrollArea  AXSelectedText=无
 *       AXGroup       AXSelectedText=无
 *       AXWindow      AXSelectedText=无
 *       AXApplication AXSelectedText=无
 *
 * 连本该带选中文字的 AXWebArea 都不暴露这个属性。
 * 也就是说这条路对**主流场景**走不通，不是我们代码的问题。
 *
 * 代码留着（readSelection / checkPermission），哪天要再试可以直接用。
 * 真要"选中即翻"，可靠的替代是模拟 Cmd+C —— 但那会动用户的剪贴板，
 * 而且必须选一个触发时机（全局快捷键，或者轮询，后者会乱触发），
 * 所以没有贸然加。
 *
 * ── 现在用的 ──
 *
 * 剪贴板监听：**零权限、立刻可用、所有 App 都一样**。代价是按一下 Cmd+C。
 */

'use strict'

const { execFile, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * 读前台 App 的选中文字。
 *
 * 拆成两条 return：第一行是 App 名字（用来跳过我们自己），
 * 第二行起是内容。用换行分隔而不是自定义分隔符 —— 选中文字里
 * 什么字符都可能有，只有换行是 AppleScript 能可靠拼出来的。
 */
const APPLESCRIPT = `tell application "System Events"
	set frontApp to first application process whose frontmost is true
	set appName to name of frontApp
	try
		set el to value of attribute "AXFocusedUIElement" of frontApp
		-- 沿着父链往上找，直到找到一个**带 AXSelectedText 属性**的元素。
		--
		-- 为什么不能只看焦点元素本身：Safari 这类把网页内容放在独立进程里的
		-- App，AXFocusedUIElement 返回的那个元素身上没有 AXSelectedText，
		-- 直接读会报"不能获得 attribute"。往上一层往往就是网页区域，
		-- 它才是真正带选中文字的那个。
		repeat 6 times
			if el is missing value then exit repeat
			try
				set sel to value of attribute "AXSelectedText" of el
				if sel is not missing value then
					if (length of sel) > 0 then return appName & linefeed & sel
				end if
			end try
			try
				set el to value of attribute "AXParent" of el
			on error
				exit repeat
			end try
		end repeat
		return appName & linefeed & "<<NONE>>"
	on error errMsg number errNum
		return appName & linefeed & "<<ERROR>>" & errNum & "|" & errMsg
	end try
end tell
`

/** 轮询间隔。划词要 spawn 一个 osascript，别太频繁。 */
const POLL_MS = 900
/** 剪贴板读取几乎零成本，可以快一点 */
const CLIPBOARD_POLL_MS = 450
/** 同一个词刚翻过就不再翻（划词时选中状态会持续好几秒） */
const REPEAT_GUARD_MS = 15000

/**
 * macOS 剪贴板「版本号」的查询脚本。
 *
 * ⚠️ **为什么需要它**：用户复制**同一段文字**第二次时，剪贴板**内容不变** ——
 *    只比对内容的话检测不出"他又按了一次 Cmd+C"，表现就是
 *    「复制了没反应」（用户报过）。
 *    `NSPasteboard.changeCount` 每复制一次就 +1，**哪怕内容完全相同** ——
 *    这是唯一可靠的判据。（实测：同样内容复制两次，438 → 439。）
 *
 * Node 的 `clipboard` 模块不暴露它，所以借 AppleScript 调 AppKit。
 * ⚠️ 代价是**一次 250ms** 左右（要起一个 osascript 进程）——
 *    所以只在"内容没变"时才查，而且限频（见 CHANGECOUNT_POLL_MS）。
 */
const CHANGECOUNT_SCRIPT = `use framework "AppKit"
set pb to current application's NSPasteboard's generalPasteboard()
return pb's changeCount() as integer`

/** 查 changeCount 的最小间隔。250ms 一次太贵，2 秒足够跟手。 */
const CHANGECOUNT_POLL_MS = 2000

/**
 * 这算不算"没有辅助功能权限"。
 *
 * ⚠️ 只认**错误码**，不要靠匹配错误文案。
 * 之前用正则匹配中英文文案，结果漏判了一次 ——
 * 错误信息没匹配上，于是 denied=false，界面显示"已授权"，
 * 而实际上是没权限。这种假阳性比不显示更糟：用户会以为功能是好的。
 *
 *   -10004  权限违例（macOS 的通用 TCC 拒绝）
 *   -25211  not allowed assistive access
 */
function isPermissionError (code, message) {
  if (code === -10004 || code === -25211) return true
  // 兜底：拿不到错误码时（比如 stderr 文本路径）才退化成匹配文案
  return /not allowed assistive access|assistive access|10004|25211/i.test(String(message ?? ''))
}

/**
 * AppleScript 的「空值」被拼进字符串后会变成字面量，必须挡掉。
 *
 * 踩过的坑：AXSelectedText 读不到时返回 missing value，
 * 拼出来就是字符串 "missing value"，于是被当成英文送去翻译，
 * 气泡里显示「缺少值」。
 */
function isMissingValue (text) {
  const t = String(text ?? '').trim()
  return t === '' || t === 'missing value' || t === '<<NONE>>'
}

/** 编译好的 .scpt 路径，避免每次轮询都重新解析脚本 */
let compiledScript = null

function ensureCompiled () {
  if (compiledScript && fs.existsSync(compiledScript)) return compiledScript
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-sel-'))
    const src = path.join(dir, 'sel.applescript')
    const out = path.join(dir, 'sel.scpt')
    fs.writeFileSync(src, APPLESCRIPT)
    // ⚠️ 必须**同步**编译完再用。
    // 异步的话下一次轮询就会去跑一个还没生成的 .scpt，静默失败。
    execFileSync('osacompile', ['-o', out, src], { stdio: 'pipe' })
    compiledScript = out
    return out
  } catch {
    return null
  }
}

/** 跑一次 osascript，拿回前台 App 名和选中文字 */
function readSelection () {
  return new Promise((resolve) => {
    const script = ensureCompiled()
    if (!script) return resolve(null)

    execFile('osascript', [script], { timeout: 4000 }, (error, stdout, stderr) => {
      // ⚠️ 权限错误走的是 **stderr** 而且退出码非 0，
      // 所以不能简单地"有 error 就当作没读到" —— 那样会把
      // "没授权"和"这次没选中文字"混为一谈，用户永远看不到提示。
      const errText = `${stderr ?? ''}`
      if (error && isPermissionError(NaN, errText)) {
        return resolve({ app: '', text: '', denied: true, error: errText.trim(), code: -10004 })
      }
      if (error) {
        // 超时 / 被杀 / 前台 App 不响应 AX，都当作"这次没读到"
        return resolve({ app: '', text: '', denied: false, error: error.message })
      }

      const nl = stdout.indexOf('\n')
      if (nl < 0) return resolve({ app: stdout.trim(), text: '', denied: false })
      const app = stdout.slice(0, nl).trim()
      const text = stdout.slice(nl + 1).replace(/\n$/, '')
      // 脚本明确说"这一圈没找到选中文字"
      if (text === '<<NONE>>') return resolve({ app, text: '', denied: false })

      // ⚠️ AppleScript 的 missing value 被拼进字符串后会变成字面量
      // "missing value"。曾经因为这个把 "missing value" 当成待翻译的英文
      // 发了出去，气泡里显示"缺少值"。这类值必须挡在这里。
      if (isMissingValue(text)) return resolve({ app, text: '', denied: false })

      if (text.startsWith('<<ERROR>>')) {
        const body = text.slice('<<ERROR>>'.length)
        const bar = body.indexOf('|')
        const code = bar >= 0 ? Number(body.slice(0, bar)) : NaN
        const msg = bar >= 0 ? body.slice(bar + 1) : body
        return resolve({ app, text: '', denied: isPermissionError(code, msg), error: msg, code })
      }
      resolve({ app, text, denied: false })
    })
  })
}

/**
 * 检查辅助功能权限。
 *
 * 单独探一次，好在设置菜单里告诉用户"为什么没反应" ——
 * 否则功能静默失效，用户根本不知道该去系统设置里授权。
 */
/**
 * 探测辅助功能权限。
 *
 * 判据是**错误码**，实测对比过两端：
 *
 *     没有权限（从终端跑 osascript）→ -10004「权限违例」
 *     有权限（从 App 里跑）          → missing value / 各种 AX 层面的错误
 *
 * 也就是说：**只要不是 -10004，就说明已经通过了 TCC 检查**。
 * 拿不到选中文字只说明"那个 App 没实现 AXFocusedUIElement"（前台是我们
 * 自己的窗口时就是这样），**不影响权限判定**。
 *
 * ⚠️ 这里绕过一次弯：最早我用**正则匹配错误文案**，结果文案没匹配上，
 * 于是把"有权限"报成了未确认；后来又矫枉过正，要求"必须真读到选中文字"
 * 才算有权限，于是把"有权限但前台是空窗口"也报成未确认 ——
 * 用户明明已经在系统设置里打了勾，菜单却一直说未确认。
 * 两次都是因为没有抓住真正稳定的判据：**错误码**。
 */
async function checkPermission () {
  const result = await readSelection()
  if (!result) return { ok: false, error: '读不到前台 App 信息' }
  if (result.denied) return { ok: false, error: result.error }

  // 走到了这里 = 查询被允许了
  return { ok: true, note: result.error || '' }
}

/**
 * 创建监听器。
 *
 * @param {object} deps
 * @param {() => boolean} deps.isEnabled
 * @param {(text: string, source: 'selection'|'clipboard') => void} deps.onText
 * @param {() => string} deps.readClipboard   Electron 的 clipboard.readText
 * @param {() => string|null} deps.ownAppName 用来跳过我们自己
 * @param {(state: {ok: boolean|null, error?: string}) => void} [deps.onPermission]
 *        权限状态的**实测**结果。启动时探测不可靠（前台往往是我们自己），
 *        所以真正的判定来自轮询过程中实际发生的事。
 */
function createWatcher (deps) {
  const { isEnabled, onText, readClipboard, ownAppName, onPermission } = deps

  let selectionTimer = null
  let clipboardTimer = null
  let busy = false
  /** 实测到的权限状态：true 可用 / false 被拒 / null 还没测出来 */
  let permissionState = null
  /** 诊断用：上一次看到的前台 App，变化时打一行日志 */
  let lastSeenApp = null
  let pollCount = 0

  /** 最近处理过的文本 → 时间戳。防止同一段文字被反复送去翻译。 */
  const recent = new Map()
  /** 剪贴板上一次的内容，用来判断"变了没有" */
  let lastClipboard = ''
  let clipboardPrimed = false

  function seenRecently (text) {
    const at = recent.get(text)
    if (at && Date.now() - at < REPEAT_GUARD_MS) return true
    recent.set(text, Date.now())
    // 顺手清理过期的，别让这个 Map 无限长
    if (recent.size > 50) {
      const cutoff = Date.now() - REPEAT_GUARD_MS
      for (const [k, v] of recent) if (v < cutoff) recent.delete(k)
    }
    return false
  }

  /**
   * @param {boolean} [opts.force] 跳过"刚翻过就不翻"的时间窗。
   *   用于「用户又主动复制了一次同一段文字」—— 他明确表达了"我要再看一次"，
   *   不该被去重拦掉。
   */
  function fire (text, source, { force = false } = {}) {
    const value = String(text ?? '').trim()
    if (!value) return
    if (!force && seenRecently(value)) return
    if (force) recent.set(value, Date.now())     // 也记一笔，免得紧接着又被轮询翻一次
    onText(value, source)
  }

  // ── 划词 ──

  async function pollSelection () {
    if (busy) return
    busy = true
    try {
      const result = await readSelection()
      pollCount += 1

      // 诊断日志：划词这类功能一旦不工作，光看代码完全看不出卡在哪一步。
      // 前台 App 变化时打一行，量不大但足够定位。
      if (result && result.app !== lastSeenApp) {
        lastSeenApp = result.app
        console.log(`[translate] 前台 App → ${result.app || '(空)'}`
          + `  选中 ${result.text?.length ?? 0} 字`
          + (result.denied ? '  ⚠️ 权限被拒' : '')
          + (result.error ? `  err=${String(result.error).slice(0, 60)}` : ''))
      }

      if (result?.denied) {
        // 实测到权限被拒 —— 这是**确证**，不是猜测
        if (permissionState !== false) {
          permissionState = false
          console.log(`[translate] 划词权限实测：被拒（${result.error ?? ''}）`)
          onPermission?.({ ok: false, error: result.error })
        }
        return
      }

      // 跳过我们自己：宠物和气泡窗口不该触发翻译
      if (ownAppName && result?.app === ownAppName) return

      if (result?.text) {
        // 真读到了选中文字 —— 这也是确证
        if (permissionState !== true) {
          permissionState = true
          console.log('[translate] 划词权限实测：可用')
          onPermission?.({ ok: true })
        }
        fire(result.text, 'selection')
      }
    } finally {
      busy = false
    }
  }

  // ── 剪贴板 ──

  /** 上一次读到的 changeCount。null = 还没读过 */
  let lastChangeCount = null
  let changeCountBusy = false
  let changeCountCheckedAt = 0

  /** 读 macOS 剪贴板版本号；非 macOS 或出错时返回 null */
  function readChangeCount () {
    return new Promise((resolve) => {
      if (process.platform !== 'darwin') return resolve(null)
      execFile('osascript', ['-e', CHANGECOUNT_SCRIPT], { timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(null)
        const n = Number(String(stdout).trim())
        resolve(Number.isFinite(n) ? n : null)
      })
    })
  }

  function pollClipboard () {
    let text = ''
    try {
      text = String(readClipboard?.() ?? '')
    } catch {
      return
    }

    if (text !== lastClipboard) {
      // 内容变了 —— 一定是新的复制，零成本直接放行
      const isFirst = !clipboardPrimed
      lastClipboard = text
      clipboardPrimed = true
      // 启动时剪贴板里可能已经有旧内容，那不算"用户刚复制"
      if (isFirst) return
      fire(text, 'clipboard')
      return
    }

    // ── 内容没变 ──
    //
    // ⚠️ **但用户可能又复制了一次同一段文字。**
    //    内容比对看不出来，只能问系统的 changeCount。
    //    它每复制一次就 +1，哪怕内容一模一样（实测 438 → 439）。
    //
    //    成本：一次 osascript 约 250ms —— 所以只在"内容没变"时才查，
    //    而且限频到 2 秒一次。正常复制（内容会变）完全不付这个代价。
    if (changeCountBusy) return
    if (Date.now() - changeCountCheckedAt < CHANGECOUNT_POLL_MS) return
    changeCountCheckedAt = Date.now()
    changeCountBusy = true
    readChangeCount().then((count) => {
      changeCountBusy = false
      if (count === null) return
      if (lastChangeCount === null) { lastChangeCount = count; return }   // 第一次只记基准
      if (count === lastChangeCount) return
      lastChangeCount = count
      if (!text) return
      console.log('[translate] 剪贴板内容没变但版本号变了 → 用户又复制了一次')
      // force：用户主动复制，跳过 15 秒去重窗
      fire(text, 'clipboard-recopy', { force: true })
    }).catch(() => { changeCountBusy = false })
  }

  function start () {
    stop()
    // ⚠️ 划词轮询**不启动** —— 见文件顶部说明，AX 那条路实测走不通。
    // 顺带的好处：不再每 900ms 生成一个 osascript 进程。
    //
    // 想再试的话把下面两行放开：
    // ensureCompiled()
    // selectionTimer = setInterval(() => { if (isEnabled()) pollSelection() }, POLL_MS)

    clipboardTimer = setInterval(() => {
      if (isEnabled()) pollClipboard()
    }, CLIPBOARD_POLL_MS)
  }

  function stop () {
    clearInterval(selectionTimer)
    clearInterval(clipboardTimer)
    selectionTimer = null
    clipboardTimer = null
    clipboardPrimed = false
  }

  return {
    start,
    stop,
    checkPermission,
    readSelection,
    getPermissionState: () => permissionState,
    getPollCount: () => pollCount,
    POLL_MS,
  }
}

module.exports = { createWatcher, checkPermission, readSelection }
