/**
 * attention.js — 判断"用户是不是去看 DSH 了"，是的话就别再催。
 *
 * ── 这个模块解决什么 ──
 *
 * 需求原话：「错误状态需要常驻，包括状态帧画、台词、长时间未查阅，
 *             **用户查看 dsh 窗口时再停止**」。
 *
 * 前三条（常驻气泡、台词、升级催促）`bubble-controller` 已经有了。
 * 这一条是"什么时候停"。
 *
 * ── 三种"停止"方式，各管一段 ──
 *
 *   1. **DSH 里 agent 恢复活动** —— 自动，零成本。
 *      状态一变 `onState` 自然换气泡，不用这里管。
 *   2. **点一下她**（渲染层 → `pet:acknowledge`）—— 用户主动，最可靠。
 *   3. **前台切到 DSH**（这个模块）—— 自动，但**要系统授权**、而且**会误判**。
 *
 * 三条是**互补**的：1 覆盖"用户直接去处理了"，2 覆盖"用户看到了但没动"，
 * 3 覆盖"用户打开 DSH 看了看又没操作"。任何一条命中都算"她不用再举着手了"。
 *
 * ── ⚠️ 这个模块的两个已知妥协（写在这里，免得以后当成 bug 查） ──
 *
 * **① 它是"猜"的，不是"知道"的。**
 *    插件跑在 DSH 里，但它只能旁观 `agent/*` 和 `session/*` 事件 ——
 *    **拿不到窗口焦点**（实测确认过）。所以只能从"前台 App 是谁"去猜。
 *
 *    用户跑的是 DSH 的 Web GUI（`127.0.0.1:19387`），前台会是**浏览器** ——
 *    而"浏览器在前台"不等于"在看 DSH"（可能在看别的网页）。
 *
 *    **误判的代价是可接受的**：只是**不再催**，气泡可以再出现、状态帧也还在。
 *    反过来（该停不停）才是这个需求要解决的痛点。
 *    所以这里**宁可误停，不可漏停**。
 *
 * **② 它需要系统授权，而且会弹一次窗。**
 *    查前台 App 要走 `System Events`，第一次会弹
 *    「胖胖头鱼 想要控制 System Events」。用户拒绝的话：
 *    这里**静默降级**（只打一行日志），另外两种停止方式照常工作。
 *
 * ── 成本 ──
 *
 * `osascript` 一次约 250ms（起一个进程）—— **贵**。所以：
 *   · **只在常驻状态期间轮询**（blocked / needsInput），其余时候完全不跑
 *   · 频率压到 **3 秒一次**
 *   · 异步 + 防重入
 */

'use strict'

const { execFile } = require('node:child_process')

/** 轮询间隔。osascript 一次约 250ms，3 秒已经够跟手，又不至于费电。 */
const POLL_MS = 3000

/** 查一次前台 App 名的脚本。和 selection.js 用的是同一套（但这里不要选中文字）。 */
const SCRIPT = `tell application "System Events"
  return name of first application process whose frontmost is true
end tell`

/**
 * 哪些前台 App 算"用户去看 DSH 了"。
 *
 * ⚠️ **默认给得比较宽**（把所有常见浏览器都算上）—— 理由见文件头
 *    「① 它是猜的」那段：误停的代价小，漏停的代价大。
 *
 * 想收窄的话改这里，或者将来做成设置项。匹配是**不区分大小写的子串**匹配。
 */
const DEFAULT_APPS = [
  // DSH 自己（独立窗口 / Electron 壳）
  'dsh', 'deepseek', 'harness',
  // 浏览器（DSH 的 Web GUI 跑在这里）
  'safari', 'chrome', 'chromium', 'edge', 'firefox', 'arc', 'brave', 'vivaldi',
  // 终端（有人用 CLI 跑 dsh）
  'terminal', 'iterm', 'warp', 'alacritty', 'kitty', 'hyper',
]

/**
 * @param {object} deps
 * @param {() => boolean} deps.shouldWatch  现在要不要盯（只在常驻状态期间为 true）
 * @param {() => void}    deps.onSeen       发现用户去看 DSH 了 → 调这个
 * @param {string[]}      [deps.apps]       覆盖默认的 App 名单
 * @param {(msg: string) => void} [deps.log]
 */
function createWatcher (deps) {
  const { shouldWatch, onSeen } = deps
  const apps = (deps.apps ?? DEFAULT_APPS).map((a) => String(a).toLowerCase())
  const log = deps.log ?? ((m) => console.log(m))

  let timer = null
  let busy = false
  /** 权限/可用性——失败一次就不再反复试，免得刷屏 */
  let unavailable = false
  /** 上一次匹配到的 App，用来避免重复触发 */
  let lastSeen = null

  function readFrontmostApp () {
    return new Promise((resolve) => {
      if (process.platform !== 'darwin') return resolve(null)
      execFile('osascript', ['-e', SCRIPT], { timeout: 4000 }, (err, stdout) => {
        if (err) {
          // ⚠️ **只报一次**。没授权的话每 3 秒报一次会把日志淹掉。
          if (!unavailable) {
            unavailable = true
            log('[attention] 查不了前台 App（多半是没授权 System Events）'
              + ' → 这条停止方式关掉，另外两种（agent 恢复 / 点一下她）照常工作')
          }
          return resolve(null)
        }
        resolve(String(stdout).trim() || null)
      })
    })
  }

  async function tick () {
    // 不在这两个状态里就完全不跑 —— 省掉那 250ms 的 osascript
    if (!shouldWatch()) {
      lastSeen = null
      return
    }
    if (busy || unavailable) return
    busy = true
    try {
      const app = await readFrontmostApp()
      if (app === null) return
      const lower = app.toLowerCase()
      const hit = apps.some((a) => lower.includes(a))
      if (!hit) {
        lastSeen = null
        return
      }
      // 同一个 App 连着命中只报一次（用户可能一直开着浏览器）
      if (lastSeen === app) return
      lastSeen = app
      log(`[attention] 前台是「${app}」→ 判定用户去看 DSH 了，停止常驻和催促`)
      onSeen()
    } finally {
      busy = false
    }
  }

  function start () {
    stop()
    timer = setInterval(() => { tick().catch(() => {}) }, POLL_MS)
  }

  function stop () {
    clearInterval(timer)
    timer = null
    busy = false
    lastSeen = null
  }

  return {
    start,
    stop,
    /** 测试用：手动跑一次 */
    tick,
    get lastSeenApp () { return lastSeen },
    get unavailable () { return unavailable },
    POLL_MS,
    DEFAULT_APPS,
  }
}

module.exports = { createWatcher, POLL_MS, DEFAULT_APPS }
