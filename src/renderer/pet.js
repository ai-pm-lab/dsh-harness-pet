/**
 * 胖头鱼 — renderer 侧的动画与交互
 *
 * 职责：
 *   - 需求 2：可交互（悬停挥手、点击、拖动）
 *   - 需求 6 的视觉部分：透明窗口里只让宠物本身接管鼠标
 *   - 状态机：把外部（DSH 插件）推来的状态演成动画
 *
 * 时序与帧序来自上游 dsh-whale-pet（MIT）。那几个数字是调过的：
 * 眨眼停顿 2.7 秒、眨眼本身 140 毫秒、40 秒没人理就睡。
 */

'use strict'

// ─────────────────────────── 资源 ───────────────────────────

/**
 * 逻辑帧名 → 文件名（不含扩展名）。
 *
 * ⚠️ 这个映射**名字不一致**，很容易写错：
 *     ready2 → 'ready'（不是 'ready_2'）
 * 写错时 showFrame 会打错误日志。早期版本是静默 return，
 * 表现为"只有位移、姿势不变"，排查了很久。
 */
const FRAME_FILES = {
  awake: 'idle_pillow_awake',
  patHappy: 'idle_pillow_pat',      // AI 生成的：被摸头时眯眼享受
  eat: 'idle_pillow_eat',           // AI 生成的：啃小鱼干
  stretch: 'idle_pillow_stretch',   // AI 生成的：伸懒腰
  angry: 'idle_pillow_angry',       // AI 生成的：生气（鼓腮帮子）
  angryBlock: 'idle_pillow_angry_block', // AI 生成的：挡住头（不给摸了）
  blink: 'idle_pillow_blink',
  drowsy: 'idle_pillow_drowsy',
  sleep: 'idle_pillow_sleep',
  startle: 'idle_pillow_startle',
  wave1: 'idle_pillow_wave_1',
  wave2: 'idle_pillow_wave_2',

  work0: 'working_0',
  work1: 'working_0_1',
  work2: 'working_1',
  work3: 'working_1_2',
  work4: 'working_2',
  work5: 'working_2_3',
  work6: 'working_3',

  needInput: 'need_input',
  // 月薪喵那套有**多帧的「时刻」动作**（打招呼 / 被吵醒）——
  // 鲸鱼娘没有这些帧，用不到就不会加载（缺帧会回退到 awake，不影响她）。
  wave3: 'idle_pillow_wave_3',
  startle2: 'idle_pillow_startle_2',
  startle3: 'idle_pillow_startle_3',
  startle4: 'idle_pillow_startle_4',
  startle5: 'idle_pillow_startle_5',
  startle6: 'idle_pillow_startle_6',

  blocked: 'blocked',

  ready0: 'ready_0',
  ready1: 'ready_1',
  ready2: 'ready_2',
  ready3: 'ready_3',
  ready4: 'ready_4',
  ready5: 'ready_5',
}

/**
 * **每套宠物自己的帧名。**
 *
 * ⚠️ 为什么需要：`FRAME_FILES` 原来是一张**所有形象共用**的表，
 *    而不同形象的帧数和命名完全对不上 ——
 *    鲸鱼娘的 `work1`~`work6` 是"敲键盘"的 6 张，
 *    月薪喵的"工作中"要 **17 张**（007~023），名字必然撞车。
 *
 *    这张表按形象合并进 `FRAME_FILES` —— 加载图片在 `preload()` 里、
 *    早于主进程推 clips，所以必须在**代码里**就分好，不能等运行时。
 *    加新形象只改这一处，`FRAME_FILES` 那份通用表不用动。
 */
const STYLE_FRAMES = {
  'yuexin-miao': {
    // 工作中：手臂上下摆动表示打字（三帧只差手臂的上下偏移）
    miaoWork1: 'miao_work_01', miaoWork2: 'miao_work_02',
    miaoWork3: 'miao_work_03', miaoWork4: 'miao_work_04',
    // 双击打招呼：用户给的 GIF（28 帧，frames/101~128.png）
    greet1: 'greet_01', greet2: 'greet_02',
    greet3: 'greet_03', greet4: 'greet_04',
    greet5: 'greet_05', greet6: 'greet_06',
    greet7: 'greet_07', greet8: 'greet_08',
    greet9: 'greet_09', greet10: 'greet_10',
    greet11: 'greet_11', greet12: 'greet_12',
    greet13: 'greet_13', greet14: 'greet_14',
    greet15: 'greet_15', greet16: 'greet_16',
    greet17: 'greet_17', greet18: 'greet_18',
    greet19: 'greet_19', greet20: 'greet_20',
    greet21: 'greet_21', greet22: 'greet_22',
    greet23: 'greet_23', greet24: 'greet_24',
    greet25: 'greet_25', greet26: 'greet_26',
    greet27: 'greet_27', greet28: 'greet_28',
  },
}

/**
 * 当前宠物形象。
 *
 * 由主进程通过 loadFile 的 query 参数传进来 —— 切换形象只要重新加载窗口，
 * 不需要 IPC 往返，也不用在这里缓存一份"当前形象"的状态。
 * 取不到就退回默认，保证窗口单独打开（比如调试）也能跑。
 */
// ⚠️ **`'big-fish'` 这个兜底要和 `src/main.js` 的 `DEFAULT_STYLE` 一致。**
//    正常路径下主进程一定会用 `?style=` 传过来，这里只在
//    "直接打开渲染层预览页"（`npm run preview`）时才用到 ——
//    但两边不一致的话，预览看到的是另一套形象，很容易误判。
//    `test-mainmenu.mjs` 有一条检查守这个一致性。
const ACTIVE_STYLE = new URLSearchParams(location.search).get('style') || 'big-fish'

/** 逐帧日志。排查动画问题时打开（会明显刷屏）。 */
const LOG_FRAMES = false

// ─────────────────────────── 动画片段 ───────────────────────────

/**
 * 一次跳跃的画面序列。四个不同画面：
 *   起跳 → 顶点（滞空）→ 落地 → 站住
 */
const JUMP_CYCLE = {
  frames: ['ready1', 'ready2', 'ready3', 'ready4'],
  durations: [180, 340, 160, 480],
  offsetY: [-8, -16, 2, 0],
}

/** 庆祝跳几次。一圈约 1.16 秒，5 次约 5.8 秒。 */
const JUMP_TIMES = 5

/**
 * 庆祝跳动用哪几帧。
 *
 * ⚠️ **两套素材的帧数不一样，不能写死。**
 *    · 鲸鱼娘：`ready1`~`ready4` 四张（起跳 / 顶点 / 落地 / 站住）
 *    · 月薪喵：只有 `ready1` = **跳起来举手** —— 下来直接用普通站立 `awake`
 *
 * 判断方式是**素材实际加载到哪一帧**（`images[FRAME_FILES.ready2]`）：
 * 文件不在就加载不到，`images[...]` 是 undefined。
 * 这样加新宠物**不用改代码** —— 有几张就用几张。
 *
 * `offsetY` 负值 = 向上。两帧那套给得大一些，
 * 因为少了中间两帧过渡，幅度小了看不出是"跳"。
 */
function readyCycle () {
  const hasFullJump = Boolean(images[FRAME_FILES.ready2])
  if (!hasFullJump) {
    return { frames: ['ready1', 'awake'], durations: [280, 220], offsetY: [-24, 0] }
  }
  return JUMP_CYCLE
}

/** 庆祝片段：把上面那段周期重复 JUMP_TIMES 次。 */
/**
 * 「工作中」用哪几帧。
 *
 * ⚠️ **两套素材的帧数差了 7 倍，不能写死。**
 *    · 鲸鱼娘：`work0`~`work6` 七张，来回往复 = 敲键盘的循环
 *    · 月薪喵：**只有 `work0` 一张**（身前一台小笔记本）
 *
 * 写死的后果很难看：`work1`~`work6` 加载不到 → `showFrame` 回退到 `awake`
 * → **笔记本一会儿有一会儿没有，整只在闪**。
 *
 * 判断方式和 readyCycle 一样：看 `work2` 有没有真的加载到。
 * 单帧那套靠 `offsetY` 做出"敲键盘"的小节奏 —— 幅度小、频率快，
 * 像手指在动，不像在上下跳。
 */
function workingCycle () {
  const hasFullTyping = Boolean(images[FRAME_FILES.work2])
  if (!hasFullTyping) {
    return {
      frames: ['work0', 'work0', 'work0', 'work0', 'work0', 'work0'],
      durations: [170, 120, 170, 120, 170, 130],
      offsetY: [0, -3, 0, -2, 0, 1],
      loop: true,
    }
  }
  return {
    frames: [
      'work0', 'work1', 'work2', 'work3', 'work4', 'work5',
      'work6', 'work5', 'work4', 'work3', 'work2', 'work1',
    ],
    durations: 220,
    loop: true,
  }
}

/**
 * 取一个片段。**所有按名字查片段的地方都必须走这里。**
 *
 * ⚠️ 为什么不直接 `CLIPS[name]`：
 *    `ready` / `working` 两个片段的**帧数取决于这套素材有几张**，
 *    所以它们是**按需构造**的，不在 `CLIPS` 里。
 *    直接查表会拿到 undefined —— 表现是"未知状态"被静默拒绝，
 *    或者动画不播，而且日志里看不出原因。
 *    实测：给 `working` 写完动态版本后，`setState('working')` 直接被拒了。
 */
/**
 * 把主进程推来的**这套宠物的多帧动画**并进 CLIPS。
 *
 * 为什么要这条通道：`CLIPS` 原来是两套宠物共用的常量，
 * 而"打招呼 / 被吵醒 / 完成"这些动作**每套的帧数和时长都不一样** ——
 * 共用的结果就是第二套必然打架（要么帧数不对，要么在闪）。
 * 现在写在各自的 `manifest.json` 里，主进程读出来推过来。
 *
 * ⚠️ 到达时机是 `did-finish-load`，**可能晚于第一次 setState** ——
 *    所以合完之后如果已经在某个状态里，要**把当前状态重播一遍**，
 *    否则会用着旧的片段一直到下次状态变化。
 */
function applyClips (clips) {
  if (!clips || typeof clips !== 'object') return
  const names = Object.keys(clips).filter((k) => !k.startsWith('$'))
  for (const name of names) {
    const c = clips[name]
    if (!c || !Array.isArray(c.frames) || !c.frames.length) continue
    CLIPS[name] = {
      frames: c.frames.slice(),
      durations: Array.isArray(c.durations) && c.durations.length
        ? c.durations.slice()
        : c.frames.map(() => c.durationMs ?? 200),
      ...(Array.isArray(c.offsetY) ? { offsetY: c.offsetY.slice() } : {}),
      ...(Array.isArray(c.offsetX) ? { offsetX: c.offsetX.slice() } : {}),
      loop: c.loop !== false,
      ...(c.holdLast ? { holdLast: true } : {}),
    }
  }
  console.log(`[pet] 收下 ${names.length} 个多帧动画: ${names.join(' ')}`)

  // 已经在某个状态里 → 立刻用新片段**重播动画**，别等下次状态变化。
  //
  // ⚠️ **不要调 setState()。** setState 会 reportState（气泡那边会当成
  //    "重新进入这个状态"、把升级计时清掉），needInput 还会**再响一声** ——
  //    而这里只是换了动画定义，状态本身没变。所以只重播动画，不碰状态机。
  if (!logicalState) return
  if (logicalState === 'idle') playIdleChain()
  else playClip(logicalState)
}

function clipFor (name) {
  // ⚠️ **顺序很重要：先查 CLIPS。**
  //    `manifest.json` 里写了 clips 的（月薪喵的 ready/wave/startle）
  //    会被 applyClips 放进 CLIPS —— 那是**素材自带的定义，优先**。
  //    内置的 readyClip()/workingCycle() 只是**没写 clips 时的兜底**
  //    （老素材、或者只有单帧的 working）。
  if (CLIPS[name]) return CLIPS[name]
  if (name === 'ready') return readyClip()
  if (name === 'working') return workingCycle()
  return undefined
}


function readyClip () {
  // 素材自己声明了 ready 就用它的（见 clipFor）
  if (CLIPS.ready) return CLIPS.ready
  return repeatCycle(readyCycle(), JUMP_TIMES, { loop: false })
}


/** 把一段周期重复 times 次，拼成一个不循环的片段。 */
function repeatCycle (cycle, times, extra = {}) {
  const rep = (arr) => Array.from({ length: times }, () => arr).flat()
  return {
    frames: rep(cycle.frames),
    durations: rep(cycle.durations),
    offsetY: rep(cycle.offsetY),
    ...extra,
  }
}

/**
 * 待机动画链。
 *
 * 【为什么需要】
 * 原来 idle 是固定的 4 帧循环：睁眼 2.7s → 眨 0.14s → 睁眼 1.8s → 眨 0.12s，
 * **精确到毫秒地重复**。看久了就是个 GIF —— 一眼能看出是循环。
 *
 * 现在改成：每次播完一小段，**按权重抽下一段**。
 * 权重高的常出现，权重低的是"惊喜"。于是"她什么时候眨眼"变得不可预测。
 *
 * 【关键】`awake` 的时长写成区间 [2200, 4400] 随机 ——
 * 光这一条就消掉了大部分机械感。
 *
 * 做法参考 PC2005-cloud/dsh-pet 的 animationWeights（MIT）。
 * 全部节点都标 `holdLast`：每个节点是一个完整小动作，播完才轮到下一个。
 */
const IDLE_CHAIN = [
  // 常态：睁着眼，时长随机
  { name: 'awake', weight: 10, clip: {
    frames: ['awake'], durations: [[2200, 4400]], loop: false, holdLast: true } },
  // 快速眨眼
  { name: 'blink', weight: 6, clip: {
    frames: ['blink'], durations: [130], loop: false, holdLast: true } },
  // 缓慢眨眼 —— 满足 / 慵懒的样子，比快速眨眼耐看
  { name: 'slowBlink', weight: 3, clip: {
    frames: ['blink'], durations: [320], loop: false, holdLast: true } },
  // 连眨两下
  { name: 'blinkTwice', weight: 2, clip: {
    frames: ['blink', 'awake', 'blink'], durations: [110, 150, 130], loop: false, holdLast: true } },

  // ── 下面两个是"时刻"动作，权重刻意压到 1 ──
  // 它们比眨眼长得多（2 秒左右），权重给高了会显得她"一直在吃"或"一直在伸懒腰"。
  // 按当前权重（10+6+3+2+1+1=23）算，各约 4.3% —— 平均每 30~40 秒出现一次。
  // 时长也做成区间：固定值会让重复出现时显得机械。
  { name: 'eat', weight: 1, clip: {
    frames: ['eat'], durations: [[1800, 2600]], loop: false, holdLast: true } },
  { name: 'stretch', weight: 1, clip: {
    frames: ['stretch'], durations: [[2000, 3000]], loop: false, holdLast: true } },
]

const CLIPS = {
  /**
   * 空闲：**只是链上的一环**，真正的待机由 playIdleChain() 驱动。
   * 保留它是为了兜底 —— 任何直接 playClip('idle') 的地方仍然能工作。
   */
  idle: {
    frames: ['awake', 'blink', 'awake', 'blink'],
    durations: [2700, 140, 1800, 120],
    loop: true,
  },

  /**
   * 挥手：悬停或点击时播一次，然后回到 idle。
   * 上游原版 5 帧约 0.6 秒，实测"只是举起又放下"，太短；
   * 这里把手挥的往复做两轮，约 0.95 秒。
   */
  wave: {
    frames: ['awake', 'wave1', 'wave2', 'wave1', 'wave2', 'wave1', 'awake'],
    durations: [80, 130, 180, 130, 180, 120, 100],
    loop: false,
  },

  /**
   * 困倦：进入睡眠前的过渡。
   * ⚠️ holdLast 必需 —— 单帧片段不加它，这一帧只显示约 16ms，等于没有。
   */
  /**
   * 打瞌睡。
   *
   * ⚠️ **单帧，而且不要加位移。** 两条都是作者定的：
   *
   *   1. 瞌睡时**不要上下浮动** —— 那时她只是"眼皮沉"，人还没睡过去，
   *      头一点一点地看着很怪。**浮动留给睡着（sleep）**，那才是呼吸。
   *   2. **不要写成"3 帧同一张图"** —— 那样代码上看像有动画，
   *      实际每一帧长得一模一样，**完全是定格的**。
   *      演示页会把它标成「静止」，那是诚实的；写 3 帧是骗自己。
   *
   * 从一个状态过渡到另一个状态，**换一张图**本身就是交代 ——
   * 不需要假装有中间帧。（`selfTestFakeMotion` 会盯着这类假动画。）
   */
  drowsy: { frames: ['drowsy'], durations: [1000], loop: false, holdLast: true },

  /**
   * 睡着：持续，直到被叫醒。
   *
   * ⚠️ **两帧用同一张图**，靠 `offsetY` 做出呼吸的起伏。
   *    原来是单帧 1000ms 循环 —— 一张完全静止的图，
   *    **长时间挂机时看起来像"卡住了"而不是"睡着了"**。
   *
   * 起伏只有 3px：睡着是安安静静的，动作大了就变成"抽搐"了。
   * 呼吸比心跳慢，所以一个来回 2 秒左右。
   */
  sleep: {
    frames: ['sleep', 'sleep', 'sleep', 'sleep'],
    // 吸 → 停 → 呼 → 停。中间那两帧长一点，读起来才像呼吸而不是抖动。
    durations: [520, 480, 520, 480],
    offsetY: [0, -3, 0, 0],
    loop: true,
  },

  /**
   * 惊醒：被叫醒的那一下。同样需要 holdLast。
   *
   * 原来是 420ms —— **太短了，一眨眼就过去**，用户往往只看到"她忽然换了张脸"。
   * 惊醒是个有冲击力的瞬间，值得多留一会儿。
   * 顺便加一点回弹：先弹起来，再落回去。
   */
  startle: {
    frames: ['startle', 'startle', 'startle'],
    durations: [340, 260, 300],
    offsetY: [-5, -2, 0],
    loop: false,
    holdLast: true,
  },

  /*
   * 余额分档表情。
   *
   * 现在播余额气泡时她会**顺便做个表情** —— 光一串数字没有情绪，
   * 分档之后"余额告急"是看得出来的。
   *
   * ⚠️ 用现有帧，不需要新素材：
   *   充足 → awake（常态）
   *   偏低 → drowsy（有点担心）
   *   告急 → blocked（愁眉苦脸）
   *
   * 1.6 秒够看清，又不至于卡在那儿。
   */
  /**
   * 被摸头时的表情（AI 生成）。
   *
   * 为什么需要它：摸头原本只有 CSS 的 scale 下压 + 冒爱心，
   * **她本人的表情一点没变** —— 从外面看像是"图在动"而不是"她在享受"。
   * 这张帧的呆毛明显被压弯，是"被摸头"最直观的视觉信号。
   *
   * ⚠️ **单帧。** 作者定过两条：
   *   · **不要上下浮动** —— 手还按在她头上，人却上下动，像在被按弹簧
   *   · **不要写成"3 帧同一张图"** —— 那是假动画（见 `selfTestFakeMotion`）
   *
   * 摸头的反馈已经有三层了：CSS 的 scale 下压、冒爱心、这张表情。
   * 单帧 + holdLast：停在这一帧，直到 `showPatFace` 的定时器把她切回去。
   */
  patHappy: { frames: ['patHappy'], durations: [1200], loop: false, holdLast: true },

  /**
   * 生气（AI 生成）。
   *
   * 替换掉原来的做法：以前是 CSS 的 rotate 左右摆动 `.sulking`，
   * **她本人的表情一点没变** —— 看起来像"图在晃"而不是"她在生气"。
   * 和摸头表情是同一类问题，所以用同一套办法解决。
   */
  angry: {
    // **两帧**：先鼓腮生气，再双手护住头顶。
    //
    // 为什么要第二帧：只有鼓腮那一张时，冷却期在视觉上是"没反应" ——
    // 用户分不清"她在闹脾气"还是"摸头坏了"。有了护头动作，
    // 「不给摸了」这件事就写在动作上了。
    //
    // 时长：400 + 2100 ≈ 2500ms，和 petPat 的 GRUMPY_MS 对齐。
    // 第二帧的 2100 只是"到点该恢复了"，实际由 showAngryFace 的定时器接管
    // （holdLast 会停在这一帧，不会被 onDone 提前切走）。
    frames: ['angry', 'angryBlock'],
    durations: [400, 2100],
    loop: false,
    holdLast: true,
  },

  balanceOk: { frames: ['awake'], durations: [1600], loop: false, holdLast: true },
  balanceLow: { frames: ['drowsy'], durations: [1600], loop: false, holdLast: true },
  balanceCritical: { frames: ['blocked'], durations: [1600], loop: false, holdLast: true },

  /**
   * 工作中。
   *
   * ⚠️ **不在这里静态定义** —— 帧数取决于这套素材有几张（见 workingCycle）。
   *    写成静态的会在加载时求值，那时 `images` 还没初始化（暂时性死区），
   *    整个脚本会抛错、应用起不来（`ready` 已经踩过一次）。
   */
  // ⚠️ working **不在这里** —— 它是按需构造的，见 clipFor()

  /** 需要人工确认：站着举双手 + 头顶问号 */
  /**
   * 需要人工确认 —— **这个产品存在的理由**（她举手告诉你"要你看一眼"）。
   *
   * ⚠️ **保持静止，不要加位移。** 作者明确要求过两次：
   *    先是 AI 生成的"招手"帧（会把头顶的问号擦掉），
   *    然后是左右位移版的招手 —— 都不要。
   *
   *    她的表达已经够清楚了：**举着手 + 头顶一个问号**。
   *    再加晃动反而像是在"催"，而"需要确认"本身不该带催促的情绪
   *    （催促交给台词，话术文件里有 30s / 2m / 5m / 10m 四档升级）。
   *
   * 单帧循环：进这个状态就停在这儿，直到状态变了。
   */
  needInput: { frames: ['needInput'], durations: [1000], loop: true },

  /** 阻塞 / 出错：坐着 + 头顶 ... */
  blocked: { frames: ['blocked'], durations: [1000], loop: true },

  /**
   * 完成 / 庆祝：**连跳 + 落地站住**，跳固定的次数。
   *
   * ⚠️ 这个片段本身就是庆祝动作，**不再另开一个"庆祝循环"**。
   *
   * 踩过的坑：以前 setState('ready') 播一个 ready 循环、celebrate() 又开一个
   * 庆祝循环，两个用不同的计时器同时改帧。结果 DSH 一推 working（比如我在跑命令），
   * 就出现 ready 和 work 帧交替 —— 表现为「跳起来、落下来变成坐着敲键盘的姿势」。
   * 现在只有一个帧循环，任何状态切换都会干净地把它替换掉。
   *
   * 一圈 1.16 秒：起跳 .18 → 顶点 .34 → 落地 .16 → **站住 .48**。
   * 「站住」给足 480ms 是有意的 —— 短了看不清她落地了。
   *
   * offsetY 把原画 14px 的弹跳放大到约 26px，否则读不出跳跃。
   * 不含 ready0：那一帧蹲得低、手臂收拢，混在循环里容易误读成坐姿。
   */
  // ⚠️ ready **不在这里静态定义** —— 它的帧数取决于这套素材有几张（见 readyClip）。
  //    写成静态的会在加载时求值，那时 images 还没初始化（暂时性死区），整个脚本会抛错。
}

// 把待机链上的节点注册进 CLIPS，这样 playClip 能直接播
for (const node of IDLE_CHAIN) CLIPS[node.name] = node.clip

/**
 * 按权重抽一个链上节点。
 * @param {object} weights 可覆盖默认权重（用来做"闲置越久越困"这类调节）
 */
function pickIdleNode (weights = {}) {
  // ⚠️ `= {}` 不能省。playIdleChain 是无参调用的，
  // 少了默认值就会 `undefined[n.name]` 直接抛错 —— 自检第一次跑就抓到了。
  const w = (n) => weights[n.name] ?? n.weight
  const total = IDLE_CHAIN.reduce((sum, n) => sum + w(n), 0)
  let r = Math.random() * total
  for (const n of IDLE_CHAIN) {
    r -= w(n)
    if (r <= 0) return n
  }
  return IDLE_CHAIN[0]
}

/**
 * 跑一步待机链：播一个节点，播完自动接下一个。
 *
 * ⚠️ 用 onDone 串起来（而不是另开定时器）是有意的 ——
 * 状态一变，setState 会 playClip 新的片段，把 frameTimer 清掉，
 * **onDone 就永远不会触发，链自动断掉**。不需要额外的取消逻辑。
 */
function playIdleChain () {
  if (logicalState !== 'idle' || isAsleep) return
  const node = pickIdleNode()
  // 和逐帧日志同一个开关。待机链是"看不出 bug"的那类功能 ——
  // 出问题只表现为"她眨眼有点怪"，没有日志根本没法查。
  if (LOG_FRAMES) console.log(`[pet] 待机链 → ${node.name}`)
  playClip(node.name, { onDone: playIdleChain })
}

/** 哪些状态是"可以待着不动"的（用于判断该不该触发睡眠） */
const SETTLED_STATES = new Set(['idle', 'sleep'])

// ─────────────────────────── 行为参数 ───────────────────────────

const TIMING = {
  greetingDelayMs: 500,   // 启动后多久打个招呼
  sleepDelayMs: 40000,    // 多久没人理 → 困倦 → 睡着
  waveCooldownMs: 1200,   // 两次挥手之间的最短间隔，避免疯狂点击时抽风
}

/** 尊重系统的「减少动态效果」：开了就不做任何位移。 */
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ─────────────────────────── 运行时 ───────────────────────────

const el = document.getElementById('pet')

/** 预加载好的 Image 对象，避免切帧时闪 */
const images = {}

/** 这套素材里没加载到的文件。**不是错误**（见 preload 里的说明），只用来汇总。 */
const MISSING_FILES = []
let loadedCount = 0

/** 当前播放的片段名与帧号 */
let currentClip = null
let frameIndex = 0
let frameTimer = null

/** 被外部（插件）要求显示的状态 */
let logicalState = 'idle'

/** 睡眠子状态 */
let isAsleep = false
let sleepTimer = null

let lastWaveAt = 0

/**
 * 各帧的包围盒（主进程发过来），摸头判头顶用。
 * 拿不到就退回一个保守的默认值，摸头仍能用，只是不那么准。
 */
let frameBounds = {}
let currentFrameName = null
/** 诊断用：上一次头顶判定的结果，只在翻转时打日志 */
let lastOnHeadLogged = null
/** 诊断用：压在宠物上的移动次数 */
let moveOnPetCount = 0

// ─────────────────── 命中测试（alpha 通道）───────────────────
//
// 为什么需要它：`#pet` 是 width:100%，整个窗口都是这个 <img> 的盒子。
// 浏览器的命中测试**只看元素盒子，不看像素** —— 鼠标落在完全透明的区域
// 也会被判定为"在宠物身上"，窗口就不穿透了。
//
// 解法：把当前帧画到离屏 canvas，取回 alpha 通道，用鼠标位置查表。

const HIT_SIZE = 512
const HIT_ALPHA_MIN = 24        // 与构建流水线用的 alphaThreshold 保持一致
const hitCanvas = document.createElement('canvas')
hitCanvas.width = HIT_SIZE
hitCanvas.height = HIT_SIZE
const hitCtx = hitCanvas.getContext('2d', { willReadFrequently: true })
let hitMask = null

function buildHitMask (logicalName) {
  const img = images[FRAME_FILES[logicalName]]
  if (!img) return
  hitCtx.clearRect(0, 0, HIT_SIZE, HIT_SIZE)
  hitCtx.drawImage(img, 0, 0, HIT_SIZE, HIT_SIZE)
  hitMask = hitCtx.getImageData(0, 0, HIT_SIZE, HIT_SIZE).data
}

/** 该屏幕坐标是否压在宠物的不透明像素上（带 1px 容差） */
function isOpaqueAt (clientX, clientY) {
  if (!hitMask) return false
  const rect = el.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false

  const px = Math.floor(((clientX - rect.left) / rect.width) * HIT_SIZE)
  const py = Math.floor(((clientY - rect.top) / rect.height) * HIT_SIZE)
  if (px < 0 || py < 0 || px >= HIT_SIZE || py >= HIT_SIZE) return false

  // 3×3 邻域取最大 alpha：给边缘一点容差，否则细描边很难点到
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = px + dx
      const y = py + dy
      if (x < 0 || y < 0 || x >= HIT_SIZE || y >= HIT_SIZE) continue
      if (hitMask[(y * HIT_SIZE + x) * 4 + 3] > HIT_ALPHA_MIN) return true
    }
  }
  return false
}

// 把**这套宠物自己的帧名**并进通用表（见 STYLE_FRAMES 的说明）
Object.assign(FRAME_FILES, STYLE_FRAMES[ACTIVE_STYLE] ?? {})

// ─────────────────────────── 加载 ───────────────────────────

function preload () {
  const names = Object.values(FRAME_FILES)
  return Promise.all(names.map((file) => new Promise((resolve) => {
    const img = new Image()
    img.onload = () => { images[file] = img; loadedCount += 1; resolve(true) }
    // ⚠️ **加载失败不逐条报错。**
    //    `FRAME_FILES` 是所有形象**共用**的一张表 —— 里面既有鲸鱼娘专有的帧
    //    （work1~work6、ready0/4），也有月薪喵专有的（wave3、startle2~6）。
    //    任何一套都必然缺别人那几张，那不是错误、是设计。
    //    逐条 console.error 的结果是：换一套形象先刷 8 行红字，
    //    真正的错误反而被淹掉。所以只累计，最后汇总一行（见 selfTestAssets）。
    img.onerror = () => { MISSING_FILES.push(file); resolve(false) }
    // 单文件演示版（tools/build-demo.mjs）把图片内联成 data URI，
    // 按形象分开放进 __DEMO_ASSETS —— 仓库里跑的时候它是 undefined，走文件路径。
    const demo = globalThis.__DEMO_ASSETS?.[ACTIVE_STYLE]
    img.src = demo?.[file] ?? `../../assets/${ACTIVE_STYLE}/${file}.webp`
  })))
}

// ─────────────────────────── 播放器 ───────────────────────────

function durationAt (clip, index) {
  const d = clip.durations
  const v = Array.isArray(d) ? (d[index] ?? d[d.length - 1] ?? 200) : d
  // 时长写成 [min, max] 就在区间里随机 ——
  // 这是让待机"不像 GIF"的关键：固定毫秒数的循环看久了就是机械的。
  if (Array.isArray(v)) return v[0] + Math.random() * (v[1] - v[0])
  return v
}

/**
 * 逐帧垂直平移。
 *
 * 原画的弹跳只有约 14 个屏幕像素，读不出"在跳"；加位移后约 26px。
 * 只做 translateY —— 不缩放不旋转。那不是"把画面拉变形"，是 2D 精灵动画的常规手法。
 */
/**
 * 应用当帧的位移。
 *
 * `offsetY` 是上下（呼吸、点头、弹跳），`offsetX` 是左右（**招手**）。
 * 两者可以同时用，也可以单用。
 *
 * ⚠️ `prefersReducedMotion` 开着时**整个跳过** —— 这是有意的（无障碍）。
 */
function applyOffset (clip, index) {
  const hasX = Array.isArray(clip.offsetX)
  const hasY = Array.isArray(clip.offsetY)
  if (prefersReducedMotion || (!hasX && !hasY)) {
    el.style.transform = ''
    return
  }
  const dx = hasX ? (clip.offsetX[index] ?? 0) : 0
  const dy = hasY ? (clip.offsetY[index] ?? 0) : 0
  const parts = []
  if (dx !== 0) parts.push(`translateX(${dx}px)`)
  if (dy !== 0) parts.push(`translateY(${dy}px)`)
  el.style.transform = parts.join(' ')
}

function showFrame (logicalName) {
  const file = FRAME_FILES[logicalName]
  if (!file) {
    // 早期版本这里静默 return，导致"只有位移、姿势不变"排查了很久。
    console.error(`[pet] 未知的帧逻辑名: ${logicalName}（可用: ${Object.keys(FRAME_FILES).join(', ')}）`)
    return
  }
  let img = images[file]
  if (!img) {
    // ⚠️ **缺帧要能回退，不能直接 return。**
    //
    //    做一套新宠物是**边做边看**的：素材只做了一半就想切过去看效果。
    //    原来这里 return 掉，表现是"某些动作突然卡住不动"，而且只有控制台一行错 ——
    //    用户看到的是「坏了」而不是「还没做」。
    //
    //    回退到 `awake`：它是每套宠物都必须有的基准帧，姿势最中性，
    //    顶替任何一个动作都不会太怪。
    const fallback = images[FRAME_FILES.awake]
    if (!fallback) {
      console.error(`[pet] 帧资源未加载: ${file}（连 awake 都没有，这套素材是空的）`)
      return
    }
    if (!MISSING_FRAMES.has(logicalName)) {
      MISSING_FRAMES.add(logicalName)
      console.warn(`[pet] 缺帧 ${logicalName}（${file}.webp）→ 用 awake 顶替`)
    }
    img = fallback
  }
  currentFrameName = logicalName
  if (LOG_FRAMES) console.log(`[pet] 帧 ${logicalName}`)
  if (el.src !== img.src) el.src = img.src
  // 命中掩码必须跟着当前帧走，否则挥手时手抬起来的地方点不到
  buildHitMask(logicalName)
}

function playClip (name, { onDone } = {}) {
  // ready 是按素材动态决定的（两帧还是四帧），所以在这里按需构造。
  // ⚠️ **ready 要动态取** —— 它的帧数取决于这套素材有几张（见 readyClip）。
  //    原来写在 CLIPS 里是静态的，加载时就求值，那时 images 还没初始化
  //    （暂时性死区），整个脚本会抛错、应用起不来。实测踩到。
  // ⚠️ ready / working 都要**按需构造**（帧数由素材决定，见各自的 Cycle 函数）。
  //    写成静态常量会在加载时求值 —— 那时 images 还没初始化（暂时性死区），
  //    整个脚本抛错、应用起不来。实测踩到过。
  const clip = clipFor(name)
  if (!clip) {
    console.warn('[pet] 未知动画片段:', name)
    return
  }

  currentClip = name
  frameIndex = 0
  clearTimeout(frameTimer)

  const step = () => {
    showFrame(clip.frames[frameIndex])
    applyOffset(clip, frameIndex)

    const isLast = frameIndex >= clip.frames.length - 1
    const delay = durationAt(clip, frameIndex)

    if (isLast && !clip.loop) {
      // ⚠️ `holdLast` 是给**单帧片段**用的。
      //
      // 默认（不加这个标记）最后一帧不等时长就 onDone —— 这对 wave / ready
      // 是对的：它们的最后一帧是"站定姿势"，立刻切走没有视觉损失。
      //
      // 但对 drowsy / startle 这种**只有一帧**的片段就是 bug：
      // 那一帧只显示一帧的时间（约 16ms）就被换掉，**等于看不见**。
      // （推演确认过：drowsy 的 650ms、startle 的 420ms 全都没用上。）
      if (clip.holdLast) {
        frameTimer = setTimeout(() => { if (onDone) onDone() }, delay)
      } else if (onDone) {
        onDone()
      }
      return
    }

    frameIndex = isLast ? 0 : frameIndex + 1
    frameTimer = setTimeout(step, delay)
  }

  step()
}

// ─────────────────────────── 状态机 ───────────────────────────

/** 对外主入口：设置宠物应处的状态 */
function setState (state) {
  if (!clipFor(state)) {
    console.warn('[pet] 未知状态:', state)
    return
  }
  // 日志带中文名（映射在 src/state-labels.js，靠 index.html 的 script 标签引入）
  // ⚠️ **别在这里写尖括号的 script 标签。** src/renderer/pet.js 会被
  //    tools/build-demo.mjs **整段内联**进演示页的 script 块 —— 而 HTML 解析器
  //    一看到那个词就会把脚本**从中间截断**，产物里 pet.js 被劈成两半、
  //    报两个没头没脑的 SyntaxError。实测踩到过。
  const zh = (x) => (globalThis.STATE_LABELS?.[x] ?? x)
  console.log(`[pet] 状态 → ${zh(state)}  (之前 ${zh(logicalState)})`)

  // 「需要确认」时响一声。
  //
  // 为什么这一个状态值得加声音：她是 focusable:false 的置顶窗口，
  // 可能被别的应用盖住、你也可能根本没在看屏幕。
  // **举双手要你正好看过去，声音不用。** 这是这个功能唯一的理由。
  //
  // 只在「进入」时响（下面那个 return 之后不会再走到这里），
  // 不会因为状态重复推送而连响。
  if (state === 'needInput') window.petSounds?.play('needInput')
  if (state !== 'ready') readyUntil = 0
  el.style.transform = ''      // 离开上一状态时清掉它的位移，别停在半空
  logicalState = state

  // 报给主进程 → 气泡据此挑话。渲染层不管气泡的事。
  window.pet.reportState?.(state)

  // ⚠️ **睡着是一个真状态**，别再无条件清 isAsleep —— 那会让"睡着了"这件事
  //    在状态机里立刻消失。只有进入 sleep 时置 true，离开时由 wakeUp 清。
  isAsleep = (state === 'sleep')
  if (state !== 'sleep') scheduleSleep()
  else clearTimeout(sleepTimer)

  // ready 是不循环的：跳完固定次数自己回 idle，不依赖插件推 idle
  // （插件那边有个更长的兜底 READY_HOLD_MS，防止它掉线时卡住）
  if (state === 'ready') playClip('ready', { onDone: () => setState('idle') })
  else if (state === 'idle') playIdleChain()
  else playClip(state)
  // ⚠️ 睡着时**不要**清 isAsleep —— 见上面的 `isAsleep = false`。
  //    这里显式再置一次，因为 setState('sleep') 会先把它清掉。
  if (state === 'sleep') isAsleep = true
}

/** 40 秒没交互 → 困倦 → 睡着 */
function scheduleSleep () {
  clearTimeout(sleepTimer)
  if (isAsleep) return
  sleepTimer = setTimeout(() => {
    if (!SETTLED_STATES.has(logicalState)) return
    // 开始困倦 = 进入"要睡了"这一段，同样重置气泡计时器：
    // idle 的升级台词（40s 困倦 / 52s 睡着 / 2m 说梦话）就是照着这个时间轴写的，
    // 计时器一旦和动画错位，说的话就对不上了。
    window.pet.reportState?.('idle', { restart: true })
    playClip('drowsy', { onDone: () => { isAsleep = true; setState('sleep') } })
  }, TIMING.sleepDelayMs)
}

/**
 * 被叫醒：**立刻**回到 idle，再播一段惊醒动画（纯视觉）。
 *
 * ⚠️⚠️ **状态必须同步改，不能等 startle 播完。**
 *
 *    原来是 `playClip('startle', { onDone: () => setState('idle') })` ——
 *    状态要等动画结束才变。但调用方（双击 / 摸头 / 悬停）**紧接着就会
 *    playClip 别的动画**，把 startle 顶掉：
 *
 *        startle 被顶掉 → onDone 永不触发 → logicalState 一直停在 'sleep'
 *        → 那个动画播完回到 back（= 'sleep'）→ **又睡了**
 *
 *    用户报的就是这个：「睡着状态时，双击/摸头后都是继续睡」。
 *
 *    现在改成：
 *      1. 先 `setState('idle')` —— 同步、立刻生效，
 *         顺带 reportState（气泡会当成"醒来了"）和 scheduleSleep（**重新计时**）
 *      2. 再播 startle 当视觉 —— 它是"惊醒一下"的效果，被打断也无所谓
 *
 *    这样三条调用路径**都不用改**：状态已经是 idle 了，
 *    它们各自的 playClip 顶掉 startle 也没关系。
 *
 *    需求原话：「有交互后都醒来，后续没有动作再继续计时，
 *              到达睡觉时长再触发瞌睡和睡觉」——
 *    `setState('idle')` 里的 scheduleSleep() 就是那个"重新计时"。
 */
function wakeUp () {
  clearTimeout(sleepTimer)
  if (!isAsleep) { scheduleSleep(); return }
  isAsleep = false

  // ① 状态机先切（同步）
  setState('idle')
  // ② 惊醒动画只是视觉，随时可以被调用方顶掉
  playClip('startle', { onDone: () => { if (logicalState === 'idle') playIdleChain() } })
  console.log('[pet] 被叫醒 → idle（睡眠计时重新开始）')
}

/**
 * 并发会话角标。
 *
 * 【什么时候显示】**在跑的会话数 ≥ 2 时才显示。**
 * 只有她自己在跑的时候不显示 —— 那是常态，一直挂个"1"是噪音。
 * 显示出来就说明「除了这个，还有别的在跑」。
 *
 * 数字变化时弹一下（重加 class + 强制 reflow），不然悄悄就变了看不出来。
 */
let badgeCount = 0
function showSessionBadge (count) {
  const el = document.getElementById('badge')
  if (!el) return
  const n = Number(count) || 0
  const changed = n !== badgeCount
  badgeCount = n

  if (n < 2) {
    el.classList.remove('show')
    return
  }

  el.textContent = String(n)
  el.classList.add('show')
  if (changed) {
    el.classList.remove('pop')
    void el.offsetWidth
    el.classList.add('pop')
  }
}

/**
 * 播一次余额分档表情，播完回到待机链。
 *
 * ⚠️ 只在 idle 时播 —— working / needInput 承载的是真实工作信息，
 * 不该被一个查询结果的装饰性表情打断（和 wave 同一条规则）。
 */
function showBalanceMood (tier) {
  const clip = { ok: 'balanceOk', low: 'balanceLow', critical: 'balanceCritical' }[tier]
  if (!clip || !CLIPS[clip]) return
  if (logicalState !== 'idle') {
    console.log(`[pet] 余额表情跳过（当前 ${logicalState}）`)
    return
  }
  playClip(clip, { onDone: playIdleChain })
}

/**
 * 播一次挥手（悬停 / 点击）。
 *
 * 只在 idle 时插播 —— working / needInput 那些状态承载的是真实工作信息，
 * 不该被一个打招呼的小动作打断。
 */
function wave () {
  // ⚠️ idle 判断必须在 wakeUp() **之前**。
  // 曾经写成先 wakeUp() 再判断，结果在 working / ready 里悬停也会插播"惊醒"动画 ——
  // 那些状态承载真实工作信息，不该被一个打招呼的小动作打断。
  //
  // ⚠️ **但睡着（logicalState === 'sleep'）要放行** ——
  //    否则 `!== 'idle'` 直接把悬停拦在这里，wakeUp() 根本执行不到，
  //    表现就是"睡着一悬停没反应、也叫不醒"。
  if (logicalState !== 'idle' && !isAsleep) return

  const now = Date.now()
  if (now - lastWaveAt < TIMING.waveCooldownMs) return
  lastWaveAt = now

  // 刚被吵醒 vs 本来就醒着，说的话不一样：
  // 前者说"我、我没睡！"，后者说"在的！"
  const wasAsleep = isAsleep

  wakeUp()
  playClip('wave', { onDone: () => playClip('idle') })

  // 时刻：只说话，不改变状态计时。
  // （气泡那边有 20 秒冷却，所以反复悬停不会刷屏）
  const kind = wasAsleep ? 'startle' : 'wave'
  console.log(`[pet] 打招呼（报时刻 ${kind}）`)
  window.pet.reportMoment?.(kind)
}

// ─────────────────────────── 摸头 ───────────────────────────

/**
 * 当前帧的头顶区域（归一化到图片的 0~1）。
 *
 * 取包围盒**顶部往下 32%**、横向取中间 60% —— 头比身体窄，
 * 用整个宽度会让"摸肩膀"也被算成摸头。
 */
function headZone () {
  // ⚠️ 键要用**文件名**，不是逻辑名。
  // 主进程发的表是按 manifest 的键（idle_pillow_awake），
  // 而 currentFrameName 存的是逻辑名（awake）—— 直接查永远查不到，
  // 会静默退回兜底值（摸头就"能摸但位置不对"）。
  const b = frameBounds[FRAME_FILES[currentFrameName]]
  if (!b) {
    // 主进程还没把表发过来，或者表里没这一帧 —— 给个保守值
    return { left: 0.28, right: 0.72, top: 0.02, bottom: 0.30 }
  }
  // **整个头部都要能摸。**
  //
  // 之前只覆盖"包围盒顶部往下 42%、横向 ±38%"，结果能摸的只剩头顶一条窄带 ——
  // 用户日志里 (107,107) 换算成 0.395，而下界是 0.399，**差 0.004 就出界**。
  // 蹭得稍微靠下就不响应，手感像是"时灵时不灵"。
  //
  // 现在：纵向覆盖到 58%（含额头），横向用整个包围盒再各留 2% 余量。
  // 放宽没有副作用 —— 她的窗口本来就小，不会误触到别的东西。
  const top = Math.max(0, b.top - 0.03)              // 含呆毛，再往上留点余量
  const bottom = b.top + b.height * 0.58             // 覆盖整个头 + 额头
  const left = Math.max(0, b.left - 0.02)
  const right = Math.min(1, b.right + 0.02)

  return { left, right, top, bottom }
}

let patter = null
let lastPatAt = 0
let patFaceTimer = 0
let angryTimer = 0
/**
 * 正在跑启动自检。
 *
 * ⚠️ **自检会走完整条摸头链路，那会产生用户可见的副作用。**
 *    实测被用户抓到的现象：每次启动 app 都冒一颗爱心 + 说一句「嘿嘿～」——
 *    因为 selfTestPat 模拟蹭了 8 下，走到了 onReward。
 *
 *    自检本身该留着（它抓到过两个真 bug），但**它不算"用户真的摸了她"**：
 *      · 台词完全不该说 —— 那是纯副作用，没有任何验证价值
 *      · 爱心要验（popHeart 那一环坏过），但**不让用户看见**，见 pet.css 的 #heart.probe
 */
let selfTesting = false

/** 这次运行里缺了哪些帧。只提示一次，不刷屏。 */
const MISSING_FRAMES = new Set()

/** 冒一颗爱心。重加 class + 强制 reflow 才会重播动画。 */
function popHeart () {
  const heart = document.getElementById('heart')
  if (!heart) return
  heart.classList.remove('show')
  void heart.offsetWidth
  heart.classList.add('show')
}

/**
 * 摸头时露出享受的表情，停手后回到常态。
 *
 * 为什么要它：摸头原本只有 CSS 的 scale 下压 + 冒爱心，
 * **她本人的表情一点没变** —— 从外面看像"图在动"而不是"她在享受"。
 * 新加的 idle_pillow_pat 那张帧的呆毛明显被压弯，是"被摸头"最直观的信号。
 *
 * 只在 idle 时覆盖：工作/等待中的表情有它自己的语义，
 * 被摸一下不该把它们盖掉（和 showBalanceMood 是同一个取舍）。
 */
function showPatFace () {
  if (logicalState !== 'idle' || !CLIPS.patHappy) return
  // 两个表情各有自己的"到点恢复"定时器，**必须互相取消** ——
  // 否则先摸头（700ms 后恢复）再生气时，摸头的定时器会中途把生气序列打断。
  // （自检里先撞到了这个：生气第二帧还没接上就被待机链抢走了。）
  clearTimeout(angryTimer)
  playClip('patHappy')            // 单帧 + holdLast：停在这一帧
  // 停手 700ms 后回到待机链。
  // 用 debounce 而不是"摸完就恢复"，是因为连续蹭时 onStroke 会一直触发，
  // 每次都重置计时，表情才不会闪。
  clearTimeout(patFaceTimer)
  patFaceTimer = setTimeout(() => {
    if (logicalState === 'idle') playIdleChain()
  }, 700)
}

/**
 * 乱蹭之后闹脾气：换成生气的表情，冷却结束再回常态。
 *
 * 以前这里是 `el.classList.add('sulking')` —— 一个 CSS 的 rotate 左右摆动。
 * 问题是**她本人的表情没变**，看起来像"图在晃"而不是"她在生气"。
 * 作者明确说这种效果不要，改成换表情。
 *
 * 只在 idle 时覆盖：工作和等待中的表情有自己的语义
 * （和 showPatFace / showBalanceMood 是同一个取舍）。
 */
function showAngryFace (ms) {
  if (logicalState !== 'idle' || !CLIPS.angry) return
  playClip('angry')               // 单帧 + holdLast：停在这一帧
  clearTimeout(angryTimer)
  // 冷却时长由 petPat 决定（它按蹭得太快的程度算），这里只负责到点恢复。
  angryTimer = setTimeout(() => {
    if (logicalState === 'idle') playIdleChain()
  }, ms)
}

function initPat () {
  if (!window.petPat) return
  patter = window.petPat.create({
    el,
    headBounds: headZone,

    // 每蹭一下：她轻轻动一下（按下头的效果由 CSS 做）
    onStroke: (n) => {
      console.log(`[pet] 摸头第 ${n} 下`)
      wakeUp()
      showPatFace()
    },

    // 一轮摸完 / 每 5 下：冒爱心 + 说句话
    onReward: (total) => {
      console.log(`[pet] 摸头奖励（共 ${total} 下）→ 冒爱心`)
      popHeart()
      // 自检模拟的蹭**不算真的摸头** —— 不能说台词。
      // （爱心还是要冒：那一环坏过，自检得验到它，只是藏起来不让用户看见。）
      if (selfTesting) return
      const now = Date.now()
      if (now - lastPatAt < 4000) return   // 别刷屏
      lastPatAt = now
      window.pet.reportMoment?.('pat')
    },

    // 乱蹭：她会生气。这一下是"有脾气"的来源，别去掉。
    onTooFast: (until) => {
      window.pet.reportMoment?.('patAngry')
      // ⚠️ 冷却期间**必须留下反馈**。
      // 之前这段时间是彻底静默的，用户看到的就是"摸头坏了" ——
      // 而不是"她在闹脾气"。这两件事从外面看一模一样。
      clearTimeout(patFaceTimer)  // 否则 700ms 后会把生气的样子盖掉
      showAngryFace(until ?? 2500)
    },
  })
  console.log(`[pet] 摸头已就绪（petPat=${Boolean(window.petPat)} patter=${Boolean(patter)}）`)
}

/**
 * 并发会话角标自检。
 *
 * 验的是"元素在不在、显不显示得对"—— 角标是那种"不出现你也不知道为什么"的功能，
 * 没有自检就只能靠"我看到了/我没看到"来排查。
 */
/**
 * 摸头表情自检。
 *
 * 验三件事：帧资源在不在、showPatFace 会不会改画面、非 idle 状态该不该跳过。
 * 这类"表情"功能没有自检就只能靠"我摸了一下好像变了"来确认 ——
 * 而帧名写错时是**静默**的（showFrame 直接 return），画面不动但不报错。
 */
function selfTestPatFace () {
  const ok = Boolean(CLIPS.patHappy && FRAME_FILES.patHappy && images[FRAME_FILES.patHappy])
  const idle = logicalState === 'idle'
  if (!idle) {
    // 非 idle 时不该覆盖别人的表情 —— 这本身就是一条要验的行为
    const before = currentFrameName
    showPatFace()
    console.log(`[pet] 摸头表情自检: 资源=${ok ? '在' : '缺失'} 状态=${logicalState}`
      + ` 帧 ${before} → ${currentFrameName}`
      + `  ${ok && currentFrameName === before ? '✅ 正确跳过（不覆盖工作中的表情）' : '❌ 不该改'}`)
    return
  }
  // ⚠️ 必须先把画面置于一个**不是** patHappy 的帧上再测。
  // 之前没做这一步，而前一个自检（摸头）恰好已经把它停在 patHappy 了，
  // 于是"变了没有"这个判断是蒙对的 —— 看起来 ✅，其实没验到东西。
  showFrame('awake')
  const before = currentFrameName
  showPatFace()
  const changed = currentFrameName === 'patHappy' && before !== 'patHappy'
  // 顺带验 debounce：停手 700ms 后应该自己回到待机链。
  // ⚠️ **只观察，不要 clearTimeout(patFaceTimer)** ——
  //    那正是 showPatFace 设的恢复定时器，取消掉就永远不会恢复了，
  //    然后"卡住"是必然的，测的是自检自己而不是功能。
  setTimeout(() => {
    const back = currentFrameName !== 'patHappy'
    console.log(`[pet] 摸头表情自检: 停手 700ms 后回到 ${currentFrameName}`
      + `  ${back ? '✅ 会自动恢复' : '❌ 卡在摸头表情上了'}`)
  }, 760)
  console.log(`[pet] 摸头表情自检: 资源=${ok ? '在' : '缺失'}`
    + ` 帧 ${before} → patHappy`
    + `  ${ok && changed ? '✅ 正常' : '❌ 不对'}`)
}

/**
 * 生气表情自检。
 *
 * 和摸头表情那个是同一套写法，也就踩过同一类坑：
 * **必须先把画面置于一个不是 angry 的帧上再测**，否则"变了没有"是蒙对的
 * （前一个自检可能已经把它停在那了）。
 */
function selfTestAngryFace () {
  const ok = Boolean(CLIPS.angry && FRAME_FILES.angry && images[FRAME_FILES.angry])
  const idle = logicalState === 'idle'
  if (!idle) {
    const before = currentFrameName
    showAngryFace(300)
    console.log(`[pet] 生气表情自检: 资源=${ok ? '在' : '缺失'} 状态=${logicalState}`
      + ` 帧 ${before} → ${currentFrameName}`
      + `  ${ok && currentFrameName === before ? '✅ 正确跳过（不覆盖工作中的表情）' : '❌ 不该改'}`)
    return
  }
  showFrame('awake')
  const before = currentFrameName
  const ms = 1200
  showAngryFace(ms)
  const first = currentFrameName === 'angry' && before !== 'angry'
  const hasBlock = Boolean(CLIPS.angry.frames.includes('angryBlock') &&
    images[FRAME_FILES.angryBlock])
  // 第二帧（挡住头）应该在第一帧之后自动接上。
  // 只观察，不 clearTimeout(angryTimer) —— 那正是 showAngryFace 设的恢复定时器，
  // 取消掉就永远不会恢复，"卡住"是必然的。（这个错在摸头那边犯过一次。）
  setTimeout(() => {
    const blocked = currentFrameName === 'angryBlock'
    console.log(`[pet] 生气表情自检: 400ms 后接上第二帧 → ${currentFrameName}`
      + `  ${blocked ? '✅ 挡住头接上了' : '❌ 没接上'}`)
  }, 700)
  setTimeout(() => {
    const back = currentFrameName !== 'angry' && currentFrameName !== 'angryBlock'
    console.log(`[pet] 生气表情自检: 冷却结束后回到 ${currentFrameName}`
      + `  ${back ? '✅ 会自动恢复' : '❌ 卡在生气表情上了'}`)
  }, ms + 80)
  console.log(`[pet] 生气表情自检: 资源=${ok ? '在' : '缺失'}`
    + ` 两帧=${hasBlock ? '齐' : '缺 angryBlock'}`
    + ` 帧 ${before} → angry  ${ok && first && hasBlock ? '✅ 正常' : '❌ 不对'}`)
}

/**
 * offsetY 自检。
 *
 * 这一套是"用同一张图 + 位移做出动画"的做法 —— 现在有四个片段靠它：
 *   drowsy（点头）、sleep（呼吸）、startle（惊醒回弹）、patHappy（蹭一蹭）
 *
 * 它最容易坏的方式是**无声的**：
 *   · offsetY 数组比 frames 短 → 后面几帧 `?? 0` 拿到 0，看着像"没做动画"
 *   · prefersReducedMotion 开着 → applyOffset 直接清空 transform，也是静默的
 * 所以这里两样都验：静态的数组长度，和运行时的实际 transform。
 */
function selfTestOffset () {
  // ① 静态：有 offsetY 的片段，数组长度必须和 frames 对得上
  const bad = []
  for (const [name, clip] of Object.entries(CLIPS)) {
    for (const axis of ['offsetX', 'offsetY']) {
      if (!Array.isArray(clip[axis])) continue
      if (clip[axis].length !== clip.frames.length) {
        bad.push(`${name}.${axis}(${clip[axis].length}≠${clip.frames.length})`)
      }
    }
  }
  console.log(`[pet] 位移自检: ${bad.length ? '❌ 长度对不上: ' + bad.join(' ') : '✅ 所有位移数组和帧数对齐'}`)

  // ② 运行时：sleep 的呼吸真的会改 transform 吗
  // 分开统计两个轴 —— `offsetX` 目前**没有任何片段在用**（needInput 的招手
  // 被作者去掉之后）。不分开报的话，日志上看不出"这个能力是闲置的"。
  const useX = Object.entries(CLIPS).filter(([, c]) => Array.isArray(c.offsetX)).map(([k]) => k)
  const useY = Object.entries(CLIPS).filter(([, c]) => Array.isArray(c.offsetY)).map(([k]) => k)
  console.log(`[pet] 位移自检: 左右 ${useX.length} 个${useX.length ? '（' + useX.join(' ') + '）' : '（没人用）'}`
    + `  上下 ${useY.length} 个（${useY.join(' ')}）`)
  const uses = [...useX, ...useY]
  if (prefersReducedMotion) {
    console.log('[pet] 位移自检: ⚠️ 系统开了"减弱动态效果"，位移被跳过（这是有意的）')
    return
  }
  const seen = new Set()
  for (const [name, clip] of Object.entries(CLIPS)) {
    if (!Array.isArray(clip.offsetX) && !Array.isArray(clip.offsetY)) continue
    for (let i = 0; i < clip.frames.length; i += 1) {
      applyOffset(clip, i)
      seen.add(`${name}:${el.style.transform || 'none'}`)
    }
  }
  el.style.transform = ''
  const moved = [...seen].filter((x) => !x.endsWith(':none'))
  console.log(`[pet] 位移自检: ${uses.length} 个片段用到位移，`
    + `实际产生 ${moved.length} 种不同的 transform  ${moved.length > 0 ? '✅ 生效' : '❌ 全是空'}`)
  if (LOG_FRAMES) moved.forEach((m) => console.log(`[pet]   ${m}`))
}

/**
 * 假动画自检。
 *
 * 「假动画」= **多帧，但全是同一张图，又没有位移** ——
 * 代码上看像有动画，实际每一帧长得一模一样，**完全是定格的**。
 *
 * 实测出过两次：`drowsy` 和 `patHappy` 本来是"3 帧同图 + 位移"，
 * 作者要求去掉上下浮动之后，位移没了、3 帧同图还在，
 * 于是变成两个静止片段，**而代码里看不出来**。
 * 那次是演示页标出「静止」才发现的。
 *
 * 现在退回单帧了。这个自检盯着，防止以后又写出来 ——
 * 真要定格就写 1 帧，别用多帧假装。
 */
/**
 * 素材完整度自检。
 *
 * 做新宠物时素材是**边做边看**的，缺几张很正常 —— 但不能"缺了却不知道"。
 * 缺的帧已经回退到 awake 了（见 showFrame），这里负责**说清楚缺了哪些**，
 * 并给出补齐的命令。
 */
/**
 * 庆祝动作自检：报清楚用的是几帧、怎么跳的。
 *
 * 为什么值得单独自检：庆祝是**两套素材帧数不一样**的唯一一处
 * （鲸鱼娘 4 帧，月薪喵 2 帧），选错了不会报错 ——
 * 只会"跳得很怪"或者"根本没跳"，很难一眼看出来。
 */
/**
 * 「工作中」自检：报清楚用了几帧、在怎么动。
 *
 * 为什么要：`working` 和 `ready` 一样是**按素材自动选帧数**的，
 * 选错了不会报错 —— 只会"笔记本在闪"或者"完全不动"，很难一眼看出来。
 */
function selfTestWorkingClip () {
  const c = clipFor('working')
  const uniq = [...new Set(c.frames)]
  const loaded = uniq.filter((f) => images[FRAME_FILES[f]])
  const y = c.offsetY ?? []
  console.log(`[pet] 工作自检: ${uniq.length} 种画面（${uniq.join(' ')}），`
    + `共 ${c.frames.length} 帧，位移 ${y.length ? `${Math.min(...y)}~${Math.max(...y)}px` : '无'}`)
  // ⚠️ **只有当这个片段是「素材自己声明的」时候才警告缺图。**
  //
  //    踩到的假警告：`test-selftest.cjs` 里没有主进程推 clips，
  //    于是 `clipFor('working')` 走 `workingCycle()` 兜底 —— 那条路**故意**要
  //    `work0`~`work6` 七帧。而**任何一套素材都凑不齐七帧**
  //    （引擎的过渡帧 work1/work3/work5 不是每套都有），
  //    于是每次跑测试都打一行 `⚠️ 有画面没加载到 —— work3 work5 work6`。
  //    **看起来像 bug，其实是兜底路径的正常状态** —— 白查过。
  //
  //    素材**自己声明**的 clips（写进 manifest 的）才是"这几帧必须都在"，
  //    那种情况缺图才是真问题。
  const fromManifest = Boolean(CLIPS.working)
  if (fromManifest && loaded.length < uniq.length) {
    console.warn(`[pet] 工作自检: ⚠️ 有画面没加载到 —— ${uniq.filter((f) => !images[FRAME_FILES[f]]).join(' ')}`
      + '（会回退到 awake，看起来就是"道具在闪"）')
  } else if (!fromManifest) {
    const miss = uniq.filter((f) => !images[FRAME_FILES[f]])
    if (miss.length) {
      console.log(`[pet] 工作自检: ℹ️ 走的是代码兜底（素材没声明 working），`
        + `这套没有 ${miss.join(' ')} —— 正常，兜底路径本来就按七帧设计`)
    }
  }
  if (uniq.length === 1 && (!y.length || Math.min(...y) === Math.max(...y))) {
    console.warn('[pet] 工作自检: ⚠️ 只有一张图又没有任何位移 —— 那就完全静止了')
  }
}

/**
 * 把这套宠物的多帧动画**全列一遍**。
 *
 * 为什么要：`ready` / `wave` / `startle` 这些是**素材自带**的
 * （写在 manifest 的 clips 里，由主进程推过来），
 * 错了一点都不会报错 —— 只会"动作不对"或者"根本不动"。
 * 启动时列清楚：用了哪几张、帧数、时长范围、位移范围、循环与否。
 */
function selfTestClips () {
  // ⚠️ **这里列的是"可能存在"的片段名。**
  //    `greet` 只有月薪喵有；别的形象没有是正常的，不该报警。
  const names = ['ready', 'wave', 'greet', 'startle', 'working', 'sleep']
  for (const name of names) {
    const c = clipFor(name)
    // ⚠️ 没有这个片段**不是错** —— `greet` 只有月薪喵有。
    //    静默跳过就好，打警告只会让人以为坏了。
    if (!c) continue
    const uniq = [...new Set(c.frames)]
    const miss = uniq.filter((f) => !images[FRAME_FILES[f]])
    // ⚠️ `durations` **可以是一个标量** —— 见 `durationAt()`：
    //    `Array.isArray(d) ? d[index] : d`，标量表示"每帧都是这个毫秒数"。
    //    `workingCycle()` 返回的正是 `durations: 220`。
    //    原来这里直接 `Math.min(...durs)` —— 展开一个**数字**会抛
    //    `Spread syntax requires ...iterable[Symbol.iterator] to be a function`，
    //    让整条自检的退出码变成 1（表现是"23 条都过了但进程失败"，很难查）。
    //    先归一成数组再算范围。
    const norm = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]))
    const durs = norm(c.durations)
    const dRange = durs.length
      ? (Array.isArray(durs[0]) ? '每次随机' : `${Math.min(...durs)}~${Math.max(...durs)}ms`)
      : '—'
    const y = norm(c.offsetY)
    console.log(`[pet] 动画自检: ${name.padEnd(8)} ${uniq.length} 种画面 [${uniq.join(' ')}]`
      + `  ${c.frames.length} 帧  ${dRange}`
      + `  位移 ${y.length ? `${Math.min(...y)}~${Math.max(...y)}px` : '无'}`
      + `  ${c.loop ? '循环' : '一遍'}${c.holdLast ? '+停在末帧' : ''}`)
    // ⚠️ 和 `selfTestWorkingClip` 同一个道理：**素材自己声明的 clips 缺图才是问题**；
    //    代码兜底（`CLIPS[name]` 不存在）时缺图是正常的，别报 ⚠️。
    if (miss.length && CLIPS[name]) {
      console.warn(`[pet] 动画自检:   ⚠️ ${name} 有画面没加载到 —— ${miss.join(' ')}`)
    } else if (miss.length) {
      console.log(`[pet] 动画自检:   ℹ️ ${name} 走的是代码兜底，这套没有 ${miss.join(' ')} —— 正常`)
    }
  }
}

function selfTestReadyClip () {
  const c = clipFor('ready')
  const uniq = [...new Set(c.frames)]
  const loaded = uniq.filter((f) => images[FRAME_FILES[f]])
  // ⚠️ 同 selfTestClips：`durations` / `offsetY` 都可能是**标量**（见 durationAt）。
  //    原来这里 `c.durations.reduce(...)` 在标量时会直接抛"不是函数"。
  const norm = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]))
  const y = norm(c.offsetY)
  const jumpY = y.length ? Math.min(...y) : 0
  // 时长写成 `[min,max]` 区间的取中值估算总长
  const total = norm(c.durations)
    .reduce((a, b) => a + (Array.isArray(b) ? (b[0] + b[1]) / 2 : b), 0)

  // ⚠️ **"几趟"的算法取决于有没有位移。**
  //    · 有位移：一趟是"上去再下来"，帧数是 `n*2-1`（1→2→3→2→1）
  //    · 没位移：一趟就是 n 帧（1→2→3→4→5），纯粹换图
  //    原来只有前一种算法 —— 用户把完成庆祝改成"5 帧循环 5 次、不要位移"
  //    之后，25 帧被算成"3 趟"（25/9），日志一眼就看出来不对。
  const perTrip = y.length ? (uniq.length * 2 - 1) : uniq.length
  const trips = Math.round(c.frames.length / perTrip)
  console.log(`[pet] 庆祝自检: ${uniq.length} 种画面（${uniq.join(' → ')}），`
    + `${c.frames.length} 帧 ≈ ${trips} 趟，共 ${(total / 1000).toFixed(1)} 秒，`
    + (y.length ? `最大上跳 ${-jumpY}px  ` : '无位移  ')
    + (c.loop ? '循环' : '一遍'))

  if (loaded.length < uniq.length) {
    console.warn(`[pet] 庆祝自检: ⚠️ 有画面没加载到 —— ${uniq.filter((f) => !images[FRAME_FILES[f]]).join(' ')}`)
  }
  // ⚠️ **只有"有位移却没有负值"才警告。**
  //    完全没位移是**有意的做法**（用户要求纯换图演），不该报。
  if (y.length && jumpY >= 0) {
    console.warn('[pet] 庆祝自检: ⚠️ 有 offsetY 却没有负值 —— 这样不会向上跳')
  }
}

function selfTestAssets () {
  const total = Object.keys(FRAME_FILES).length

  // ⚠️ `FRAME_FILES` 是**所有形象共用**的一张表 —— 里面必然有别人专有的帧
  //    （鲸鱼娘的 work1~work6/ready0/4，月薪喵的 wave3/startle2~6…）。
  //    所以"没加载到"分两种，混在一起报会把真正的错误淹掉：
  //      · **这套声明要用、却没加载到** → 才是问题（那个动作会显示成"站着"）
  //      · **这套本来就没这个动作** → 正常，不用管
  const declared = new Set(['awake'])
  for (const c of Object.values(CLIPS)) {
    if (c && Array.isArray(c.frames)) for (const f of c.frames) declared.add(f)
  }
  const missing = []
  let others = 0
  for (const [logical, file] of Object.entries(FRAME_FILES)) {
    if (images[file]) continue
    if (declared.has(logical)) missing.push(logical)
    else others += 1
  }

  if (!missing.length) {
    console.log(`[pet] 素材自检: ✅ 这套要用的都在`
      + (others ? `（另有 ${others} 张是别的形象专有的，不用管）` : ''))
    return
  }
  console.warn(`[pet] 素材自检: ⚠️ 有 ${missing.length} 张该有却没加载到 —— ${missing.join(' ')}`)
  console.warn('[pet]   这些动作会显示成"站着"（回退到 awake）')
}

function selfTestFakeMotion () {
  const fake = []
  for (const [name, clip] of Object.entries(CLIPS)) {
    const uniq = new Set(clip.frames).size
    const shift = Array.isArray(clip.offsetX) || Array.isArray(clip.offsetY)
    if (clip.frames.length > 1 && uniq === 1 && !shift) {
      fake.push(`${name}(${clip.frames.length} 帧同图)`)
    }
  }
  if (fake.length) {
    console.warn(`[pet] 假动画自检: ❌ 这些片段多帧同图又没位移，实际是定格的: ${fake.join(' ')}`)
    console.warn('[pet]     要么退回 1 帧（诚实），要么加真正的图稿/位移')
  } else {
    console.log('[pet] 假动画自检: ✅ 没有"多帧同图又没位移"的片段')
  }
}

function selfTestBadge () {
  const el = document.getElementById('badge')
  if (!el) {
    console.log('[pet] 角标自检: ❌ #badge 元素不存在')
    return
  }
  const shown = (n) => {
    showSessionBadge(n)
    return el.classList.contains('show')
  }
  const one = shown(1)
  const three = shown(3)
  const text = el.textContent
  const back = shown(0)
  console.log(`[pet] 角标自检: 1个=${one ? '显示' : '隐藏'} 3个=${three ? '显示' : '隐藏'}`
    + ` 文字="${text}" 归零后=${back ? '仍显示' : '已隐藏'}`
    + `  ${!one && three && text === '3' && !back ? '✅ 正常' : '❌ 行为不对'}`)
  badgeCount = 0
  el.classList.remove('show', 'pop')
}

/**
 * 待机动画链自检。
 *
 * 验三件事：
 *   ① 权重分布对不对（抽 4000 次，看实际比例和配置的偏差）
 *   ② awake 的时长是不是真的在随机（固定值就退化成 GIF 了）
 *   ③ 有没有节点被饿死（权重低的也得偶尔出现）
 */
function selfTestIdleChain () {
  const N = 4000
  const counts = {}
  for (let i = 0; i < N; i += 1) {
    const n = pickIdleNode()
    counts[n.name] = (counts[n.name] ?? 0) + 1
  }
  const totalW = IDLE_CHAIN.reduce((a, n) => a + n.weight, 0)
  const rows = IDLE_CHAIN.map((n) => {
    const actual = (counts[n.name] ?? 0) / N
    const expected = n.weight / totalW
    return `${n.name} ${(actual * 100).toFixed(1)}%(期望 ${(expected * 100).toFixed(1)}%)`
  })
  const starved = IDLE_CHAIN.filter((n) => (counts[n.name] ?? 0) === 0).map((n) => n.name)
  console.log(`[pet] 待机链自检: ${rows.join('  ')}`
    + `  ${starved.length === 0 ? '✅ 无节点被饿死' : '❌ 被饿死: ' + starved.join(',')}`)

  // 时长随机性：awake 节点抽 200 次，看有多少个不同的值
  const awake = CLIPS.awake
  const seen = new Set()
  for (let i = 0; i < 200; i += 1) seen.add(Math.round(durationAt(awake, 0)))
  const lo = Math.round(Math.min(...seen))
  const hi = Math.round(Math.max(...seen))
  console.log(`[pet] 待机链自检: awake 时长 ${seen.size} 种取值，范围 ${lo}~${hi}ms`
    + `  ${seen.size > 50 ? '✅ 确实在随机' : '❌ 几乎是固定值（会退化成 GIF）'}`)
  console.log(`[pet] 待机链自检: 链上一共 ${IDLE_CHAIN.length} 个节点`)
}

/**
 * 摸头自检：算出当前帧的头顶区域，取其中点，看能不能判中。
 *
 * 为什么要自检：摸头涉及三处坐标换算（窗口 → 图片 → manifest 归一化），
 * 任何一处错了都表现为"蹭了没反应"，而光看代码很难发现。
 * 这个自检把"几何算得对不对"和"事件有没有来"分开验证。
 */
function selfTestPat () {
  // 这个自检不是临时调试代码，**留着**。
  // 它已经抓到两个真实 bug：
  //   ① 包围盒表的键用了逻辑名而不是文件名
  //   ② 头顶区域含呆毛，一半是空气 → 方向链断掉
  // 两个都表现为"蹭了没反应"，光看代码都发现不了。
  // 它会自己走完整条链路（几何 → 命中测试 → 真实监听器），启动时跑一次。
  if (!patter) return
  selfTesting = true
  // 爱心照常触发（要验 popHeart 那一环），但**藏起来别让用户看见**。
  // 规则在 pet.css 的 #heart.probe。
  const heartEl = document.getElementById('heart')
  heartEl?.classList.add('probe')
  const rect = el.getBoundingClientRect()

  // 图片在窗口里的位置（#stage 是 flex + align-items:flex-end）
  const zone = headZone()
  const px = rect.left + rect.width * ((zone.left + zone.right) / 2)
  const py = rect.top + rect.height * ((zone.top + zone.bottom) / 2)
  const hit = patter.onMove(px, py)

  // ⚠️ 关键一环：真实鼠标要先过 isOpaqueAt() 才能走到 patter.onMove。
  // 上面那行是**直接调用**、绕过了命中测试 —— 所以光看它通过还不够。
  const opaqueThere = isOpaqueAt(px, py)

  console.log(`[pet] 摸头自检: 图片 rect=${Math.round(rect.width)}x${Math.round(rect.height)}`
    + ` @(${Math.round(rect.left)},${Math.round(rect.top)})`
    + `  头顶区域=${JSON.stringify(zone).slice(0, 60)}`
    + `  中点(${Math.round(px)},${Math.round(py)}) → 命中=${hit}  命中测试=${opaqueThere}`
    + (opaqueThere ? '' : '   ⚠️ 命中测试说这里不是不透明像素，真实鼠标走不到！'))

  // 再模拟一次完整的"来回蹭"：在头顶区域内上下移动，每次 20px（> MIN_TRAVEL 8）。
  // 这一步把"几何算得对"和"蹭的检测能触发"分开验证 ——
  // 光看代码很难发现"方向反转条件写错了"这类问题。
  patter.reset()
  let strokes = 0
  const cy = rect.top + rect.height * ((zone.top + zone.bottom) / 2)
  const cx = px
  for (let i = 0; i < 8; i += 1) {
    const y = cy + (i % 2 === 0 ? 20 : -20)
    patter.onMove(cx, y)
  }
  strokes = patter.getStrokes()
  console.log(`[pet] 摸头自检: 模拟来回蹭 8 次 → 计到 ${strokes} 下`
    + `  ${strokes >= 2 ? '✅ 检测正常' : '❌ 检测有问题'}`)
  patter.reset()

  // 最后用**合成 MouseEvent 走一遍真实路径**。
  // 上面都是直接调 patter.onMove，证明不了"window 上的监听器接对了" ——
  // 处理器没注册、注册在别的元素上、被提前 return 掉，都测不出来。
  let handlerStrokes = 0
  const realMove = (x, y) => window.dispatchEvent(
    new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }))
  for (let i = 0; i < 8; i += 1) {
    realMove(cx, cy + (i % 2 === 0 ? 20 : -20))
    if (patter.getStrokes() > handlerStrokes) handlerStrokes = patter.getStrokes()
  }
  console.log(`[pet] 摸头自检: 合成事件走真实监听器 → 计到 ${handlerStrokes} 下`
    + `  ${handlerStrokes >= 2 ? '✅ 处理器已接上' : '❌ 处理器没接上（mousemove 没走到摸头）'}`)

  // 最后一步：等 IDLE_MS 的收尾定时器跑完，看**爱心有没有真的冒出来**。
  // 前面几步都只是"计到了数"，而用户看到的是爱心和台词 ——
  // 中间任何一环断掉（奖励没触发、popHeart 拿不到元素、CSS 没生效）
  // 表现都是"蹭了没反应"，所以这一步不能省。
  // 收尾：验爱心真的冒出来了（看 class，不看 opacity —— probe 期间它不可见），
  // 然后**撤干净**：移除 show 和 probe，放掉 selfTesting。
  // 不撤的话用户会看到自检冒的那颗爱心（以及那句「嘿嘿～」）。
  setTimeout(() => {
    const shown = Boolean(heartEl?.classList.contains('show'))
    console.log(`[pet] 摸头自检: 收尾定时器跑完后 → 爱心 class=${shown}`
      + `  元素存在=${Boolean(heartEl)}`
      + `  ${heartEl && shown ? '✅ 整条链路通' : '❌ 爱心没冒出来'}`)
    heartEl?.classList.remove('show', 'probe')
    patter.reset()
    selfTesting = false
  }, 900)
}

// ─────────────────────────── 交互 ───────────────────────────

let dragging = false
let moved = false
let lastScreen = { x: 0, y: 0 }

/** 是否处于"接管鼠标"状态。只有压在宠物的不透明像素上才接管，其余穿透。 */
let interactive = false

function setInteractive (next) {
  if (next === interactive) return
  interactive = next
  window.pet.setHovering(next)

  // 打招呼**只能在空闲状态**触发。
  //
  // working / needInput / ready / blocked 承载的是真实工作信息，
  // 不该被一个招呼动作打断 —— 那些时候指针压上来只是让窗口接管鼠标
  // （拖得动、点得到），不做任何动画。
  //
  // 这里显式判断一次（wave() 内部也有守卫）：意图写在调用处，
  // 而且能打日志验证 —— 光靠内部的静默 return 排查起来全靠猜。
  // ⚠️ **悬停不再挥手了。**
  //
  // 原来这里调 wave()。加了摸头和双击之后它变成了冲突源：
  //   - 手一进她范围就先挥一次手，**把摸头的下压盖掉**（摸头看起来"没反应"）
  //   - 双击本来也该挥手，但悬停已经挥过了 —— **双击完全看不出来**
  // 日志里"悬停忽略 11 次"和"双击 2 次"同时出现，就是这么回事。
  //
  // 现在：**悬停只负责让窗口接管鼠标**（能拖、能点），不做任何动画。
  // 招手挪到双击 —— 主动做才招手，路过不算，也更像活的。
  if (!next) return
  if (logicalState !== 'idle') {
    console.log(`[pet] 悬停（当前 ${logicalState}，不做动画）`)
  }
}

// 注意：必须监听 window 而不是 #pet。
// 窗口在穿透状态下靠 forward:true 把 mousemove 转发进来，
// 而 #pet 的盒子覆盖整窗，用元素级事件判断不出"像素是否透明"。
window.addEventListener('mousemove', (event) => {
  if (dragging) return
  const opaque = isOpaqueAt(event.clientX, event.clientY)

  // ⚠️ **命中判定要把缩放手柄也算进去。**
  //
  //    手柄画在宠物轮廓的右下方 —— 那里**通常是透明像素**。
  //    如果只认 `isOpaqueAt`，就会出现这个死循环：
  //        鼠标靠近宠物   → opaque=true  → 手柄出现
  //        鼠标移向手柄   → opaque=false → 穿透开启
  //                       → 渲染层收不到 mousemove → hover 丢失 → 手柄消失
  //        鼠标又"在宠物上" → 手柄出现 → …
  //    表现是手柄**一闪一闪**，根本点不到。
  //
  //    加上手柄矩形之后，宠物 ∪ 手柄 是连续的，鼠标走得过去。
  const overHandle = isOverHandle(event.clientX, event.clientY)
  const hot = opaque || overHandle
  noteHoverForHandle(hot)

  // 摸头：不用按键，光标在头顶来回蹭就算。
  // patter.onMove 返回"是否压在头顶"，据此把光标换成小手。
  // ⚠️ 摸头**不看 opaque**。
  //
  // 曾经写成 `opaque ? patter.onMove(...) : false` —— 大错。
  // isOpaqueAt 是给"窗口要不要接管鼠标"用的，**要求像素级精确**；
  // 而摸头需要的是**宽容的区域**。两者混用导致：
  // 头顶呆毛那一圈是透明的（实测那一行只有 3% 是实心像素），
  // 用户最自然的摸头位置恰好就在那儿 —— 判定不断被打断，蹭多少下都没用。
  //
  // 而且实测确认：透明区的 mousemove **照样会到渲染层**
  //（setIgnoreMouseEvents(true, {forward:true}) 会转发），所以根本不需要卡 opaque。
  const onHead = patter?.onMove(event.clientX, event.clientY) ?? false
  if (patter && !onHead) patter.leave()
  // 小手光标跟着"正在被摸"走，不跟 onHead ——
  // onHead 会因为头发缝隙里的透明像素闪来闪去，光标跟着闪会很难看
  el.classList.toggle('petting', Boolean(patter?.isPatting()))

  // 诊断：先确认 mousemove 到底有没有到渲染层、有没有判成"压在宠物上"。
  // 划词那类功能排查过一次才知道：**"事件没来"和"来了但判断失败"
  // 是两条完全不同的排查路径**，得先分清。
  if (opaque) {
    moveOnPetCount += 1
    if (moveOnPetCount % 60 === 0) {
      console.log(`[pet] 已收到 ${moveOnPetCount} 次"压在宠物上"的移动`
        + `  摸头命中=${onHead}  帧=${currentFrameName}`)
    }
  }

  // 摸头不工作时，"到底有没有判进头顶"是最关键的信息。
  // 只在状态翻转时打，不然每次 mousemove 都刷屏。
  if (onHead !== lastOnHeadLogged) {
    lastOnHeadLogged = onHead
    console.log(`[pet] 头顶判定 → ${onHead ? '进入' : '离开'}`
      + `  坐标=(${Math.round(event.clientX)},${Math.round(event.clientY)})`
      + `  不透明=${opaque}  帧=${currentFrameName}`
      + `  区域=${JSON.stringify(headZone())}`)
  }

  // ⚠️ 用 hot 而不是 opaque —— 见上面的说明
  setInteractive(hot)
})

// 指针离开窗口 → 交还鼠标
window.addEventListener('mouseout', (event) => {
  if (event.relatedTarget === null) setInteractive(false)
})

// 右键宠物 → 设置菜单。放在宠物图上而不是整窗，和命中测试的规则一致：
// 只有真的点在宠物身上才算数，空白处照常穿透。
el.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  window.pet.showMenu?.()
})

el.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return
  dragging = true
  moved = false
  lastScreen = { x: event.screenX, y: event.screenY }
  el.classList.add('dragging')
  event.preventDefault()
})

window.addEventListener('mousemove', (event) => {
  if (!dragging) return
  const dx = event.screenX - lastScreen.x
  const dy = event.screenY - lastScreen.y
  if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
    moved = true
    window.pet.drag(dx, dy)
    lastScreen = { x: event.screenX, y: event.screenY }
  }
})

/**
 * 单击 / 双击的区分。
 *
 * 单击 = 查余额，双击 = 挥手打招呼。
 *
 * 为什么要等一个判断窗口：浏览器不会提前告诉你"这会不会变成双击"，
 * 只能等一小会儿看有没有第二下。250ms 是常见取值 ——
 * 再长单击就明显发木，再短容易把慢一点的双击拆成两次单击。
 */
/**
 * 非空闲状态下被双击/悬停时的反馈：整只轻轻弹一下。
 *
 * 为什么不直接播动画：那个状态承载**真实的工作信息**（在忙 / 等你确认），
 * 插播一个打招呼的动作会把它盖掉。所以只做**视觉上的"我理你了"**，
 * 不碰状态机、不碰气泡、不碰帧位移。
 *
 * ⚠️ 但**必须有反馈** —— 全静默的话用户会以为"双击坏了"
 *    （实测就是被这么报上来的）。CSS 里那条"摸太快惹她生气"的注释
 *    说的是同一件事：分不清"她在闹脾气"和"功能坏了"。
 */
let lastNudgeAt = 0
/**
 * 打招呼：播一段挥手动画，**但不改状态、不碰气泡**。
 *
 * 区别就在这：
 *   · 空闲时 → 走 `wave()`，会顺带 reportMoment（说一句话）
 *   · 非空闲时 → 只播动画，**工作信息一个字都不动**
 *
 * 这样"双击有反应"和"别打断工作状态"两件事就不再打架了。
 */
function greet () {
  const now = Date.now()
  if (now - lastWaveAt < TIMING.waveCooldownMs) return
  lastWaveAt = now

  // 睡着时双击 = 叫醒她。原来是调 wave() 做的，改成 greet 之后漏掉了 ——
  // 结果睡着的时候怎么双击都没反应。
  const wasAsleep = isAsleep
  if (wasAsleep) wakeUp()

  // wakeUp() 之后状态可能变了，所以 back 要**重新取**
  const back = logicalState
  // ⚠️ **有 `greet` 就播 `greet`，没有就退回 `wave`。**
  //    `greet` 是月薪喵专属的一整段 GIF（28 帧"双手揉脸"，写在它的 manifest 里）；
  //    鲸鱼娘和 Q版大肥鱼**都没有这一段** —— 直接 `playClip('greet')` 会拿不到片段、
  //    双击**毫无反应**（实测：启动日志里 `动画自检: greet 没有定义`）。
  //    所以这里要判断一下再决定播哪个。
  const greetClip = clipFor('greet') ? 'greet' : 'wave'
  playClip(greetClip, {
    onDone: () => {
      // 期间状态要是变了（比如 DSH 推了新状态），就别抢回来
      if (logicalState === back) playClip(back)
    },
  })

  // ⚠️ **必须报「时刻」，否则气泡不说话。**
  //
  //    第一版 greet() 只播了动画 —— 用户的反馈就是「双击没有显示对应的台词」。
  //    刚睡醒说「我、我没睡！」，本来醒着说「在的！」（两套不同的话）。
  //    `reportMoment` 和 `reportState` 是分开的：时刻**不参与状态计时、
  //    不重置升级催促** —— 所以在 working / needInput 里双击也不会
  //    把工作信息顶掉，这正是它存在的理由。
  window.pet.reportMoment?.(wasAsleep ? 'startle' : 'wave')
}

function nudge () {
  const now = Date.now()
  if (now - lastNudgeAt < 400) return      // 连点别抖个不停
  lastNudgeAt = now
  el.classList.remove('nudge')
  void el.offsetWidth                       // 强制回流，让动画能重播
  el.classList.add('nudge')
  setTimeout(() => el.classList.remove('nudge'), 340)
}

const DOUBLE_CLICK_MS = 250
let clickTimer = null

window.addEventListener('mouseup', () => {
  if (!dragging) return
  dragging = false
  el.classList.remove('dragging')
  window.pet.dragEnd()
  if (moved) return          // 拖动过，不算点击

  if (clickTimer !== null) {
    // 第二下来了 → 双击
    clearTimeout(clickTimer)
    clickTimer = null
    console.log(`[pet] 双击（当前状态 ${logicalState}）`)
    // ⚠️ **不管什么状态都要播动画。**
    //
    //    原来非空闲时只弹一下（nudge）不播动画 —— 用户的反馈是
    //    「双击没有动画，只是图画稍微扩大了一下然后变回原样」。
    //    那条规则（"别打断工作状态的信息"）本意是**不改状态、不换气泡**，
    //    但连动画都不播就变成了"没反应"。现在改成：
    //      · **播打招呼的动画**（看得见）
    //      · **不改状态、不碰气泡**（工作信息不受影响）
    //      · 播完回到当前状态该有的动画
    greet()
    return
  }

  clickTimer = setTimeout(() => {
    clickTimer = null

    // ⚠️ **她"举着手等你"的时候，单击 = 「我看到了」，不是查余额。**
    //
    //    需求：「错误状态需要常驻 …… 用户查看 dsh 窗口时再停止」。
    //    常驻气泡（出错 / 需要确认）是**举着手不肯放下**的状态 ——
    //    这时候点她，用户的意图是"行了我知道了"，而不是"给我看余额"。
    //
    //    （另外两种"停止"的方式见 main.js 的 attention.js：
    //      DSH 里 agent 恢复活动、前台切到 DSH —— 那两条是自动的，
    //      这一条是用户主动的，也是最可靠的。）
    if (HOLDING_STATES.has(logicalState)) {
      console.log(`[pet] 单击 → 「我看到了」（当前 ${logicalState}，停止常驻和催促）`)
      window.pet.acknowledge?.()
      window.pet.reportMoment?.('ack')
      return
    }

    console.log('[pet] 单击 → 查余额')
    // 查余额是个纯查询，不受状态限制 —— 任何时候点都能看
    window.pet.showBalance?.()
  }, DOUBLE_CLICK_MS)
})

// ─────────────────────────── 接 DSH 插件 ───────────────────────────

/**
 * 插件推过来的状态名 → 我们的动画片段名。
 *
 * 插件用 DSH 的说法（idle / working / needsInput / ready / blocked），
 * 动画用我们自己的片段名。中间这层映射让两边可以各自演进。
 */
const PLUGIN_STATE_MAP = {
  idle: 'idle',
  working: 'working',
  needsInput: 'needInput',
  needInput: 'needInput',
  ready: 'ready',
  blocked: 'blocked',
}

let dshConnected = false

/**
 * 哪些状态是"举着手等你"的 —— 气泡常驻、会一直催，直到你理她。
 *
 * `needInput` = 需要你确认（🔒 固定开启）
 * `blocked`   = 出错了、卡住了（🔒 固定开启）
 *
 * 这两个状态下的单击 = 「我看到了」，见上面 mouseup 里那段说明。
 */
const HOLDING_STATES = new Set(['needInput', 'blocked'])

/** 当前 ready 庆祝的结束时刻（毫秒时间戳）。0 = 没在庆祝。 */
let readyUntil = 0

function applyPluginState (payload) {
  const raw = payload?.state
  const clip = PLUGIN_STATE_MAP[raw]
  if (!clip) {
    console.warn('[pet] 插件推来未知状态:', raw)
    return
  }
  if (clip === logicalState) return

  // ⚠️ 庆祝的时长由渲染层自己掌握（JUMP_TIMES × 一圈），
  // 插件那边只有一个估算的 READY_HOLD_MS，两者难免对不齐。
  // 实测踩过：插件跑的是旧代码（2500ms），庆祝才跳 2 次就被 idle 打断。
  // 所以这里把「提前到达的 idle」挡掉，让庆祝把 5 次跳完。
  // 真正的工作状态（working / needsInput / blocked）不受影响，随时能抢占。
  if (clip === 'idle' && logicalState === 'ready' && Date.now() < readyUntil) {
    const left = Math.round((readyUntil - Date.now()) / 1000)
    console.log(`[pet] 忽略提前到达的 idle（庆祝还有约 ${left} 秒）`)
    return
  }

  // ⚠️ **`readyUntil` 必须在 `setState()` 之前算好。**
  //
  //    原来的顺序是 setState 再赋值 —— 中间有个窗口期 `readyUntil` 还是 0，
  //    插件如果正好在这几毫秒里推 `idle`，上面那道"挡掉提前到达的 idle"
  //    就形同虚设，庆祝跳一次就被打断。用户报的「跳跃循环只有一次」就是这个。
  //    （正常情况窗口很短，但插件推状态是异步的，撞上就中。）
  //
  //    ready 不用在这里排兜底计时器 —— 那个片段是 loop:false，
  //    跳完固定次数后由 playClip 的 onDone 自己回 idle。
  readyUntil = clip === 'ready' ? Date.now() + celebrationDurationMs() : 0
  setState(clip)
}

/** 庆祝总时长 = 所有帧的时长之和（ready 片段是 loop:false，跳完即止）。 */
function celebrationDurationMs () {
  const clip = clipFor('ready')     // 素材自带 or 动态构造，见 clipFor
  let total = 0
  for (let i = 0; i < clip.frames.length; i += 1) total += durationAt(clip, i)
  return total
}

// ─────────────────────────── 演示模式 ───────────────────────────

/**
 * --demo 时自动轮播各状态，用来肉眼验收素材。
 * 生产环境不会走这条路径。
 */
function runDemo () {
  const sequence = ['idle', 'working', 'needInput', 'blocked', 'ready']
  let i = 0
  const tick = () => {
    const state = sequence[i % sequence.length]
    console.log('[pet][demo] 状态 →', state)
    setState(state)
    i += 1
    setTimeout(tick, state === 'ready' ? 12000 : 4000)
  }
  tick()
}

// ─────────────────────────── 启动 ───────────────────────────

async function boot () {
  const results = await preload()
  const ok = results.filter(Boolean).length
  console.log(`[pet] 资源加载完成 ${ok}/${results.length}`)

  if (ok === 0) {
    console.error(`[pet] 没有任何素材加载成功，检查 assets/${ACTIVE_STYLE}/ 目录`)
    return
  }

  // 启动前校验：所有片段引用的帧名必须合法。
  // 这类错误以前是静默的（帧名写错 → showFrame 直接 return → 画面不动但不报错）。
  for (const [clipName, clip] of Object.entries(CLIPS)) {
    for (const frame of clip.frames) {
      if (!FRAME_FILES[frame]) {
        console.error(`[pet] 片段 ${clipName} 引用了非法帧名: ${frame}`)
      }
    }
  }

  // 浏览器自动播放策略：AudioContext 要在用户交互过之后才出声。
  // 挂一次全局监听解锁，用户第一次点桌面就把路铺好了。
  window.petSounds?.armUnlock()

  setState('idle')

  // 接上 DSH 插件（没连上也不影响：她就是个普通桌宠）
  window.pet.onSessions?.(({ count }) => showSessionBadge(count))
  window.pet.onBalanceMood?.(({ tier }) => showBalanceMood(tier))
  window.pet.onFrameBounds?.((table) => {
    frameBounds = table || {}
    console.log(`[pet] 收到 ${Object.keys(frameBounds).length} 帧的包围盒`)
  })
  window.pet.onSound?.(({ enabled }) => window.petSounds?.setEnabled(enabled))
  // 每套宠物的多帧动画（打招呼 / 被吵醒 / 完成）由主进程读 manifest 推过来
  window.pet.onClips?.((clips) => applyClips(clips))
  // 单文件演示版没有主进程，clips 直接内联在页面里（按形象分开放）
  applyClips(globalThis.__DEMO_CLIPS?.[ACTIVE_STYLE])
  // ⚠️ **接上 clips 之后要广播一声。**
  //    预览页那几个按钮是照着片段建的，而 `boot()` 是 async ——
  //    预览页的脚本跑得比这里早，建出来的按钮会全是**兜底版**
  //    （实测：月薪喵的「工作中」显示 6 帧/位移，其实是鲸鱼娘那套）。
  window.dispatchEvent(new CustomEvent('pet:clips-ready'))
  initPat()
  window.pet.onState(applyPluginState)
  window.pet.onBridge(({ connected }) => {
    dshConnected = connected
    console.log(`[pet] DSH 插件${connected ? '已连接' : '已断开'}`)
    if (!connected) setState('idle')   // 断了就回到空闲，别卡在"工作中"
  })
  window.pet.bridgeStatus().then(({ connected }) => {
    dshConnected = connected
    console.log(`[pet] 启动时 DSH 桥接：${connected ? '已连接' : '未连接'}`)
  }).catch(() => {})

  // ⚠️ 启动自检会**改画面**（要验行为就得动它）。
  //    预览页也加载这个文件，如果照跑，用户点一个片段之后
  //    自检会把它抢走 —— 看起来像"点了没反应"或"帧不对"。
  //    我自己就被骗过一次，以为是待机链在抢，查了半天。
  //    所以预览页带 ?selftest=0 显式关掉。
  // 两个开关：URL 参数（本页自己带的）或全局标记（被别人加载时设的）。
  // 预览页用后者 —— 它的 location.search 传不进 pet.js 的判断。
  const runSelfTests = !window.petNoSelfTest &&
    new URLSearchParams(location.search).get('selftest') !== '0'
  if (runSelfTests) {
    setTimeout(selfTestPat, 1200)
    setTimeout(selfTestIdleChain, 1400)
    setTimeout(selfTestBadge, 1600)
    setTimeout(selfTestPatFace, 1800)
    // ⚠️ 和上一个拉开 1300ms。selfTestPatFace 会留一个 700ms 后恢复的定时器，
    //    紧跟其后跑生气自检的话，那个恢复正好落在生气序列中间 ——
    //    生气第二帧还没接上就被待机链抢走，报出一个**看起来像功能坏了**的假失败。
    //    真实路径上不会撞：onTooFast 里会 clearTimeout(patFaceTimer)。
    setTimeout(selfTestAngryFace, 3100)
    setTimeout(selfTestOffset, 3400)
    setTimeout(selfTestFakeMotion, 3500)
    setTimeout(selfTestAssets, 3600)
    setTimeout(selfTestReadyClip, 3700)
    setTimeout(selfTestWorkingClip, 3800)
    setTimeout(selfTestClips, 3900)
    // 缺帧汇总。做新宠物时会缺很多张，一条条 warn 会刷屏，这里汇总成一行。
    setTimeout(() => {
      if (!MISSING_FRAMES.size) return
      console.warn(`[pet] 这套素材还缺 ${MISSING_FRAMES.size} 张，缺的已经用 awake 顶替：`)
      console.warn(`[pet]   ${[...MISSING_FRAMES].join(' ')}`)
      console.warn(`[pet]   做完之后跑：npm run verify:pet -- ${ACTIVE_STYLE}`)
    }, 3800)
  } else {
    console.log('[pet] 自检已关闭（?selftest=0）')
  }
  setTimeout(() => { if (window.petDemo) runDemo() }, TIMING.greetingDelayMs)

  // ⚠️ **首次启动要给一段"这玩意儿怎么用"的引导。**
  //
  //    宠物是**无边框、无程序坞图标、不抢焦点**的窗口 ——
  //    新用户装完打开，看到的只是屏幕角落多了个小人，
  //    **不知道能右键、能拖、能缩放**。
  //    体检时这是阻塞项之一：不改的话第一条反馈大概率是"这怎么用"。
  //
  //    ⚠️ 只在**第一次**说（`pet:is-first-run`，靠 userData 里有没有
  //       window-state.json 判断）—— 每次启动都念一遍会变成噪音。
  setTimeout(async () => {
    let first = false
    try { first = Boolean(await window.pet.isFirstRun?.()) } catch { /* 拿不到就当不是 */ }
    if (!first) return
    console.log('[pet] 首次启动 → 说引导台词')
    window.pet.sayExternal?.({
      text: [
        '你好呀，我是胖头鱼～',
        '',
        '· 右键我 → 换形象 / 关台词 / 打开设置',
        '· 拖我右下角的小三角 → 改大小（双击它恢复）',
        '· 双击我 → 打个招呼',
        '· 复制一段英文 → 我给你翻译',
      ].join('\n'),
      durationMs: 15000,
      tone: 'normal',
    })

    // ⚠️ **标记必须在这里 —— 在 `setTimeout` 里面、说完之后。**
    //    第一版写在了 `setTimeout` 的**外面**，于是它**同步立即执行**，
    //    比渲染层问「是不是首次启动」（900ms 后）还早 ——
    //    结果标记先写上、询问拿到 false、**引导被跳过**。
    //    （日志里的顺序是反的：`已记录「引导说过了」` 在 `问首次启动 → false` 之前。）
    window.pet.markWelcomed?.()
  }, TIMING.greetingDelayMs + 400)
}

// 调试入口：在 devtools 里可直接调 window.petDebug.setState('working')
window.petDebug = {
  setState, wave, playClip, showBalanceMood, showSessionBadge, showPatFace,
  selfTestPatFace, selfTestAngryFace, selfTestOffset, selfTestFakeMotion, selfTestAssets, selfTestReadyClip, selfTestWorkingClip, selfTestClips,
  showAngryFace, CLIPS, FRAME_FILES,
  // ⚠️ **必须导出 `clipFor`，不能只导出 `CLIPS`。**
  //    `ready` / `working` 这两段是**按需构造**的、不在 `CLIPS` 里
  //    （帧数取决于这套素材有几张，见 `clipFor` 的说明）。
  //    预览页原来直接读 `CLIPS`，于是「工作中」和「完成庆祝」
  //    两个按钮**根本没出现** —— 而这两个恰恰是最常调的动画。
  clipFor,
  get state () { return logicalState },
  get clip () { return currentClip },
  // 当前是哪个**逻辑帧**。
  //
  // 为什么要有它：预览页原来是从 `img.src` 里抠文件名的（`.split('/').pop()`）——
  // 单文件演示版把图片内联成 data URI 之后，抠出来是一串 base64，
  // 读数变成 `帧 ? zPDicC33HpDVXVoBvLu...==.webp`。直接问 pet.js 才对。
  get frame () { return currentFrameName },
  // 待机链（空闲时按权重随机抽一个节点播）。
  // 导出它是因为**做新宠物时要照着这份清单准备图** ——
  // `tools/dump-spec.cjs` 靠它生成规格；正则抠源码抠不准（注释里也有同名文本）。
  get idleChain () { return IDLE_CHAIN },
  get dshConnected () { return dshConnected },
}

boot()

// ─────────────────────────── 缩放手柄 ───────────────────────────
//
// 需求：右下角一个手柄，**鼠标在宠物范围内才显示**，
//       拖它等比缩放，**双击恢复默认大小**。
//
// 三个设计决定，都在踩坑之后定的：
//
// ① **手柄位置固定在「站立帧（awake）的右下角」**，不跟当前帧的轮廓走。
//    角色在不同动作里轮廓差很多（睡着是坐着的、庆祝帧是跳起来的），
//    手柄跟着轮廓走会**每帧乱跳**，用户根本瞄不准。
//    固定之后它在缩放过程中也不动，手感稳。
//
// ② **显示用滞回（hysteresis），不是每次 mousemove 都重新判。**
//    手柄在宠物轮廓外侧的透明区，鼠标从宠物移过去会经过一小段空白。
//    实时判定的话：一进空白就隐藏 → 穿透开启 → 鼠标事件断了 → 手柄再也不出来。
//    所以「命中 → 立即显示」，「离开 → 等 500ms 再隐藏」，把那段空白跨过去。
//
// ③ **缩放比例按「离锚点的距离比」算，不是按像素增量。**
//    锚点是宠物**底边中心**（主进程 setBounds 时保持它不动）。
//    拖动手柄时 `新倍率 = 起始倍率 × (当前距离 / 起始距离)` ——
//    这样手感是"从中心往外拽"，而不是"往右下角推"，和锚点一致。

const handleEl = document.getElementById('resize-handle')

/** 手柄当前的位置（视口坐标，左上角）。`null` = 还没算出来。 */
let handleBox = null
/** 手柄该不该显示（滞回后的结果） */
let handleWanted = false
let handleHideTimer = null
const HANDLE_HIDE_DELAY = 500

/** 手柄的视觉尺寸，和 pet.css 里的 width/height 保持一致 */
const HANDLE_SIZE = 16
/**
 * 命中用的尺寸 —— **比视觉大一圈**。
 * 16px 的目标对鼠标来说太小了（尤其触摸板），实心可点区域放大到 24px。
 * 视觉不动，只是判定放宽。
 */
const HANDLE_HIT = 24

/**
 * 手柄摆在「站立帧右下角」。
 *
 * 位置 = 宠物图片的矩形 × awake 帧的 bounds（归一化右边界 / 下边界）。
 * `frameBounds` 是主进程从 manifest 里读出来推过来的（见 main.js 的
 * `frameBoundsTable`），值是**相对画布的比例**，所以缩放窗口时自动跟着走。
 *
 * ⚠️ 算不出来就**藏起来**，不要拿一个猜的位置顶上 ——
 *    手柄点错地方会变成拖动整只宠物，用户会以为"缩放坏了"。
 */
/**
 * 量「站立帧」的不透明像素包围盒（归一化到图片宽高的 0~1）。
 *
 * ⚠️ **为什么不读 manifest 的 `bounds`**：
 *    那是**老格式**才有字段（`manifest.assets[*].bounds`）。
 *    新格式（Q版大肥鱼 / 成熟鲸鱼娘）只有 `frames`，**不含 bounds** ——
 *    实测 `frameBounds` 是空的，手柄就永远算不出位置、**一次都不显示**。
 *
 *    所以这里直接从图片的 alpha 通道量一遍：
 *    `awake` 那张本来就加载好了，画到离屏 canvas 扫一圈就行，
 *    而且**对所有形象都能用**，不依赖 manifest 的格式版本。
 *
 * 缓存起来 —— 只在换形象时失效，不必每帧算。
 */
let awakeBoxCache = null
let awakeBoxFor = null

function awakeBox () {
  const key = FRAME_FILES.awake
  if (awakeBoxFor === key) return awakeBoxCache
  awakeBoxFor = key
  awakeBoxCache = null

  const img = images[key]
  if (!img || !img.width) return null

  const c = document.createElement('canvas')
  c.width = HIT_SIZE; c.height = HIT_SIZE
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, HIT_SIZE, HIT_SIZE)
  ctx.drawImage(img, 0, 0, HIT_SIZE, HIT_SIZE)
  const d = ctx.getImageData(0, 0, HIT_SIZE, HIT_SIZE).data

  let l = HIT_SIZE, t = HIT_SIZE, r = -1, b = -1
  for (let y = 0; y < HIT_SIZE; y += 1) {
    for (let x = 0; x < HIT_SIZE; x += 1) {
      if (d[(y * HIT_SIZE + x) * 4 + 3] <= HIT_ALPHA_MIN) continue
      if (x < l) l = x
      if (x > r) r = x
      if (y < t) t = y
      if (y > b) b = y
    }
  }
  if (r < 0) return null      // 整张全透明，量不出东西

  awakeBoxCache = {
    right: (r + 1) / HIT_SIZE,
    bottom: (b + 1) / HIT_SIZE,
  }
  console.log(`[pet] 站立帧包围盒: 右 ${(awakeBoxCache.right * 100).toFixed(1)}%`
    + `  下 ${(awakeBoxCache.bottom * 100).toFixed(1)}%  （手柄位置据此算）`)
  return awakeBoxCache
}

function placeHandle () {
  if (!handleEl) return
  const rect = el.getBoundingClientRect()
  if (rect.width === 0) { handleBox = null; return }

  // 优先用真量的包围盒；量不出来（图还没加载完）再退回 manifest 的 bounds；
  // 都拿不到就**藏起来** —— 不要猜一个位置顶上，点错了会变成拖动整只宠物。
  const box = awakeBox()
  const fb = frameBounds?.idle_pillow_awake ?? frameBounds?.awake
  const rightRatio = box?.right ?? fb?.right
  const bottomRatio = box?.bottom ?? fb?.bottom
  if (!Number.isFinite(rightRatio) || !Number.isFinite(bottomRatio)) {
    handleBox = null
    return
  }

  // 图片矩形 × 比例，再往内收 4px（别贴到轮廓外面去）
  const right = rect.left + rect.width * rightRatio
  const bottom = rect.top + rect.height * bottomRatio
  const left = Math.round(right - HANDLE_SIZE + 4)
  const top = Math.round(bottom - HANDLE_SIZE + 4)
  handleEl.style.left = `${left}px`
  handleEl.style.top = `${top}px`
  handleBox = { left, top, right: left + HANDLE_SIZE, bottom: top + HANDLE_SIZE }
}

/** 该点是否压在手柄上（用放宽后的判定框） */
function isOverHandle (clientX, clientY) {
  if (!handleBox || !handleWanted) return false
  const pad = (HANDLE_HIT - HANDLE_SIZE) / 2
  return clientX >= handleBox.left - pad && clientX <= handleBox.right + pad
      && clientY >= handleBox.top - pad && clientY <= handleBox.bottom + pad
}

/** 滞回：命中就显示，离开等一会儿再隐藏（跨过手柄和宠物之间那段空白） */
function noteHoverForHandle (hot) {
  if (hot) {
    clearTimeout(handleHideTimer)
    handleHideTimer = null
    if (!handleWanted) {
      handleWanted = true
      placeHandle()
      handleEl?.classList.add('show')
    }
    return
  }
  if (!handleWanted || handleHideTimer) return
  handleHideTimer = setTimeout(() => {
    handleHideTimer = null
    handleWanted = false
    handleEl?.classList.remove('show')
  }, HANDLE_HIDE_DELAY)
}

// ── 拖动缩放 ──

let resizing = false
let resizeStart = null      // { scale, dist, anchorX, anchorY }（屏幕坐标）
/** 主进程报回来的当前倍率 —— 缓存住，避免 mousedown 时还要 await */
let knownScale = 1
/** 上一次发出去的倍率，安全阀用 */
let lastSentScale = 0

/** 宠物图片矩形的底边中心（= 主进程 setBounds 时保持不动的那个锚点） */
function petAnchor () {
  const rect = el.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height }
}

function beginResize (event) {
  if (!handleEl) return

  // ⚠️ **拦截必须同步做，不能等 await。**
  //    第一版写成 `async` 且把 preventDefault 放在 `await getScale()` 之后 ——
  //    等它跑到那儿，事件早就传完了。现在先拦，再取倍率（用缓存，不 await）。
  event.preventDefault()
  event.stopPropagation()

  const scale = knownScale
  const a = petAnchor()
  // ⚠️ 锚点转成**屏幕坐标**（见 moveResize 的说明）
  const anchorX = window.screenX + a.x
  const anchorY = window.screenY + a.y

  // 起始距离：手柄离锚点多远（屏幕坐标）。至少要有个下限，否则除以 0。
  const dist = Math.max(24, Math.hypot(event.screenX - anchorX, event.screenY - anchorY))
  // **放大方向的单位向量** = 从锚点指向"按下时鼠标的位置"（正常是右下方）。
  // 缩放按鼠标位移在**这个方向上的投影**算，不是按到锚点的距离 —— 见 moveResize。
  const ux = (event.screenX - anchorX) / dist
  const uy = (event.screenY - anchorY) / dist

  resizing = true
  resizeStart = {
    scale, dist, anchorX, anchorY,
    ux, uy,
    startX: event.screenX, startY: event.screenY,
  }
  handleEl.classList.add('dragging')
  console.log(`[pet] 开始缩放：当前 ${(scale * 100).toFixed(0)}%`
    + `  锚点(屏幕 ${Math.round(anchorX)},${Math.round(anchorY)})`
    + `  起始距离 ${Math.round(dist)}  方向(${ux.toFixed(2)},${uy.toFixed(2)})`)
}

/**
 * 拖动中：按「离锚点的距离」算倍率。
 *
 * ⚠️⚠️ **必须用 `screenX/screenY`（屏幕坐标），绝对不能用 `clientX/clientY`（视口坐标）。**
 *
 *    这是踩过的大坑：窗口缩放时**锚定底边中心**，所以窗口变大的同时
 *    **左边界往左移、上边界往上移**。而 `clientX` 是"相对窗口左上角"的 ——
 *    同一个屏幕位置，在移动过的窗口里算出来的 `clientX` 就变了。
 *    于是形成**正反馈**：
 *
 *        窗口变大 → 左边界左移 → 鼠标的 clientX 变大
 *                 → 算出的距离变大 → 倍率变大 → 窗口又变大 → … 💥
 *
 *    实测一路飙到 **16518%**（窗口 3 万像素宽），用户看到的是"没放大、反而飞走了"。
 *
 *    `screenX/screenY` 是相对屏幕的，**不随窗口移动而变**，所以没有这个环。
 *    现有的拖动（pet:drag）本来就用 screenX/screenY —— 这里照抄就对了。
 */
function moveResize (event) {
  if (!resizing || !resizeStart) return
  const { scale, dist, ux, uy, startX, startY } = resizeStart

  // ⚠️⚠️ **按"位移在放大方向上的投影"算，不要按"到锚点的距离"。**
  //
  //    第一版用的是距离（`hypot(现在 - 锚点) / 起始距离`），有个几何 bug：
  //    **距离是没有方向的半径** —— 越过锚点之后它**重新变大**，
  //    于是"一直往左上拖"到了某个点突然**又变成放大**。
  //    用户报的就是这个：
  //        「向右下拖动放大，不松手改往左上拖会缩小，
  //          但继续左上拖到一定距离会变为放大」
  //    （就像"往东 100 米"和"往西 100 米"离原点的距离都是 100。）
  //
  //    投影 `proj` 是**有正负**的：越过锚点之后它继续变负，
  //    所以倍率**一路单调**，不会翻回来。
  const proj = (event.screenX - startX) * ux + (event.screenY - startY) * uy

  // dist + proj 可能 ≤ 0（往反方向拖得比起始距离还远）。
  // 留 10% 的余量当下限，剩下的交给主进程夹（MIN_SCALE = 0.5）——
  // 这里只是别让它算成 0 或负数。
  const effective = Math.max(dist * 0.1, dist + proj)
  let next = scale * (effective / dist)

  // ⚠️ **安全阀**：单次移动最多把倍率变成上一帧的 1.6 倍 / 0.625 倍。
  //    正常的拖动手速远达不到这个变化率；会撞上它说明又出了反馈环 ——
  //    宁可让缩放"跟不上手"，也不能让窗口再飞一次。
  if (Number.isFinite(lastSentScale) && lastSentScale > 0) {
    next = Math.min(next, lastSentScale * 1.6)
    next = Math.max(next, lastSentScale / 1.6)
  }
  if (!Number.isFinite(next) || next <= 0) return

  lastSentScale = next
  window.pet.resize?.(next)
}

function endResize () {
  if (!resizing) return
  resizing = false
  resizeStart = null
  if (lastSentScale > 0) knownScale = lastSentScale
  lastSentScale = 0
  handleEl?.classList.remove('dragging')
  window.pet.resizeEnd?.()
  // 缩放后图片矩形变了，手柄要挪到新的右下角
  requestAnimationFrame(placeHandle)
}

/**
 * 双击手柄 = 恢复默认大小。
 *
 * ⚠️ **必须 stopPropagation。**
 *    双击宠物本体是「打招呼」（`greet()`），它挂在 window 的 mouseup 上。
 *    不拦的话双击手柄会**同时**触发缩放复位和打招呼 —— 她会一边变形一边挥手。
 */
function resetScale (event) {
  event.preventDefault()
  event.stopPropagation()
  window.pet.resize?.(1)
  window.pet.resizeEnd?.()
  knownScale = 1
  lastSentScale = 0
  console.log('[pet] 双击手柄 → 恢复默认大小')
  requestAnimationFrame(placeHandle)
}

if (handleEl) {
  handleEl.addEventListener('mousedown', beginResize)
  handleEl.addEventListener('dblclick', resetScale)
  // 手柄自己的右键不弹菜单（右键菜单是给宠物本体的）
  handleEl.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })

  window.addEventListener('mousemove', moveResize)
  window.addEventListener('mouseup', endResize)
  // 缩放中指针可能滑出手柄，用冒泡到 window 的 mousemove 兜住（已经这么做了）
} else {
  console.warn('[pet] 没找到 #resize-handle —— 缩放功能不可用')
}

// 窗口尺寸变了（主进程 setBounds 之后）→ 手柄要跟着挪
window.addEventListener('resize', () => requestAnimationFrame(placeHandle))
// 换帧 / 换形象之后 awake 的 bounds 会变，重算一次
window.addEventListener('pet:clips-ready', () => requestAnimationFrame(placeHandle))

console.log('[pet] 缩放手柄自检: '
  + `元素=${handleEl ? '✅ 找到' : '❌ 没找到'}  `
  + `位置=${handleBox ? `(${handleBox.left},${handleBox.top})` : '待算'}  `
  + `命中判定=${typeof isOverHandle === 'function' ? '✅' : '❌'}  `
  + `IPC=${window.pet.resize ? '✅' : '❌'}  `
  + `最小倍率=50%（主进程 clamp）`)
