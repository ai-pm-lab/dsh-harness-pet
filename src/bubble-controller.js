/**
 * bubble.js（主进程侧）— 气泡的调度
 *
 * 负责三件事：
 *   1. 状态一变 → 挑一句话 → 让气泡窗口显示
 *   2. 同一个状态一直没变 → 按 dialogues/*.md 里的「升级」档催人
 *   3. 摆放位置：贴在宠物上方，出屏就换边
 *
 * 挑哪句话在这里定，怎么画在 src/bubble/ 里定。分开是为了改文案时不用碰渲染代码。
 */

'use strict'

const { STATE_LABELS: LABELS } = require('./state-labels')

/**
 * 各状态的气泡停留时长。
 *
 * needsInput / blocked 给得长：它们的信息量大，而且用户可能正在看别的地方。
 * ready 对齐庆祝动画的时长（5 次跳跃 × 1.16 秒 ≈ 5.8 秒），
 * 让气泡和她的动作同时结束。
 */
/**
 * 每种状态的气泡显示多久。
 *
 * **`0` = 常驻**（一直显示，直到下一条）。渲染层认得这个约定：
 * `bubble.js` 里 `if (durationMs > 0)` 才排隐藏定时器。
 *
 * ⚠️ `needsInput` 和 `blocked` 用常驻，是有意的：
 *    这两个状态**在等人**。说 9 秒就消失的话，用户很容易整段错过 ——
 *    尤其她可能被别的窗口盖住，或者你根本没在看屏幕。
 *    常驻之后配合「时段台词」（`### 升级 30s` / `2m` / `5m` / `10m`），
 *    气泡会**一直在那儿**，只是每隔一段换一批话催。
 *
 * 状态一变，`onState` 会立刻 `say()` 新台词或 `onHide()` ——
 * 所以常驻气泡不会卡住不走。
 */
const DISPLAY_MS = {
  idle: 5000,
  working: 5000,
  ready: 5800,
  needsInput: 0,        // 常驻：在等你确认
  blocked: 0,           // 常驻：出错了，需要你介入
}

/** 气泡语气 → 配色（对应 bubble.css 里的 class） */
const TONE = {
  needsInput: 'attention',
  blocked: 'error',
}

/**
 * 尾巴尖画在**角色头顶下方**多少像素。
 *
 * ⚠️ 名字是历史遗留，**不是**"距窗口底边"—— 看实际用法：
 *       y = pet.y + headOffset + TAIL_TIP_FROM_BOTTOM - bh
 *    窗口下边因此落在 `宠物窗口顶边 + 头顶偏移 + 这个值` 处，
 *    也就是尾巴尖**压在角色头顶下方 8px**。
 *
 * 8 这个数看着舒服：尾巴尖刚好探进头顶一点点，像"从她头上长出来的"。
 *
 * ⚠️ 改 `bubble.css` 里 `#tail` 的 `margin-top` 会让尾巴尖在**窗口内**挪位，
 *    而窗口整体的位置由这里决定 —— 两者要一起看（见 bubble.css 那段说明）。
 */
const TAIL_TIP_FROM_BOTTOM = 8

/** 气泡与屏幕边缘至少留这么多，免得贴边 */
const EDGE_PAD = 8

/**
 * 气泡高度**按文本长度估算** —— 长翻译不再被窗口裁掉。
 *
 * ⚠️⚠️ **为什么是"估算"而不是"量渲染结果"。**
 *
 *    这里踩过一个著名的坑：曾经让渲染层上报内容的真实尺寸、主进程照着
 *    `setBounds` —— 结果形成**正反馈**：
 *        窗口缩小 → CSS 的 max-width 跟着变小 → 文字换行 → 气泡更窄
 *        → 上报更小 → 窗口再缩 → **塌缩成一字一行**
 *    根因是"内容宽度依赖窗口宽度"，就不能反过来让窗口跟着内容走。
 *
 *    所以现在**只按字符数算**：同一段文本永远算出同一个高度，
 *    和窗口当前多大无关 —— 反馈环**在数学上就不存在**。
 *
 * 常数怎么来的（对着 bubble.css 的实测值，改样式时要跟着调）：
 *   · 窗口宽 364，减去左右内边距 14×2 和边框 2×2 → 正文可用约 332px
 *   · 正文字号 13px，汉字约 13px 宽 → 一行约 22 个汉字
 *   · `line-height: 1.5` → 行高约 20px
 */
/**
 * 气泡窗口高度的上限 = 屏幕可用高度的多少。
 *
 * 用户要求「上限提到 100%」—— 也就是**允许气泡占满整个工作区**。
 * 这样一段很长的翻译能一次看全，不用分页。
 *
 * ⚠️ 代价：气泡会盖住桌面（包括宠物自己）。这是有意的取舍 ——
 *    翻译是"我主动要看的"，看完它自己就走（非常驻气泡 5 秒后消失）。
 *
 * ⚠️ **这个常量只在这里定义一份。** 主进程也用它（`maxHeightRatio`），
 *    两边各写一个字面量的话，改了一处另一处不动 —— 表现是
 *    "渲染层以为能装 1000px，主进程却夹到 60%"，而且很难查。
 */
const MAX_HEIGHT_RATIO = 1.0

const EST = {
  charsPerLine: 22,
  lineHeight: 20,
  /** 上下内边距 (10×2) + 边框 (2×2) + 底部给尾巴留的 22 */
  chrome: 20 + 4 + 22,
  /** 提示行（"大模型连接失败，以下为机翻："）占的高度，含下边距 */
  noteHeight: 26,
}

/** 一段文字要占几行。按字符数估，不碰 DOM。 */
function estimateLines (text) {
  const raw = String(text ?? '')
  // 显式换行要单独算 —— 台词文件里是写死的多行
  let lines = 0
  for (const part of raw.split('\n')) {
    lines += Math.max(1, Math.ceil(part.length / EST.charsPerLine))
  }
  return lines
}

/**
 * 这段内容需要多高的窗口。**纯函数** —— 同样的输入永远同样的输出，
 * 不看窗口当前多大，所以不会形成反馈环。
 */
function estimateHeight (text, note, maxHeight) {
  const lines = estimateLines(text)
  const need = EST.chrome + (note ? EST.noteHeight : 0) + lines * EST.lineHeight
  const cap = Math.max(160, Math.floor(maxHeight || 720))
  return Math.max(120, Math.min(cap, Math.ceil(need)))
}

/**
 * 超过上限高度时，把文本裁到放得下为止，并加省略号。
 *
 * ⚠️ **宁可显式截断，也不要让窗口默默裁掉。**
 *    默默裁的话用户看到的是半句话、还不知道后面还有内容；
 *    加了 `…` 至少说明"这里被截了"。屏幕放不下是客观限制，
 *    但"看不出来被截了"是体验问题。
 */
function fitText (text, note, maxHeight) {
  const cap = Math.max(160, Math.floor(maxHeight || 720))
  const room = cap - EST.chrome - (note ? EST.noteHeight : 0)
  const maxLines = Math.max(1, Math.floor(room / EST.lineHeight))
  const maxChars = maxLines * EST.charsPerLine
  const raw = String(text ?? '')
  if (raw.length <= maxChars) return { text: raw, truncated: false }
  return { text: raw.slice(0, maxChars - 1).replace(/\s+$/, '') + '…', truncated: true }
}


/**
 * 状态名别名。
 *
 * 渲染层用的是动画片段名（needInput），话术文件里写的是 DSH 的说法
 * （needsInput）。两边名字只差一个 s，映射一次比让人去记哪个是哪个可靠。
 * 找不到映射就用原名。
 */
/**
 * 哪些状态是"举着手等你"的 —— 气泡常驻、会一直催，直到有人理。
 *
 * ⚠️ 和 `DISPLAY_MS` 里那两个 `0`（常驻）是**同一组**，但用途不同：
 *    那个决定"气泡留多久"，这个决定"点一下算不算确认"。
 *    加新状态时两处都要看 —— 所以放在一起、名字也起得直白。
 */
const HOLDING = new Set(['needsInput', 'needInput', 'blocked'])

const STATE_ALIAS = {
  needInput: 'needsInput',
}

function normalizeState (clip) {
  return STATE_ALIAS[clip] ?? clip
}

function pick (lines) {
  if (!lines || lines.length === 0) return null
  return lines[Math.floor(Math.random() * lines.length)]
}

/**
 * @param {object} deps
 * @param {object} deps.dialogues   dialogues.load() 的结果
 * @param {object} deps.settings    { enabled: { state: boolean }, ... }
 * @param {() => object|null} deps.getPetBounds   返回宠物窗口的 { x, y, width, height }
 * @param {() => object} deps.getBubbleSize  返回气泡窗口的 { width, height }
 * @param {() => object} deps.workArea       返回当前显示的可用区域 { x, y, width, height }
 * @param {(payload) => void} deps.onShow
 * @param {() => void} deps.onHide
 * @param {(x, y) => void} deps.onMove
 */
function createController (deps) {
  const { settings, getPetBounds, onShow, onHide, onMove } = deps
  // ⚠️ **台词要能整套换掉**（`let` 不是 `const`）。
  //    「恢复默认台词」点完之后如果还攥着旧的那份，就得重启才生效 ——
  //    用户会觉得"我点了没反应"。所以导出一个 `setDialogues`。
  let dialogues = deps.dialogues

  let currentState = null
  /**
   * 翻译（或其他外部内容）的**展示截止时刻**。0 = 当前没有。
   *
   * ⚠️ **翻译的优先级最高。** 用户原话：
   *   「状态变更台词会刷新当前翻译，能否将翻译作为权重最高，
   *     任何时候均以翻译内容为主要展示，翻译展示时间结束后
   *     再根据当前状态显示对应台词」
   *
   *   翻译是**用户主动要看的**（他刚复制了一段文字），而状态台词是背景信息 ——
   *   翻到一半被「在干了 老登」顶掉，那段译文就白翻了。
   *
   * ⚠️ **这三个变量必须声明在文件靠前的位置**（和 currentState 一起）：
   *    `onState` 在初始化期间就可能被调用，而 `let` 有暂时性死区 ——
   *    声明写在使用点后面的话，那一下会直接抛 ReferenceError。
   */
  let translateUntil = 0
  let translateTimer = null
  /** 翻译期间被压住的状态，翻译结束后补上 */
  let deferredState = null
  let stateSince = 0
  let escalationTimers = []

  /**
   * 「时刻」的冷却表。
   *
   * 状态是持续的（工作中、需要确认），时刻是一下子的事（打招呼、被吵醒）。
   * 时刻不参与状态计时、也不会打断升级催促 —— 但它必须有冷却：
   * 悬停很容易连着触发，第一次很可爱，第十次就烦了。
   */
  const lastMomentAt = {}
  const MOMENT_COOLDOWN_MS = {
  wave: 20000,
  startle: 20000,
  // 摸头比打招呼频繁得多，但也不能每下都说 —— 5 秒够她回一句
  pat: 5000,
  // 生气是说给用户听的，不设冷却（不然被乱蹭了还不吭声）
  patAngry: 0,
}

  /** 这个状态该不该说话。fixed 的状态永远说话。 */
  function isEnabled (state) {
    const d = dialogues[state]
    if (!d) return false
    if (d.fixed) return true
    return settings.enabled?.[state] !== false
  }

  function clearEscalations () {
    for (const t of escalationTimers) clearTimeout(t)
    escalationTimers = []
  }

  /** 按当前宠物位置摆好气泡窗口。出屏就翻到另一侧。 */
  function position () {
    const pet = getPetBounds?.()
    const metrics = deps.getBubbleSize?.()
    const work = deps.workArea?.()
    if (!pet || !metrics || !work) return

    const { width: bw, height: bh } = metrics

    // 水平：和宠物居中对齐，再夹到屏幕内
    let x = Math.round(pet.x + pet.width / 2 - bw / 2)
    x = Math.max(work.x + EDGE_PAD, Math.min(x, work.x + work.width - bw - EDGE_PAD))

    // 垂直：默认在宠物上方。
    //
    // ⚠️ 这里必须算上「角色头顶距宠物窗口顶边」那一截（headOffset）。
    // 宠物窗口 220×240，而图片是正方形按宽 100% 缩放 → 图片只有 220 高，
    // 底部对齐后**上方空出 20px**；再加上角色在原画布里的顶部留白，
    // 她的头顶其实在窗口顶边下方约 29px 处。
    // 只按窗口顶边算的话，气泡会离她头顶空出一大截 —— 踩过这个坑。
    const headOffset = deps.characterHeadOffset?.() ?? 0
    let y = Math.round(pet.y + headOffset + TAIL_TIP_FROM_BOTTOM - bh)

    // 上方放不下就翻到下方（尾巴这时指向不对，但宁可位置对、指向略偏）
    if (y < work.y + EDGE_PAD) {
      y = Math.round(pet.y + pet.height - TAIL_TIP_FROM_BOTTOM)
      y = Math.min(y, work.y + work.height - bh - EDGE_PAD)
      y = Math.max(work.y + EDGE_PAD, y)
    }

    onMove(x, y)
  }

  /**
   * 按这段文本设好气泡窗口的高度。
   * @returns {{text: string, truncated: boolean}} 可能被裁过的文本
   */
  function applySize (text, note) {
    const work = deps.workArea?.()
    const maxH = work ? Math.floor(work.height * MAX_HEIGHT_RATIO) : 720
    const fitted = fitText(text, note, maxH)
    deps.setBubbleHeight?.(estimateHeight(fitted.text, note, maxH))
    return fitted
  }

  function say (text, durationMs) {
    if (!text) return

    // ⚠️⚠️ **翻译展示期间，所有"内部台词"一律让路。**
    //
    //    这里是**唯一的闸口** —— `say()` 被两处调用：
    //      · `onState()` —— 状态变化的台词
    //      · 升级催促的 `fire()` —— 「睡着了」40 秒后的循环催促
    //    在 `onState` 里挡只能挡住前者，**升级催促照样会把译文顶掉**。
    //
    //    用户原话：「状态变更台词会刷新当前翻译，能否将翻译作为权重最高，
    //              任何时候均以翻译内容为主要展示，翻译展示时间结束后
    //              再根据当前状态显示对应台词」。
    //    ⚠️ 实测踩过的另一个漏口是 `onMoment()`（双击/摸头的「时刻」台词）——
    //       它不走 `say()`，所以那边也要单独挡（见 onMoment）。
    if (Date.now() < translateUntil) {
      console.log('[bubble] 翻译展示中，压住一句：' + String(text).slice(0, 20))
      return
    }

    // 日志里把"常驻"写出来 —— 只显示 `0ms` 会让人以为出错了
    const how = durationMs > 0 ? `${durationMs}ms` : '常驻'
    // ⚠️ **顺序**：先按文本量好窗口高度，再 position() ——
    //    position() 要用新高度算 y，反了就差一截。
    const sized = applySize(text, '')
    console.log(`[bubble] 说：${sized.text}  (${currentState}, ${how})`
      + (sized.truncated ? `  ⚠️ 太长，已截到 ${sized.text.length} 字` : ''))
    position()
    onShow({ text: sized.text, durationMs, tone: TONE[currentState] ?? 'normal' })
  }

  /** 状态切换 */
  function onState (clip, opts) {
    const state = normalizeState(clip)

    // ⚠️ **翻译期间不说话 —— 翻译优先级最高。**
    //    只把状态记下来，等翻译展示完（endTranslate）再补说。
    //    ⚠️ 不要在这里改 `currentState` —— `hideExternal` 靠它判断
    //       "当前是不是翻译气泡"，改了就把撤不掉待定气泡了。
    if (Date.now() < translateUntil) {
      if (state !== deferredState) {
        deferredState = state
        console.log(`[bubble] 翻译展示中，${state} 的台词先压着`)
      }
      return
    }
    // 注：`say()` 里还有一道同样的闸口 —— 那是为了挡住**升级催促**
    //     （它不经这里，直接调 say）。两处都要有。
    // 相同状态默认直接返回 —— 插件可能重复推同一个状态，不该反复刷屏。
    //
    // ⚠️ 但 `opts.restart` 例外：**睡着和醒来时 logicalState 一直是 idle，
    //    状态名没变**。不重置的话升级计时器会一直累加，出现
    //    「她早就被摸醒了，2 分钟后还在说（说梦话）不要抢我的鱼」。
    //    （实测被用户抓到的就是这个。）
    if (state === currentState && !opts?.restart) return
    // 日志带中文名 —— 只有英文 key 的话，排查时得自己对照「sleep 是什么」
    const zh = (x) => (x ? (LABELS[x] ?? x) : '(无)')
    if (state !== currentState) console.log(`[bubble] 状态 ${zh(currentState)} → ${zh(state)}`)
    else console.log(`[bubble] 重新进入 ${zh(state)}（重置升级计时）`)

    currentState = state
    stateSince = Date.now()
    clearEscalations()

    const entry = dialogues[state]
    if (!entry) {
      console.log(`[bubble] ${state} 没有说话术，静默`)
      onHide()
      return
    }
    if (!isEnabled(state)) {
      console.log(`[bubble] ${state} 被用户关掉了`)
      onHide()
      return
    }

    say(pick(entry.lines), DISPLAY_MS[state] ?? 5000)

    // 排升级：到了时长状态还没变，就换一批话催。
    //
    // `level.repeat` 的档（`### 循环`）会**每隔 afterMs 说一次**，
    // 用来对付"要持续很久的状态"—— 工作中、睡着。
    // 不循环的话她进入这种状态后说一句就彻底安静了，用户以为她挂了。
    for (const level of entry.escalate ?? []) {
      // `everyMs` 是循环的间隔；首次仍按 afterMs 等。
      // 老档没这个字段 → 退回 afterMs，行为不变。
      const every = level.everyMs ?? level.afterMs
      const fire = (first) => {
        if (currentState !== state) return          // 状态变了，不催了
        console.log(`[bubble] ${LABELS[state] ?? state} 已持续 ${(first ? level.afterMs : every) / 1000}s，`
          + `${level.repeat ? '循环台词' : '升级催促'}${first ? '' : '（又一次）'}`)
        say(pick(level.lines), DISPLAY_MS[state] ?? 5000)
        if (level.repeat) {
          escalationTimers.push(setTimeout(() => fire(false), every))
        }
      }
      escalationTimers.push(setTimeout(() => fire(true), level.afterMs))
    }
  }

  /**
   * 播一个「时刻」：一次性的话，不改变状态、不重置升级计时。
   *
   * @param {'wave'|'startle'} kind
   */
  function onMoment (kind) {
    const entry = dialogues[kind]
    if (!entry) return

    // ⚠️ **翻译展示期间，时刻台词也让路。**
    //
    //    实测漏过一次：只在 `onState` 里挡了，结果用户双击/摸头触发的
    //    「时刻」台词（`唔……几点了？` / `再摸摸嘛`）照样把译文顶掉 ——
    //    日志里看得清清楚楚：
    //        说（翻译）：It used / to draw its own 1px border…
    //        翻译展示中，idle 的台词先压着        ← 我以为挡住了
    //        说（时刻 startle）：唔……几点了？      ← 实际没有
    //
    //    ⚠️ 这里**只挡台词，不挡动画** —— 动画在渲染层，不受气泡影响。
    //       用户双击/摸头依然能看到她的反应，不会觉得"没反应"。
    if (Date.now() < translateUntil) {
      console.log(`[bubble] 翻译展示中，压住时刻 ${kind} 的台词（动画照播）`)
      return
    }

    const cooldown = MOMENT_COOLDOWN_MS[kind] ?? 0
    const now = Date.now()
    if (cooldown && now - (lastMomentAt[kind] ?? 0) < cooldown) {
      console.log(`[bubble] ${kind} 在冷却中，跳过`)
      return
    }
    lastMomentAt[kind] = now

    if (!isEnabled(kind)) {
      console.log(`[bubble] ${kind} 被用户关掉了`)
      return
    }

    // 注意：**不动 currentState / stateSince / escalationTimers**。
    // 打招呼不该让"需要确认"的催促重新计时。
    const text = pick(entry.lines)
    if (!text) return
    console.log(`[bubble] 说（时刻 ${kind}）：${text}`)
    position()
    onShow({ text, durationMs: 3500, tone: 'normal' })
  }

  /**
   * 翻译（或其他外部内容）的**展示截止时刻**。0 = 当前没有。
   *
   * ⚠️ **翻译的优先级最高。** 用户原话：
   *   「状态变更台词会刷新当前翻译，能否将翻译作为权重最高，
   *     任何时候均以翻译内容为主要展示，翻译展示时间结束后
   *     再根据当前状态显示对应台词」
   *
   *   翻译是**用户主动要看的**（他刚复制了一段文字），而状态台词是背景信息 ——
   *   翻到一半被「在干了 老登」顶掉，那段译文就白翻了。
   */
  /** 翻译结束：解锁，并把压住的状态台词补上 */
  function endTranslate () {
    clearTimeout(translateTimer)
    translateTimer = null
    translateUntil = 0
    const pending = deferredState
    deferredState = null
    if (!pending) return
    console.log(`[bubble] 翻译结束 → 补说当前状态的台词（${pending}）`)
    // 走一遍 onState：它会更新 currentState、排升级、说话
    onState(pending, { restart: true })
  }

  /**
   * 外部内容直接上气泡（划词翻译用）。
   *
   * 和 onState / onMoment 都不同：它**不属于任何状态**，也不该被状态开关过滤 ——
   * 用户明确划了一段文字要翻译，不该因为"工作中气泡关了"就不显示。
   * 唯一的影响是把 currentState 让出来，避免后续升级催促把它覆盖掉。
   */
  function sayExternal ({ text, note = '', durationMs = 12000, tone = 'translate' }) {
    if (!text) return
    console.log(`[bubble] 说（翻译）${note ? '[' + note + '] ' : ''}：`
      + `${text.slice(0, 40).replace(/\n/g, ' / ')}…`)
    // 占住状态，免得下一次升级催促把译文顶掉
    currentState = 'translate'
    clearEscalations()

    // ⚠️ **上翻译锁** —— 期间 onState 只记状态、不说话（见 translateUntil）。
    //    常驻气泡（durationMs = 0）不会自己消失，给一个足够长的上限，
    //    免得锁永远不释放、状态台词再也不出现。
    clearTimeout(translateTimer)
    translateUntil = Date.now() + (durationMs > 0 ? durationMs : 10 * 60 * 1000)
    translateTimer = setTimeout(endTranslate, durationMs > 0 ? durationMs : 10 * 60 * 1000)
    position()
    const sized = applySize(text, note)
    onShow({ text: sized.text, note, durationMs, tone })
  }

  /**
   * 用户说「我看到了」—— 撤掉**常驻的状态气泡**，并停掉升级催促。
   *
   * 需求：「错误状态需要常驻 …… 用户查看 dsh 窗口时再停止」。
   *
   * 三种"停止"方式：
   *   1. **点一下她**（这里）—— 用户主动，最可靠，零权限
   *   2. **DSH 里 agent 恢复活动** —— 自动。状态变了 `onState` 自然会换气泡
   *   3. **前台切到 DSH** —— 自动，但需要系统授权（见 attention.js）
   *
   * ⚠️ **只对"举着手等你"的状态有效**（needInput / blocked）。
   *    工作中/待机时点她，那是"查余额"，不该把工作中的提示撤掉。
   *
   * ⚠️ 撤完之后**不要**立刻按当前状态重说 —— 她刚说"我看到了"，
   *    你就把同一句催促再念一遍，等于没听见。
   *    所以这里只 `onHide()` + 停计时器，**不改 currentState**：
   *    下一次真的状态变化时，`onState` 会照常说话。
   */
  function acknowledge () {
    if (!HOLDING.has(currentState)) {
      console.log(`[bubble] 当前是 ${currentState}，不是"举着手等"的状态，忽略确认`)
      return
    }
    console.log(`[bubble] 用户确认（${currentState}）→ 撤掉常驻气泡、停掉催促`)
    clearEscalations()
    onHide()
    currentState = null
    stateSince = 0
  }

  /**
   * 撤掉外部气泡（划词翻译用）。
   *
   * 为什么需要它：翻译是"先弹待定气泡、再换成结果"两拍的。
   * 但有一条分支**不显示任何结果** —— 接口把原文原样返回时
   * （`isUntranslated`），弹气泡只会让人以为"翻了但没翻"。
   * 那时候如果不主动撤，那句「翻译复制文本中…」就会**一直挂在桌面上**。
   *
   * 只撤"外部"气泡：如果当前是状态气泡（working / needInput 那些），
   * 不动它 —— 那是真实的工作信息。
   */
  function hideExternal () {
    if (currentState !== 'translate') return
    currentState = null
    onHide()
    // ⚠️ **顺手解锁。** 待定气泡（「翻译复制文本中…」）是常驻的，
    //    如果只是撤掉气泡而不解锁，`translateUntil` 会一直占着，
    //    之后所有状态台词都会被压掉 —— 表现是"她再也不说话了"。
    deferredState = null
    endTranslate()
  }

  /** 宠物被拖动时跟着走 */
  function reposition () {
    if (currentState) position()
  }

  function destroy () {
    clearEscalations()
    clearTimeout(translateTimer)
    translateTimer = null
  }

  return {
    onState,
    onMoment,
    sayExternal,
    hideExternal,
    acknowledge,
    reposition,
    destroy,
    isEnabled,
    getDialogues: () => dialogues,
    setDialogues: (next) => { if (next && typeof next === 'object') dialogues = next },
    getState: () => currentState,
    getStateSince: () => stateSince,
  }
}

module.exports = {
  createController, DISPLAY_MS, normalizeState,
  estimateHeight, fitText, MAX_HEIGHT_RATIO,
}
