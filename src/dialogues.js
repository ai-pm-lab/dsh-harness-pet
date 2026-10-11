/**
 * dialogues.js — 话术解析
 *
 * 直接读 dialogues/*.md 并解析，**不编译成 JSON**。
 * 理由：话术是要反复改的东西，多一层构建就多一处会忘记同步的地方。
 * 启动时解析一次，文件很小（几 KB），代价可以忽略。
 *
 * ⚠️ 这条设计是被坑出来的：DSH 插件那边「补丁指向目录」和「userData 用
 * productName」两个 bug 都是"两边不一致而且静默失败"。话术只留一份源文件，
 * 就不存在"改了 A 忘了 B"的可能。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** 时长写法 → 毫秒。支持 30s / 2m / 10m。 */
function parseDuration (text) {
  const m = /^(\d+)\s*([smh])$/i.exec(String(text).trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  return n * (unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000)
}

/**
 * 解析话术 Markdown。
 *
 * 返回：
 *   {
 *     idle:      { fixed: false, lines: [...], escalate: [{ afterMs, lines }] },
 *     needsInput:{ fixed: true,  lines: [...], escalate: [...] },
 *     ...
 *   }
 */
/**
 * 能真正被触发的状态。
 *
 * ⚠️ **话术文件里可以写任意英文 key，但没有代码会去用它。**
 *    状态是由 DSH 事件驱动的 —— 只有下面这些地方会调到：
 *      · `setState('idle' / 'working' / 'ready')`  ← pet.js
 *      · 插件的 state 推送：idle / working / needsInput / ready / blocked
 *      · `reportMoment('wave' / 'startle' / 'pat' / 'patAngry')`
 *
 *    用户在文件里加一个新 key，解析会成功、菜单里也会多一项，
 *    **但永远不会有人说那句话** —— 而且没有任何提示。所以这里列出来，
 *    遇到不认识的就警告一声。
 *
 * 加新状态时要改三处：这里、`src/renderer/pet.js` 的触发点、`main.js` 的 `labelOf()`。
 */
const KNOWN_STATES = [
  // 状态。`sleep` 也是真状态 —— 连续 50 秒没人理她就进，
  // 醒来的那一下切回 idle（见 pet.js 的 scheduleSleep / wakeUp）。
  'idle', 'working', 'needsInput', 'ready', 'blocked', 'sleep',
  // 时刻
  'wave', 'startle', 'pat', 'patAngry',
]

/**
 * 台词前面的**序号**：`- #3 台词内容`
 *
 * 为什么要它：内置和你那份都会变，程序得能分清
 *   「这句是你**改**过的」还是「这句是内置**新加**的」。
 *   没有序号就只能整段比，比不出"改了"和"加了"的区别，
 *   于是只能让人在菜单里手动选「合并」还是「恢复默认」——
 *   太复杂了。有了稳定序号，合并可以**全自动**。
 *
 * 规则（很简单，先到先得）：
 *   · 写了 `#N` 就用 N
 *   · 没写就自动补，接着当前最大的往下排
 *   · **写重了** → 后面那个自动挪到下一个空号（见 `dedupeIds`）
 *
 * ⚠️ **序号只是身份，不决定播放顺序** —— 播放永远是随机挑一句。
 *    文档里必须写明，不然用户会以为 `#1 #2 #3` 是按顺序播。
 *
 * ⚠️ 序号**统一从 1 开始，不分内置和用户**。
 *    这个项目一度分过号段（内置 1–899、用户 900+），那是"自动合并"模型的需要。
 *    改成"纯覆盖 + 备份"之后不需要了 —— 台词文件升级时整个换掉，
 *    两边不需要靠号对上，号只用来给**你自己**看清楚哪句是哪句。
 */
const LINE_RE = /^[-*]\s+(?:#(\d+)\s+)?(.+)$/


/**
 * 同一个块里**号写重了** → 把后面重复的那个挪到下一个空号。
 *
 * 用户手写时很容易复制粘贴出一对 `#3`。不处理的话两句会"共用一个身份"，
 * 将来想按号找某一句就会找到两句。
 *
 * ⚠️ **只动重复的那一个，其它号一律不碰。**
 *    按出现顺序整体重排（1,2,3,4…）看起来更整齐，但会把用户
 *    后面所有句子的号都改掉 —— 那些号是身份，不该因为前面插了一句就全变。
 *
 * @param {{lines: string[], lineIds: number[]}} block
 */
function dedupeIds (block) {
  if (!block?.lineIds) return
  const used = new Set(block.lineIds)
  // ⚠️ 新号从**全块最大号 + 1** 开始，不是从重复号 +1 开始。
  //
  //    第一版用的就是 `id + 1`，结果**连锁挪号**：
  //        #1 第一句   #2 第二句   #2(手滑)   #3 第三句
  //        → 手滑那个挪到 #3，**把本来没写重的 #3 挤到 #4**
  //    一句写错，后面全变。号是身份，不该因为前面插了一句就集体改号。
  //
  //    从最大号往后发就不会碰到任何已存在的号。
  let next = Math.max(0, ...block.lineIds) + 1
  // 出现过的原号（含还没处理的）也要避开
  for (const id of block.lineIds) used.add(id)
  const seen = new Set()
  const moved = []
  for (let i = 0; i < block.lineIds.length; i += 1) {
    const id = block.lineIds[i]
    if (!seen.has(id)) { seen.add(id); continue }
    while (used.has(next)) next += 1
    moved.push(`#${id} → #${next}`)
    block.lineIds[i] = next
    used.add(next)
    seen.add(next)
  }
  if (moved.length) {
    console.warn(`[dialogues] 序号重复，已自动顺延: ${moved.join('，')}`)
  }
}

function parse (markdown) {
  const states = {}
  let state = null
  let level = null          // null = 状态的主台词；否则是某个升级档

  /** 每个块自己的自动编号计数器（**每档内独立**编号，不跨档连续）。 */
  const push = (target, id, text) => {
    if (!target || !text) return
    // 有显式序号就用它，并把自动号推到它后面；没有就用自动号。
    const use = (id != null) ? id : target._next
    target._next = Math.max(target._next, use + 1)
    target.lines.push(text)
    target.lineIds.push(use)
  }

  // ⚠️ **必须跳过 ``` 代码块。**
  //
  // 格式说明里举了 `## idle` 的例子（在代码块里），不跳的话它会被当成
  // **一个真的状态** —— 而 `states[name] = state` 是覆盖写，
  // 于是"示例里的 idle"会把"真的 idle"顶掉，台词全变成文档里的示例。
  //
  // 实测踩到：加了「序号」说明之后，代码块里就有 `## idle`。
  // 当时没炸只是因为示例排在真状态**前面**（后来的覆盖先来的），
  // 顺序一反就出事 —— 这种靠运气的正确不能留。
  let inFence = false

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('```')) { inFence = !inFence; continue }
    if (inFence) continue

    // ## 状态名  [fixed]  后面可以跟中文注释
    //
    // ⚠️ **不要把"后面还有没有东西"写进正则。** 原来的是
    //      /^##\s+([A-Za-z][\w-]*)\s*(\[fixed\])?\s*$/
    //    末尾那个 `$` 让 `## idle 空闲` 整行匹配不上 —— 结果是**静默地
    //    一个状态都不解析**，用户只看到"气泡不会说话"。
    //    改成只认开头，后面的都当注释忽略，中文就能直接写在标题里。
    const stateMatch = /^##\s+([A-Za-z][\w-]*)\s*(.*)$/.exec(line)
    if (stateMatch) {
      const name = stateMatch[1]
      const rest = stateMatch[2] ?? ''
      state = {
        name,
        // 标记可以在注释前面或后面（`## idle [fixed] 空闲` / `## idle 空闲 [fixed]`）
        fixed: /\[fixed\]/.test(rest),
        // 中文注释，只给人看，不参与逻辑。开头的「←」只是为了在源文件里
        // 和状态名有个视觉分隔，解析时去掉。
        note: rest.replace(/\[fixed\]/, '').replace(/^[\s←—-]+/, '').trim(),
        lines: [],
        lineIds: [],
        _next: 1,          // 自动编号的下一个号
        escalate: [],
      }
      states[name] = state
      level = null
      continue
    }

    // ### 升级 30s   /   ### 循环 30s
    //
    // 「升级」是**一次性**的：到点说一次，之后不再说。
    // 「循环」是**反复**的：每隔那么久就说一句 —— 给"要持续很久的状态"用
    // （工作中、睡着），否则她进入这种状态后说一句就彻底安静了。
    // `### 循环 <首次> [间隔]`：
    //   只写一个 → 首次等那么久，之后**也按那个间隔**重复
    //   写两个   → **首次等第一个**，之后按第二个重复
    // 为什么要两个：工作刚开始时别一直烦人（45 秒才说第一句），
    // 但拖久了就该越来越频繁地冒话（之后每 10 秒）。
    const escMatch = /^###\s+(升级|循环)\s+(\S+)(?:\s+(\S+))?\s*$/.exec(line)
    if (escMatch) {
      if (!state) continue
      const afterMs = parseDuration(escMatch[2])
      if (afterMs == null) {
        console.warn(`[dialogues] 看不懂的时长: ${escMatch[2]}`)
        continue
      }
      // 没写第二个就沿用第一个（老写法 `### 循环 30s` 行为不变）
      let everyMs = afterMs
      if (escMatch[3] != null) {
        everyMs = parseDuration(escMatch[3])
        if (everyMs == null) {
          console.warn(`[dialogues] 看不懂的重复间隔: ${escMatch[3]}，退回用首次时长`)
          everyMs = afterMs
        }
      }
      level = { afterMs, everyMs, lines: [], lineIds: [], _next: 1,
        repeat: escMatch[1] === '循环' }
      state.escalate.push(level)
      continue
    }

    // ## 开头但没被上面认成状态 → **结束当前状态块**
    //
    // ⚠️ 必须连 `state` 一起清掉。原来这里只清了 `level`，于是
    //    `## 某个不认识的标题` 之后，`state` 还是上一个状态，
    //    下面的 `- 台词` 会**串到那个状态的台词列表里**。
    //    实测：在文件末尾加一段「## 我瞎编的状态」+ 一句台词，
    //    那句会跑进 `idle` —— 用户完全看不出问题，只是 idle 多了一句莫名其妙的话。
    if (/^##\s/.test(line)) { state = null; level = null; continue }

    // ### 其他标题 → 只结束当前升级块（说明文字不该被当台词）
    if (line.startsWith('#')) { level = null; continue }

    // - 台词   /   - #3 台词
    const lineMatch = LINE_RE.exec(line)
    if (lineMatch && state) {
      push(level ?? state, lineMatch[1] != null ? Number(lineMatch[1]) : null,
        lineMatch[2].trim())
      continue
    }
  }

  // 升级档按时间排序，取用时方便
  for (const s of Object.values(states)) {
    dedupeIds(s)                       // 状态主台词
    for (const lv of s.escalate) dedupeIds(lv)
    s.escalate.sort((a, b) => a.afterMs - b.afterMs)
    // `_next` 是解析过程中的计数器，不该往外传
    delete s._next
    for (const lv of s.escalate) delete lv._next
  }

  // 不认识的状态给个警告。用户多半是想"加一段新台词"，
  // 但如果没有代码去触发它，那些句子永远不会出现 —— 得让他知道。
  const unknown = Object.keys(states).filter((k) => !KNOWN_STATES.includes(k))
  if (unknown.length) {
    console.warn(`[dialogues] ⚠️ 这些状态名不会被触发，写了也不会说: ${unknown.join(', ')}`)
    console.warn(`[dialogues]    能用的只有: ${KNOWN_STATES.join(' / ')}`)
  }
  return states
}

  // 按行扫出每个块（状态主台词 / 每个升级循环档）的 (id, 原文行, 文本)
/**
 * 扫出文件里每个块（状态主台词 / 每个升级循环档）的台词，带**序号**。
 *
 * 块的键：`状态名#N` —— `#0` 是状态主台词，`#1` 起是第 N 个升级/循环档。
 *
 * ⚠️ 要**跳过 ``` 代码块** —— 文件开头的格式说明里举了 `### 升级 时长` 的例子，
 *    不跳的话会被当成真的档（实测踩到过）。
 *
 * @returns {{blocks: Map<string, Map<number, string>>, order: string[]}}
 */
function scanBlocks (text) {
  const blocks = new Map()
  const order = []
  let state = null
  let levelIdx = -1
  let inFence = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('```')) inFence = !inFence
    if (inFence) continue
    const sm = /^##\s+([A-Za-z][\w-]*)/.exec(line)
    if (sm) { state = sm[1]; levelIdx = -1; continue }
    if (/^###\s+/.test(line)) { levelIdx += 1; continue }
    if (!state) continue
    const lm = LINE_RE.exec(line)
    if (!lm) continue
    const key = `${state}#${levelIdx + 1}`      // +1：0 留给"状态主台词"
    if (!blocks.has(key)) { blocks.set(key, new Map()); order.push(key) }
    const m = blocks.get(key)
    const id = lm[1] != null ? Number(lm[1]) : m.size + 1
    m.set(Math.max(id, 1), lm[2].trim())
  }
  return { blocks, order }
}




/**
 *
 * 「升级不覆盖用户内容」是对的，但它的另一面必须补上：
 * **内置加了新状态或新注释，用户不会知道。**
 * 实测撞到过 —— 用户副本比内置早建 3 分钟，内置新加的中文注释一条都没继承，
 * 而日志里只有一句"已载入（用户）"，看不出任何问题。
 *
 * 只提示，不改动用户的文件 —— 想更新就右键「恢复默认台词」。
 */
function warnIfOutdated (lang, builtinDir, userStates) {
  let builtin
  try {
    builtin = parse(fs.readFileSync(path.join(builtinDir, `${lang}.md`), 'utf8'))
  } catch {
    return                                    // 内置读不到就没得比
  }
  const missing = Object.keys(builtin).filter((k) => !(k in userStates))
  const noNote = Object.keys(userStates).filter((k) => builtin[k] && !userStates[k].note && builtin[k].note)

  if (missing.length) {
    console.warn(`[dialogues] ⚠️ 内置话术里有你这份没有的状态: ${missing.join(', ')}`)
    console.warn('[dialogues]    右键 →「恢复默认台词」可以换成内置那份（会丢掉你自己的改动）')
  }
  if (noNote.length) {
    // 注释只是给人看的，不影响功能，所以只用 log 不用 warn
    console.log(`[dialogues] 提示: ${noNote.length} 个状态在内置里加了中文说明，你这份还没有`)
  }
}

/**
 *
 * **两层查找**，用户那份优先：
 *
 *   1. `<userData>/dialogues/<lang>.md`  ← 用户自己改的
 *   2. `<App>/dialogues/<lang>.md`       ← 内置默认值
 *
 * 为什么需要第一层：
 *   · **打包成 .dmg 之后 App 包是只读的** —— 只有内置那份的话，用户永远改不了台词
 *   · 升级不会覆盖用户改过的台词
 *   · 用户那份不存在时行为完全不变（就是以前的样子）
 *
 * 找不到语言包时退回 zh，再不行返回空表（空表 = 不说话，其余功能照常）。
 *
 * @param {string} lang           语言代码
 * @param {string|null} userDir   userData 目录。不传就只有内置那一层。
 */
function load (lang = 'zh', userDir = null) {
  const builtinDir = path.join(__dirname, '..', 'dialogues')
  const userDirFull = userDir ? path.join(userDir, 'dialogues') : null

  for (const candidate of [lang, 'zh']) {
    // 用户那份优先。同一个语言只在两层各找一次。
    const tries = []
    if (userDirFull) tries.push({ file: path.join(userDirFull, `${candidate}.md`), from: '用户' })
    tries.push({ file: path.join(builtinDir, `${candidate}.md`), from: '内置' })

    for (const { file, from } of tries) {
      let text
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`[dialogues] 读取 ${file} 失败:`, err.message)
        continue
      }
      try {
        const states = parse(text)
        const total = Object.values(states)
          .reduce((n, s) => n + s.lines.length + s.escalate.reduce((m, e) => m + e.lines.length, 0), 0)

        // ⚠️ **解析出 0 个状态也要当作失败。**
        //    parse() 对格式不对的内容**不抛异常**，只是返回空对象 ——
        //    所以单靠 try/catch 抓不到"用户把文件改坏了"。
        //    实测：把话术写成一句乱码，气泡会彻底不说话，而且日志里只有
        //    "0 个状态，0 句台词"这一行，用户根本不知道是自己那份的问题。
        //    这里当作失败继续往下找，内置那份还能兜住。
        if (Object.keys(states).length === 0) {
          console.warn(`[dialogues] ${file}（${from}）解析出 0 个状态，当作无效`
            + `${from === '用户' ? '，退回内置那份' : ''}`)
          continue
        }

        console.log(`[dialogues] 已载入 ${candidate}.md（${from}）：`
          + `${Object.keys(states).length} 个状态，${total} 句台词`)

        // 用的是用户那份时，比一下内置有没有"更新出用户没有的东西"。
        //
        // 为什么要这个：「升级不覆盖用户内容」是对的，但它的另一面是 ——
        // **内置加了新状态或新注释，用户永远看不到，而且不会有任何提示。**
        // 实测就撞上了：用户副本比内置早建 3 分钟，内置新加的中文注释一条都没有。
        if (from === '用户') {
          warnIfOutdated(candidate, builtinDir, states)
          // 顺带做一次自动更新检查 —— 只在"用户没改过"时才会真的动文件
          if (userDir) {
            try { ensureUserCopy(candidate, userDir) } catch { /* 更新失败不影响本次使用 */ }
          }
        }
        return states
      } catch (err) {
        // ⚠️ **解析失败要能看出来是"用户改坏了"还是"内置坏了"。**
        //    以前这里统一报"读取失败"，用户改错一个格式只会看到"气泡不会说话"，
        //    完全不知道是自己那份的问题。现在直接说清楚，并**继续往下试内置那份** ——
        //    用户改坏了不该让整个气泡功能瘫掉。
        console.warn(`[dialogues] 解析 ${file}（${from}）失败，${from === '用户' ? '改坏了会退回内置那份' : ''}`)
        console.warn(`[dialogues]   ${err.message}`)
      }
    }
  }
  console.warn('[dialogues] 没找到可用的话术文件，气泡不会说话')
  return {}
}

/**
 * 副本头部那段版本标记。
 *
 * 只记**一个版本号**就够了 —— 因为模型是「纯覆盖 + 备份」：
 *   · 版本一样 → 什么都不做（你改过的那份归你自己管）
 *   · 版本变了 → **备份**你那份，然后**覆盖**成新内置，并弹窗告诉你
 *
 * 这里一度记过 `builtin-sha` / `copy-sha` / `builtin-max-id` ——
 * 那是"自动合并"模型要的东西（判断哪句是你改的、哪句是内置新加的、
 * 哪句是你删的）。那套东西需要给每句台词一个能跨文件对上的身份，
 * 于是要有基准、还要给自己写的句子单独划号段，复杂到用户直接说
 * 「有点过于复杂了」。换成现在这个模型之后，那些字段全都不需要了。
 *
 * 用 HTML 注释包起来，解析器会当成普通行忽略掉。
 */
const MARK_BEGIN = '<!-- dsh-pet-dialogues'
const MARK_END = '-->'

function sha (text) {
  return require('node:crypto').createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * 把标记块从内容里剥掉 —— 算指纹和判断"有没有被改过"都要用剥掉之后的。
 *
 * ⚠️ **连标记后面那个换行一起吃掉。** 第一版没吃，于是
 *    剥出来是 `"\n" + body`，而 `copy-sha` 记的是 `sha(body)` ——
 *    两边永远对不上，"没改过"永远为假，**自动更新一次都不会触发**。
 *    这个 bug 是测试抓到的（③ 报红）。
 */
function stripMark (text) {
  const i = text.indexOf(MARK_BEGIN)
  if (i === -1) return text
  const j = text.indexOf(MARK_END, i)
  if (j === -1) return text
  let tail = text.slice(j + MARK_END.length)
  if (tail.startsWith('\n')) tail = tail.slice(1)     // 标记和正文之间那个换行
  return text.slice(0, i).replace(/\n$/, '') + tail
}

/**
 * 造一个带版本标记的副本内容。
 *
 * **只需要记一个版本号。** 模型是"纯覆盖 + 备份"：
 *   · 版本一样 → 什么都不做（你的改动归你自己管）
 *   · 版本变了 → 备份你那份，然后覆盖成新内置
 *
 * 之前这里还记过 `builtin-sha` / `copy-sha` / `builtin-max-id` ——
 * 那是"自动合并"模型要的东西（判断哪句是你改的、哪句是内置新加的）。
 * 换模型之后全都不需要了。
 */
function withMark (body, version) {
  return `${MARK_BEGIN}
     builtin-version: ${version}
     这行是给程序看的：下次内置版本号变了，会**提示 + 备份 + 覆盖**你的文件。
     你可以不管它。
     ${MARK_END}
${body}`
}

/** 读出标记里的字段。没有标记就返回 null（标记是后加的，老副本没有）。 */
function readMark (text) {
  const i = text.indexOf(MARK_BEGIN)
  if (i === -1) return null
  const j = text.indexOf(MARK_END, i)
  if (j === -1) return null
  const m = /builtin-version:\s*([^\s]+)/.exec(text.slice(i, j))
  return { version: m ? m[1] : null }
}

/**
 * 把内置话术复制到 userData，给用户一份可编辑的副本。
 *
 * - 副本不存在                        → 建一份（带标记）
 * - 副本存在、**没被改过**、内置更新了 → **自动更新**（用户没有损失）
 * - 副本存在且被改过                  → 一个字节都不动，交给上层提示
 *
 * @returns {{path: string, created: boolean, updated?: boolean}}
 */
function ensureUserCopy (lang, userDir) {
  const dir = path.join(userDir, 'dialogues')
  const dest = path.join(dir, `${lang}.md`)
  const src = path.join(__dirname, '..', 'dialogues', `${lang}.md`)
  const builtin = fs.readFileSync(src, 'utf8')
  const version = builtinVersion()
  const said = (msg) => console.log(`[dialogues] ${msg}`)

  // ⚠️ 这个函数的模型变了，从"自动合并"改成**纯覆盖 + 备份**。
  //
  // 为什么换：自动合并需要给每句台词一个能跨文件对上的身份，
  // 于是要序号、要基准（`builtin-max-id`）、还要给用户自己写的句子
  // 单独划一个 900 号段免得撞车 —— 复杂到用户直接说"有点过于复杂了"。
  //
  // 现在的模型（用户定的）：
  //   · 台词文件初始就是内置那套
  //   · **你改过之后就归你自己管**，App 一个字都不动
  //   · 版本更新时**提示 + 备份 + 覆盖**，你自己看备份决定要不要搬
  //   · 「恢复默认台词」随时能回到内置
  //
  // 代价是升级会覆盖你的改动 —— 但**备份一定在**，而且不用再猜来猜去。

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(dest, withMark(builtin, version))
    said(`已把内置话术复制到 ${dest}（这份是你的，改完重启就生效）`)
    return { path: dest, created: true }
  }

  const cur = fs.readFileSync(dest, 'utf8')
  const mark = readMark(cur)
  // 老副本没有版本标记 → 当作"跟上一次的内置同步过"，补上标记就好
  if (!mark) {
    fs.writeFileSync(dest, withMark(stripMark(cur), version))
    said('已给你的话术文件补上版本标记（内容没动）')
    return { path: dest, created: false }
  }
  if (mark.version === version) return { path: dest, created: false }

  // ── 版本变了：备份 → 覆盖 ──
  // ⚠️ **用本地时间，不要用 `toISOString()`** —— 那是 UTC。
  //    实测：文件时间是 19:08，备份名却是 `11-08`，差了 8 小时，
  //    用户按文件名找备份会对不上号。
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `-${pad(d.getHours())}-${pad(d.getMinutes())}`
  const backup = `${dest}.${stamp}.bak`
  try {
    fs.copyFileSync(dest, backup)
    fs.writeFileSync(dest, withMark(builtin, version))
    said(`内置话术更新了（${mark.version || '旧版'} → ${version}）`)
    said(`你原来那份已备份到 ${path.basename(backup)}`)
    said('台词文件已换成新版内置；想把改动搬回来，对比一下那个 .bak 就行')
    lastUpdateNotice = { backup, from: mark.version, to: version }
  } catch (err) {
    // 备份失败就**绝不覆盖** —— 宁可不同步也不能丢用户的改动
    said(`备份失败，为安全起见没有覆盖: ${err.message}`)
  }
  return { path: dest, created: false }
}

/**
 * 上一次启动时是否发生了"升级 + 覆盖"。
 * 主进程拿它决定要不要弹个提示 —— 用户可能根本没看日志。
 */
let lastUpdateNotice = null
function takeUpdateNotice () {
  const n = lastUpdateNotice
  lastUpdateNotice = null
  return n
}

/** 内置话术的版本号。用 package.json 的 version —— 只有正式发版才会变。 */
function builtinVersion () {
  try {
    return require('../package.json').version ?? '0'
  } catch { return '0' }
}

/** 用户那份话术的路径（不管存不存在）。 */
function userCopyPath (lang, userDir) {
  return path.join(userDir, 'dialogues', `${lang}.md`)
}

module.exports = { load, parse, parseDuration, ensureUserCopy, userCopyPath,
  stripMark, scanBlocks, dedupeIds, takeUpdateNotice }
