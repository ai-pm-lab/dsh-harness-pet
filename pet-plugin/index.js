/**
 * dsh-harness-pet — DSH 侧插件
 *
 * 作用：把「agent 现在在干什么」推给桌面上的胖头鱼。
 *
 * 设计约束（决定了代码长什么样）：
 *   1. **零运行时依赖** —— 这个插件不是通过 npm 安装的，而是由桌宠 App 用
 *      绝对路径插进 profile 的 cordis.patch.yml。所以只能用 Node 内置能力。
 *      WebSocket 客户端用的是 Node 22+ 的全局 `WebSocket`，正好够用。
 *   2. **绝不介入 DSH 的决策** —— `approval/request` 和 `user-questions/request`
 *      是 waterfall 事件，谁不调 `next()` 谁就截胡了审批流程。我们只旁观，
 *      一律 `return next()`。
 *   3. **连不上就安静地待着** —— 桌宠没启动是常态，不该刷日志、更不该报错。
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'


/**
 * ─────────────────── 账户余额 / 本轮花费 ───────────────────
 *
 * ⚠️ **这一段会读 DSH 的 API Key**（环境变量优先，其次 ~/.dsh/.credentials.yaml）。
 * 这是"显示余额"绕不开的 —— 余额接口要鉴权。
 *
 * 三条自律：
 *   1. **key 绝不进日志**，也不通过网络发给 App —— 余额数字算完再推
 *   2. 拉取失败静默降级（没有 key、没网、接口变了），不影响桌宠其他功能
 *   3. 有缓存，不在用户连点的时候反复打接口
 *
 * 不想让它读 key 的话，把 config.balance 设为 false。
 */

/** 余额缓存时长。余额只在充值时变，一分钟足够新。 */
const BALANCE_CACHE_MS = 60000

/** DeepSeek 官方价目（元 / 百万 token）。改价时记得同步这里。 */
const PRICE = {
  // 命中缓存的输入
  cacheHit: 0.02,
  // 未命中缓存的输入
  cacheMiss: 1,
  // 输出
  output: 4,
}

function readApiKey () {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()

  try {
    const file = path.join(homedir(), '.dsh', '.credentials.yaml')
    if (!existsSync(file)) return null
    const text = readFileSync(file, 'utf8')
    const match = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(.+?)\s*$/m)
    if (!match) return null
    return match[1].trim().replace(/^["']|["']$/g, '')
  } catch {
    return null
  }
}

const STATE = {
  IDLE: 'idle',
  WORKING: 'working',
  NEEDS_INPUT: 'needsInput',
  READY: 'ready',
  BLOCKED: 'blocked',
}

/** 重连退避：0.5s 起，最多 15s */
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 15000

/**
 * ready（任务完成）在插件这边保持多久。
 *
 * 注意：**视觉上的庆祝由渲染层自己结束** —— pet.js 的 ready 片段是 loop:false，
 * 跳满 JUMP_TIMES（5）次、约 5.8 秒后自动回 idle，不需要插件推 idle。
 *
 * 这个值只是插件的内部状态兜底：比渲染层的 5.8 秒略长，
 * 保证不会提前把庆祝切断；到点时渲染层早已是 idle，这条消息等于空操作。
 */
const READY_HOLD_MS = 6000

export const name = 'dsh-harness-pet'

export const inject = []

export function apply (ctx, config = {}) {
  const log = (...args) => {
    // 默认开：这个插件"静默不加载"过一次（补丁里写的是目录路径，
    // ESM 不支持目录导入，而且没有任何报错），排查代价很高。
    // 多打几行日志远比再来一次划算。config.verbose === false 才关掉。
    if (config.verbose !== false) console.log('[pet-plugin]', ...args)
  }

  // 加载标记：用于确认「DSH 到底有没有加载我」。
  // 有它一眼就能分辨"没加载" vs "加载了但连不上"。
  try {
    const dir = `${process.env.HOME}/Library/Application Support/胖头鱼`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/plugin-loaded.json`, JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      node: process.version,
    }, null, 2))
  } catch { /* 写不了就算了，不影响功能 */ }

  log(`插件已加载 pid=${process.pid} node=${process.version}`)

  // ─────────────────────── 状态推导 ───────────────────────

  /** 各 agent 的实时状态，key 是 agent 对象 */
  const agentStates = new Map()

  /** 挂起的审批与提问计数（跨 agent 汇总） */
  let pendingApprovals = 0
  let pendingQuestions = 0

  /** 最近一次错误，短暂停留后清除 */
  let lastErrorAt = 0

  let readyTimer = null
  let balanceTimer = null
  let lastPublished = null

  /**
   * 出错之后**用户确认过了没有**。
   *
   * ⚠️ 需求原话：「错误状态需要常驻，包括状态帧画、台词、长时间未查阅，
   *              用户查看 dsh 窗口时再停止」。
   *
   *    原来 `deriveState` 用的是 `Date.now() - lastErrorAt < 4000` ——
   *    **4 秒后自动退出 blocked**，和"常驻"直接冲突，用户很可能根本没看到那 4 秒。
   *
   *    现在：出错 → 一直 blocked，**直到**：
   *      · 桌宠发来 `{type:'request', kind:'ack'}`（用户点了她 / 切到 DSH）
   *      · 或者 agent 恢复活动（说明问题过去了）
   */
  let errorAcknowledged = false

  /**
   * 庆祝（ready）要独占到的时刻。
   *
   * 为什么需要它：任务做完后会庆祝约 6 秒。这期间 DSH 完全可能因为别的原因
   * 报告 agent 在跑（后台命令、子 agent 活动…），不加保护的话庆祝会被切成
   * "工作中"，用户根本看不清 —— 实测只跳了 1-2 次就被打断。
   *
   * 但**用户发了新消息**时必须立刻切走：那是真要开始干活了。
   */
  let readyUntil = 0
  let userSpokeDuringReady = false

  /** 是否处于庆祝独占窗口 */
  function inReadyWindow () {
    return Date.now() < readyUntil && !userSpokeDuringReady
  }

  /**
   * 汇总出要推给桌宠的状态。
   *
   * 优先级：
   *   1. 有挂起的审批/提问 → needsInput   ← 这个产品最核心的价值
   *   2. 刚出错            → blocked      ← 比庆祝重要
   *   3. 庆祝窗口内        → ready        ← 只挡 working/idle 的抖动
   *   4. 有 agent 在跑     → working
   *   5. 其余              → idle
   */
  function deriveState () {
    // 待确认永远最高优先级 —— 哪怕在庆祝，也要立刻举双手
    if (pendingApprovals > 0 || pendingQuestions > 0) return STATE.NEEDS_INPUT

    // 出错比庆祝重要，随时能打断（测试台抓到过：blocked 被庆祝窗口挡住）
    //
    // ⚠️ **不再用"4 秒窗口"** —— 那样它到点自己就走了，和"常驻"冲突。
    //    现在是"出错就一直举着手"，直到用户确认（见 errorAcknowledged）。
    if (lastErrorAt > 0 && !errorAcknowledged) return STATE.BLOCKED

    // 庆祝窗口内保持 ready。
    // 只挡 working / idle 的抖动 —— 那种"agent 又跑起来了"往往只是后台活动，
    // 不该把庆祝切成工作中。needsInput 和 blocked 都在上面提前返回了。
    if (inReadyWindow()) return STATE.READY

    let running = 0
    for (const status of agentStates.values()) {
      if (status === 'running') running += 1
    }
    if (running > 0) return STATE.WORKING

    return STATE.IDLE
  }

  /** 开始庆祝：占住状态，直到 READY_HOLD_MS 到点或用户发新消息 */
  function enterReadyWindow (reason) {
    readyUntil = Date.now() + READY_HOLD_MS
    userSpokeDuringReady = false
    // 窗口内 deriveState 也会返回 READY，所以这里必须同步 lastPublished，
    // 否则下一次 publish 会把 READY 当成新状态重复推一遍
    lastPublished = STATE.READY
    log(`进入庆祝窗口 ${READY_HOLD_MS}ms  (${reason})`)
    send({ type: 'state', state: STATE.READY, detail: { reason } })

    clearTimeout(readyTimer)
    readyTimer = setTimeout(() => {
      readyUntil = 0
      lastPublished = null          // 强制重发一次 idle
      publish('ready 结束')
    }, READY_HOLD_MS)
  }

  function publish (reason) {
    const state = deriveState()
    const previous = lastPublished

    if (state === previous) return
    lastPublished = state
    log(`状态 ${previous ?? '(初始)'} → ${state}  (${reason})`)

    // 从"在跑"落到"空闲"= 任务做完了 → 进入庆祝窗口
    if (state === STATE.IDLE && previous === STATE.WORKING) {
      enterReadyWindow(reason)
      return
    }

    send({ type: 'state', state, detail: { reason } })
  }

  // ─────────────────────── 与桌宠的连接 ───────────────────────

  let socket = null
  let reconnectTimer = null
  let reconnectDelay = RECONNECT_MIN_MS
  let disposed = false
  let bridgeInfo = null
  let bridgeSource = null

  /**
   * bridge.json 的候选路径。
   *
   * ⚠️ 这里踩过一个坑：Electron 的 userData 目录用的是 `productName`
   * （"胖头鱼 · DSH 桌宠"），**不是** `name`（dsh-harness-pet）。
   * 只写一个路径的话，App 写在 A、插件读 B —— 表现为「插件永远连不上」，
   * 而且两边都不报错，极难排查。
   *
   * 所以按优先级试多个候选，任一命中即可；App 改名也不会失效。
   */
  /**
   * 各平台的 userData 根目录。
   *
   * ⚠️ **这段逻辑在 src/platform.js 里有一份对应的**，这里是故意重复的：
   * 插件要能独立安装（DSH 直接按绝对路径加载它），不能反过来 require
   * 项目里的文件，否则插件就没法单独分发了。
   *
   * 平台取值（和 Electron 的 app.getPath('userData') 对齐）：
   *   Windows  %APPDATA%\<AppName>
   *   macOS    ~/Library/Application Support/<AppName>
   *   Linux    $XDG_CONFIG_HOME 或 ~/.config/<AppName>
   */
  function userDataBases () {
    if (process.platform === 'win32') {
      // APPDATA 优先；没有就退到 LOCALAPPDATA
      const appData = process.env.APPDATA || process.env.LOCALAPPDATA
      return appData ? [appData] : []
    }
    const home = process.env.HOME
    if (!home) return []
    if (process.platform === 'darwin') {
      return [path.join(home, 'Library', 'Application Support')]
    }
    const xdg = process.env.XDG_CONFIG_HOME
    return [xdg || path.join(home, '.config')]
  }

  function bridgeCandidates () {
    // 每个平台的 userData 根目录都试一遍。
    // 换平台时不用改代码 —— Windows 上 APPDATA 就是那个根。
    const dirs = userDataBases()
    // 名字按优先级：当前 productName 在前，旧名字在后（升级上来的用户不用手动搬）
    // ⚠️ 旧名字是**故意的**，以后批量改名别一起替换掉。
    const names = ['胖头鱼']

    const candidates = [config.bridgePath]          // 显式配置优先
    for (const dir of dirs) {
      for (const name of names) {
        candidates.push(path.join(dir, name, 'bridge.json'))
      }
    }
    return candidates.filter(Boolean)
  }

  async function readBridgeInfo () {
    const { readFile } = await import('node:fs/promises')
    for (const candidate of bridgeCandidates()) {
      try {
        const info = JSON.parse(await readFile(candidate, 'utf8'))
        if (info?.port && info?.token) {
          if (bridgeSource !== candidate) {
            bridgeSource = candidate
            log(`发现桌宠: ${candidate}`)
          }
          return info
        }
      } catch { /* 试下一个候选 */ }
    }
    return null      // 桌宠没运行，正常情况
  }

  /**
   * ─────────────── 「跟随 DSH 一起启动」：把桌宠拉起来 ───────────────
   *
   * 桌宠那边勾上「跟随 DSH 一起启动」时，会往 userData 写一份 `launch.json`，
   * **里面带它自己的可执行路径**。这里读那份文件，在发现她没在跑时启动她。
   *
   * ── ⚠️ 为什么用单独的 launch.json，不用 bridge.json ──
   * `bridge.json` 只有桌宠**跑过之后**才存在，而"跟随 DSH"最需要它的场景
   * 恰恰是"她没在跑" —— 靠那个文件就是死循环。
   *
   * ── ⚠️ 判据是「连不上」，不是「pid 死了」 ──
   * `process.kill(pid, 0)` 在 Windows 上行为不一致（受限环境里连 macOS 上
   * 都会误判）。而"能不能连上 WebSocket"跨平台一致，而且**就是我们要的语义**：
   * 连得上说明她在跑，连不上就该拉她起来。
   *
   * ── ⚠️ 三个必须处理的细节 ──
   *   ① **必须 detached + unref** —— 否则 DSH 一退出，桌宠被一起带走
   *   ② **必须清掉 `ELECTRON_RUN_AS_NODE`** —— 那个变量会让 Electron
   *      当成纯 Node 跑：不起窗口、不报错、退出码 0、一行输出都没有。
   *      DSH 自己也是 Electron，它的环境里很可能就有这个变量。
   *   ③ **必须限流** —— 否则"起不来 → 重试 → 起不来"会变成死循环
   */

  /**
   * ⚠️⚠️ **只在 DSH 启动后的这个窗口内**才允许拉起桌宠。
   *
   * 为什么要有这个窗口（用户报的 bug）：
   *   原来的写法是"只要能连不上就试着拉"，加 60 秒冷却、最多 3 次。
   *   结果：**用户主动退出桌宠之后，过了 60/120/180 秒她又会被拉起来** ——
   *   用户的原话是「退出了应该就是退出了，除了重启 DSH 或者在应用列表
   *   打开 APP，否则都不会打开」，而实际表现是"偶发地自己冒出来"
   *   （"偶发"正是因为它是带冷却的定时重试，取决于用户什么时候点）。
   *
   * ⇒ 「跟随 DSH 一起启动」的正确语义**只在 DSH 启动那一刻**成立：
   *     DSH 启动 → 窗口打开 → 拉起她 ✅
   *     窗口关闭后 → 不管连不连得上，**永远不再尝试** ✅
   *     用户中途退出 → 不会被拉起 ✅
   *     直到 DSH 重启 → 窗口重新打开 ✅
   */
  const LAUNCH_WINDOW_MS = 90000
  /** 窗口内最多尝试几次。**一次就够** —— 拉不起来说明路径有问题，再试也是白试。 */
  const LAUNCH_MAX_ATTEMPTS = 1
  /** 两次尝试之间至少隔这么久（防止 DSH 启动瞬间的重连风暴里连拉好几次）。 */
  const LAUNCH_COOLDOWN_MS = 10000
  /** ⚠️ 插件加载的那一刻 —— 窗口从这里开始算。 */
  const pluginLoadedAt = Date.now()
  let launchAttempts = 0
  let lastLaunchAt = 0

  /** `launch.json` 的候选路径 —— 和 `bridgeCandidates()` 同一套目录和名字。 */
  function launchConfigCandidates () {
    const dirs = userDataBases()
    const names = ['胖头鱼']
    const candidates = []
    for (const dir of dirs) {
      for (const name of names) candidates.push(path.join(dir, name, 'launch.json'))
    }
    return candidates
  }

  function readLaunchConfig () {
    for (const candidate of launchConfigCandidates()) {
      try {
        const cfg = JSON.parse(readFileSync(candidate, 'utf8'))
        if (cfg && typeof cfg === 'object') return cfg
      } catch { /* 试下一个 */ }
    }
    return null
  }

  /**
   * 读「用户主动退出」标记 —— 和 `launch.json` 同目录。
   *
   * ⚠️ 只在**同一个 DSH 会话内**有效：标记的时间戳晚于插件加载时间才算数。
   *    本会话之前留下的标记直接忽略（DSH 一重启就该恢复"跟随启动"）。
   */
  function readQuitMark () {
    for (const candidate of launchConfigCandidates()) {
      try {
        const file = path.join(path.dirname(candidate), 'quit-by-user.json')
        const mark = JSON.parse(readFileSync(file, 'utf8'))
        if (mark && typeof mark === 'object') return mark
      } catch { /* 试下一个 */ }
    }
    return null
  }

  /**
   * 兜底：`launch.json` 丢了的话，猜一下她装在哪。
   *
   * 只猜**安装器的默认位置** —— 用户自定义过路径就猜不到，那就算了，
   * 安静放弃（和"没找到 DSH 就安静待着"一个风格）。
   */
  function guessPetExe () {
    if (process.platform === 'darwin') {
      return '/Applications/胖头鱼.app/Contents/MacOS/胖头鱼'
    }
    if (process.platform === 'win32') {
      const base = process.env.LOCALAPPDATA
      return base ? path.join(base, 'Programs', '胖头鱼', '胖头鱼.exe') : null
    }
    return null
  }

  function maybeLaunchPet (reason) {
    if (disposed) return false
    const cfg = readLaunchConfig()
    if (!cfg?.followDsh) return false           // 没勾，什么都不做

    const now = Date.now()
    // ⚠️ **窗口之外永远不拉** —— 这是"用户主动退出后不该自己冒出来"的关键。
    if (now - pluginLoadedAt > LAUNCH_WINDOW_MS) return false

    // ⚠️⚠️ 再看一眼**用户有没有在本会话里主动退出了她**。
    //    窗口判断还不够 —— 如果用户正好在窗口内退出，光靠窗口还是会把她拉起来。
    //    规则（详见桌宠那边 src/launch.js 的说明）：
    //      标记时间戳 **晚于** 插件加载时间 ⇒ 本次会话里用户退出的 ⇒ 不拉
    //      标记时间戳 **早于** 插件加载时间 ⇒ 上次会话留下的   ⇒ 可以拉
    //    ⇒ 这样 DSH 一重启，上次的标记自动失效，不需要谁去清它。
    const quitMark = readQuitMark()
    if (quitMark?.at && quitMark.at > pluginLoadedAt) {
      log(`用户在这次会话里主动退出过桌宠（${new Date(quitMark.at).toLocaleTimeString()}）`
        + ' ⇒ 不再拉起；重启 DSH 后恢复')
      return false
    }
    if (launchAttempts >= LAUNCH_MAX_ATTEMPTS) return false
    if (now - lastLaunchAt < LAUNCH_COOLDOWN_MS) return false

    const exe = (typeof cfg.exePath === 'string' && cfg.exePath) || guessPetExe()
    if (!exe) { log(`桌宠没在跑，但不知道她装在哪（${reason}）`); return false }
    if (!existsSync(exe)) { log(`桌宠路径不存在，跳过：${exe}`); return false }

    launchAttempts += 1
    lastLaunchAt = now
    try {
      // ⚠️ 环境变量要**清掉** `ELECTRON_RUN_AS_NODE`（见上面的说明）。
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(exe, [], {
        detached: true,          // ① 脱离 DSH，DSH 退出不带走她
        stdio: 'ignore',
        env,
      })
      child.unref()
      log(`桌宠没在跑（${reason}）→ 已启动（DSH 启动后 ${Math.round((now - pluginLoadedAt)/1000)} 秒）：${exe}`)
      return true
    } catch (error) {
      log(`启动桌宠失败：${error.message}`)
      return false
    }
  }

  function scheduleReconnect () {
    if (disposed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
  }

  function send (payload) {
    if (socket && socket.readyState === 1 /* OPEN */) {
      try {
        socket.send(JSON.stringify(payload))
      } catch { /* 连接刚好断了，等重连 */ }
    }
  }

  // ── 余额 / 花费 ──

  let balanceCache = null
  let balanceAt = 0
  let balanceBusy = false
  /** 本轮累计的 token 用量，`turn/end` 时结算并清零 */
  let turnUsage = { cacheHit: 0, cacheMiss: 0, output: 0 }

  /**
   * 拉一次余额。失败一律静默 —— 没有 key、没网、接口改版都不该
   * 影响桌宠的其他功能。
   */
  async function fetchBalance () {
    if (config.balance === false) return null
    if (balanceBusy) return balanceCache
    if (balanceCache && Date.now() - balanceAt < BALANCE_CACHE_MS) return balanceCache

    const key = readApiKey()
    if (!key) return null

    balanceBusy = true
    try {
      const res = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const info = (Array.isArray(json.balance_infos) ? json.balance_infos : [])[0] ?? {}
      balanceCache = {
        available: json.is_available === true,
        currency: String(info.currency || 'CNY'),
        total: String(info.total_balance || '0'),
        granted: String(info.granted_balance || '0'),
        toppedUp: String(info.topped_up_balance || '0'),
      }
      balanceAt = Date.now()
      return balanceCache
    } catch (error) {
      // ⚠️ 只记原因，**绝不记 key**
      log(`余额拉取失败（不影响其他功能）: ${error.message}`)
      return balanceCache
    } finally {
      balanceBusy = false
    }
  }

  /** 把余额推给桌宠 */
  async function pushBalance (reason) {
    const balance = await fetchBalance()
    if (!balance) return
    send({ type: 'info', kind: 'balance', balance, reason })
  }

  /** 按三桶分别计价。用的是 DeepSeek 官方价目，改价时同步 PRICE。 */
  function estimateCost (usage) {
    const per = (tokens, price) => (tokens / 1e6) * price
    const cacheHit = per(usage.cacheHit, PRICE.cacheHit)
    const cacheMiss = per(usage.cacheMiss, PRICE.cacheMiss)
    const output = per(usage.output, PRICE.output)
    return {
      cacheHit, cacheMiss, output,
      total: cacheHit + cacheMiss + output,
      tokens: usage.cacheHit + usage.cacheMiss + usage.output,
    }
  }

  /** 从一条用量事件里累加 token。字段名做多重兜底，别因为改版就整个失效。 */
  function accumulateUsage (usage) {
    if (!usage || typeof usage !== 'object') return
    const num = (...keys) => {
      for (const k of keys) {
        const v = usage[k]
        if (typeof v === 'number' && Number.isFinite(v)) return v
      }
      return 0
    }
    turnUsage.cacheHit += num('prompt_cache_hit_tokens', 'cacheReadTokens', 'cache_hit_tokens')
    turnUsage.cacheMiss += num('prompt_cache_miss_tokens', 'inputTokens', 'prompt_tokens')
    turnUsage.output += num('completion_tokens', 'outputTokens')
  }

  async function connect () {
    if (disposed) return

    bridgeInfo = await readBridgeInfo()
    if (!bridgeInfo?.port || !bridgeInfo?.token) {
      // 桌宠没开。安静重试，不刷日志。
      // ⚠️ 但如果用户勾了「跟随 DSH 一起启动」，这里就是**该把她拉起来**的地方。
      maybeLaunchPet('没有 bridge.json')
      scheduleReconnect()
      return
    }

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${bridgeInfo.port}/pet`)
      socket = ws
      // ⚠️ 用它区分「连上过又断线」（正常网络抖动，不该重启她）
      //    和「压根没连上」（多半是她没跑，该拉起来）。
      let opened = false

      ws.addEventListener('open', () => {
        opened = true
        reconnectDelay = RECONNECT_MIN_MS
        ws.send(JSON.stringify({
          type: 'hello',
          token: bridgeInfo.token,
          version: bridgeInfo.protocol ?? 1,
        }))
        log('已连上桌宠')
        // 连上后立刻同步一次当前状态，避免桌宠显示的是旧状态
        lastPublished = null
        publish('连接建立')
      })

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          if (msg.type === 'pong') return
          if (msg.type === 'welcome') {
            log('桌宠已确认握手')
            // 连上先推一次余额 —— 用户第一次点她就能看到数字，不用等定时器
            pushBalance('连接建立')
            // 断线期间的会话事件收不到，计数会失真 —— 连上后强制重推一次
            lastSessionCount = -1
            publishSessionCount()
          }
          // 桌宠主动来问（用户点了她）。
          // 走反向通道是为了**点下去拿到的是最新的** ——
          // 只靠定时推送的话，刚重启那段空窗期里点她只能看到"还没拿到余额"。
          // 用户在桌宠那边确认了（点了她 / 切到 DSH）→ 收工
          if (msg.type === 'request' && msg.kind === 'ack') {
            if (lastErrorAt > 0) {
              lastErrorAt = 0
              errorAcknowledged = true
              log('用户确认 → 退出 blocked')
              publish('用户已确认')
            }
            return
          }

          // 手动触发一个错误 —— 用来验证"出错常驻"这条链路。
          // ⚠️ 这是**测试入口**，正常使用不会走到。
          if (msg.type === 'request' && msg.kind === 'test-error') {
            log('收到测试请求 → 模拟一次出错')
            noteError('测试：模拟出错')
            return
          }

          if (msg.type === 'request' && msg.kind === 'balance') {
            balanceAt = 0            // 强制绕过缓存
            pushBalance('用户查询')
          }
        } catch { /* 忽略无法解析的帧 */ }
      })

      ws.addEventListener('close', () => {
        if (socket === ws) socket = null
        // ⚠️ 第二种"她没在跑"：`bridge.json` 还在（她退出时没清），
        //    但端口已经没人听了 —— 表现为"连上了又立刻断开"。
        //    这里也要试着拉她起来，否则陈旧文件会一直挡着。
        if (!opened) maybeLaunchPet('连不上（bridge.json 可能是陈旧的）')
        scheduleReconnect()
      })

      ws.addEventListener('error', () => {
        // error 之后一定会 close，重连逻辑放在 close 里，这里不重复
      })
    } catch {
      scheduleReconnect()
    }
  }

  // ─────────────────────── 事件订阅 ───────────────────────

  // agent 生命周期：记录每个 agent 的 running/idle
  ctx.on('agent/status', (payload) => {
    const { agent, status } = payload ?? {}
    if (!agent) return
    agentStates.set(agent, status)
    // ⚠️ **agent 又跑起来了 = 问题过去了** → 清掉常驻的 blocked。
    //    这是"三种停止方式"里的第 ①（DSH 里恢复活动），零成本。
    if (status === 'running' && lastErrorAt > 0) {
      lastErrorAt = 0
      errorAcknowledged = true
      log('agent 恢复活动 → 退出 blocked')
    }
    publish(`agent/status=${status}`)
  })

  ctx.on('agent/created', (agent) => {
    agentStates.set(agent, 'idle')
  })

  ctx.on('agent/disposed', (agent) => {
    agentStates.delete(agent)
    publish('agent 释放')
  })

  /**
   * 出错：进入 blocked，**一直保持**，直到用户确认。
   *
   * ⚠️ 原来是 `setTimeout(() => publish('错误已过期'), 4100)` —— 4.1 秒后自己撤销。
   *    那样"常驻"根本无从谈起。
   *
   * ⚠️ 还要清掉 ready 窗口 —— 出错比庆祝重要，而 `readyUntil`
   *    会挡住后续的状态变化（`inReadyWindow()` 在 deriveState 里排在 blocked 后面，
   *    但 enterReadyWindow 会直接 send，绕过 deriveState）。
   */
  const noteError = (reason) => {
    lastErrorAt = Date.now()
    errorAcknowledged = false
    readyUntil = 0
    log('出错 → blocked（常驻，直到用户确认）')
    publish(reason)
  }
  ctx.on('agent/error', () => noteError('agent/error'))
  ctx.on('agent/request-error', () => noteError('agent/request-error'))

  // ⚠️ 提问是 waterfall 事件。
  // 我们只是旁观者，**必须同步 `return next()` 把决定权透传下去**，
  // 否则链条在这里断掉，DSH 的提问功能就废了。
  // （曾经写成 Promise.resolve().then(() => next())，那样返回值丢失 = 截胡。）
  ctx.on('user-questions/request', (_request, next) => {
    pendingQuestions += 1
    publish('提问待答')

    const result = next()          // 交给真正的应答者，同步调用

    // 无论应答者是同步返回还是返回 Promise，结束时机都要能等到
    Promise.resolve(result).finally(() => {
      pendingQuestions = Math.max(0, pendingQuestions - 1)
      publish('提问已结束')
    })

    return result                  // ← 关键：把 next() 的结果原样透传
  })

  // 会话日志事件：审批的起止可以从这里观察到，比介入 waterfall 更安全
  ctx.on('session/event', (_session, event) => {
    const type = event?.type
    if (type === 'approval/asked') {
      pendingApprovals += 1
      publish('审批待确认')
    } else if (type === 'approval/decided') {
      pendingApprovals = Math.max(0, pendingApprovals - 1)
      publish('审批已决定')
    } else if (type === 'turn/end') {
      // 一轮结束 → 结算花费推给桌宠，然后清零等下一轮
      const usage = turnUsage
      turnUsage = { cacheHit: 0, cacheMiss: 0, output: 0 }
      if (usage.cacheHit + usage.cacheMiss + usage.output > 0) {
        send({ type: 'info', kind: 'cost', cost: estimateCost(usage) })
      }
    } else if (type === 'usage' || type === 'assistant/usage') {
      // 用量事件。字段名各版本可能不同，accumulateUsage 里做了兜底。
      accumulateUsage(event?.usage ?? event?.data ?? event)
    } else if (type === 'user/message') {
      // 用户发了新消息 = 真要开始干活了 → 立刻结束庆祝
      if (Date.now() < readyUntil) {
        userSpokeDuringReady = true
        readyUntil = 0
        clearTimeout(readyTimer)
        lastPublished = null
        publish('用户发了新消息，庆祝让位')
      }
    }
  })

  /*
   * ─────────────── 并发会话追踪 ───────────────
   *
   * ⚠️ **单独开一个 `global: true` 的监听器，不动上面那个。**
   *
   * Cordis 的事件派发是这样的（cordis/lib/index.js）：
   *     hooks.filter(h => h.global || !filter || filter.call(thisArg, h.ctx))
   * 不加 global 的监听器只收到**自己作用域**的事件；加了就绕过 filter、
   * 收到所有会话的事件。**这就是为什么我们一直不知道别的会话在跑。**
   *
   * 但上面那个监听器**不能**直接加 global —— 它的逻辑
   * （审批计数、花费结算、结束庆祝）全是**针对当前会话**的。
   * 加上之后别的会话发一条消息就会把我们的庆祝结束掉，全乱。
   *
   * 所以并发追踪单独一个，只做"数在跑几个会话"这一件事。
   */
  const runningSessions = new Set()

  /**
   * 推在跑的会话数。
   *
   * ⚠️ 数量不变时不推 —— 不然每个 turn/start 都发一次，
   * 而 turn/start 在长任务里会出现很多次。
   */
  let lastSessionCount = -1
  function publishSessionCount () {
    const count = runningSessions.size
    if (count === lastSessionCount) return
    lastSessionCount = count
    log(`并发会话数 → ${count}`)
    send({ type: 'info', kind: 'sessions', count })
  }

  ctx.on('session/event', (session, event) => {
    const id = session?.id ?? event?.sessionId
    if (!id) return
    const type = event?.type
    if (type === 'turn/start') runningSessions.add(id)
    else if (type === 'turn/end') runningSessions.delete(id)
    else return
    publishSessionCount()
  }, { global: true })

  // 会话被销毁时清掉，否则一个异常结束的会话会永远算在"在跑"里
  ctx.on('session/disposed', (session) => {
    if (session?.id && runningSessions.delete(session.id)) publishSessionCount()
  }, { global: true })

  // ─────────────────────── 启动与清理 ───────────────────────

  ctx.effect(() => {
    log('插件已加载，开始连接桌宠')
    connect()

    // 余额定时刷新。余额只在充值时变，一分钟一次足够；
    // 而且 fetchBalance 内部还有一层缓存，连点也打不爆接口。
    balanceTimer = setInterval(() => pushBalance('定时刷新'), BALANCE_CACHE_MS)

    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      clearTimeout(readyTimer)
      clearInterval(balanceTimer)
      try { socket?.close() } catch { /* 退出路径 */ }
      log('插件已卸载')
    }
  })
}
