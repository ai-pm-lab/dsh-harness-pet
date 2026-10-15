/**
 * 胖头鱼 · DSH 桌宠 — Electron 主进程
 *
 * 本文件负责「窗口」这一层，也就是需求 6（完全置顶）。
 * 宠物自身的状态机与动画在 renderer 里，主进程只做三件事：
 *   1. 造一个透明、无边框、始终置顶的窗口
 *   2. 让它在所有工作区 / 全屏之上可见
 *   3. 处理拖动、点击穿透、托盘
 */

'use strict'

const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const {
  app, BrowserWindow, Menu, screen, ipcMain, shell, nativeImage, clipboard,
} = require('electron')

const bridge = require('./bridge')
const platform = require('./platform')
const dialogues = require('./dialogues')
const { STATE_LABELS } = require('./state-labels')
const bubbleController = require('./bubble-controller')
const attentionWatcher = require('./attention')
const translateClient = require('./translate')
const translateConfig = require('./translate-config')
const selectionWatcher = require('./selection')
const dshPlugin = require('./dsh-plugin')
const launch = require('./launch')

// ─────────────────────────── 常量 ───────────────────────────

/** 窗口尺寸。宠物图是 512×512，窗口比它略大以容纳气泡。 */
/**
 * 宠物窗口的**基准尺寸**（缩放 = 100% 时）。
 *
 * ⚠️ 这两个是**基准**，不是**当前**尺寸 —— 用户可以把桌宠放大缩小（50%~不限），
 *    当前尺寸用 `winW()` / `winH()` 取，**不要再直接引用这两个常量去算几何**。
 *
 * 为什么保持 220×240 这个比例：图片是正方形、按窗口宽度 100% 缩放，
 * 所以窗口比图片高 20px（底部留白）。这个"高出来的 20px"是气泡
 * `headOffset` 计算的前提（见 characterHeadOffset）。
 */
const BASE_W = 220
const BASE_H = 240

/**
 * 当前缩放的倍率。1 = 基准大小。
 *
 * ⚠️ 小数存盘时会有浮点误差（0.1+0.2 那类），存取都夹一下。
 * 下限 0.5 —— 再小就看不清了。
 *
 * ⚠️ **上限 8 倍是"防爆阀"，不是产品限制。**
 *    用户明确说了"最大不限制"（要先看放大效果），所以正常使用**碰不到** 8 倍 ——
 *    素材 512、内容高 435，8 倍已经是 4096px 宽，早就糊了。
 *    它的作用是**兜底**：实测踩过一次正反馈失控，倍率一路飙到 16518%
 *    （窗口 3 万像素宽），把窗口甩到屏幕外几万像素、系统也开始卡。
 *    **渲染层的安全阀修好了，但主进程不该无条件相信渲染层报上来的数。**
 */
const MIN_SCALE = 0.5
const MAX_SCALE = 8
let petScale = 1

/** 当前窗口尺寸（按倍率算、取整）。所有几何计算都该用这个。 */
function winW () { return Math.round(BASE_W * petScale) }
function winH () { return Math.round(BASE_H * petScale) }

/** 边距：离屏幕右下角多远 */
const MARGIN = 32

/**
 * 气泡窗口尺寸。
 *
 * 比气泡内容大一圈 —— 多出来的是给 **box-shadow 留的空间**。
 * 不留就会被窗口边界硬切（内边距只有 8px 而阴影要 14px 的时候踩过）。
 *
 * 留白没有副作用：这个窗口是**永远点击穿透**的。
 *
 * 做得比气泡本身宽裕一些：窗口是**永远点击穿透**的，
 * 所以留白不会挡住桌面上任何东西，也就不需要跟着文字动态改窗口大小。
 */
/** 设置弹窗宽度。高度由页面内容决定，见 settings:resize。 */
const SETTINGS_W = 420

const BUBBLE_W = 364
const BUBBLE_H = 288

/** 资源目录 */
const ASSET_DIR = path.join(__dirname, '..', 'assets')

let win = null
let isQuitting = false

/**
 * 位置持久化文件。
 *
 * 注意：不能在这里直接写 `app.getPath('userData')` —— 它在模块加载期执行，
 * 而此时 Electron 可能还没准备好，或者运行环境不允许写该目录（会抛
 * "Failed to get 'userData' path" 并让整个应用起不来）。
 * 所以延迟到真正要读写时再算，并且失败一律静默降级。
 */
function statePath () {
  try {
    return path.join(app.getPath('userData'), 'window-state.json')
  } catch {
    return null
  }
}

/**
 * 这次启动**是不是第一次**（用不用给"这玩意儿怎么用"的引导）。
 *
 * 用途：宠物是**无边框、无程序坞图标**的窗口 ——
 * 新用户装完打开，看到的只是屏幕角落多了个小人，
 * **不知道能右键、能拖、能缩放**。
 * （体检时列出的阻塞项 §1.9：不改的话第一条反馈大概率是"这怎么用"。）
 *
 * ⚠️⚠️ **判据是「独立的标记文件」，不是「window-state.json 在不在」。**
 *
 *    一开始图省事用了后者：删掉 window-state.json 之后启动，位置会被别的东西
 *    写回去，于是 loadPosition 看到"文件已存在" → isFirstRun = false，引导被跳过。
 *
 *    标记文件只由"引导已经说过"这件事创建，**没有任何别的路径会碰它** ——
 *    判据才可靠。
 */
let isFirstRun = false

/** 引导说过没有的标记。放在 userData 里，和窗口状态分开。 */
function welcomedPath () {
  try {
    return path.join(app.getPath('userData'), 'welcomed')
  } catch {
    return null
  }
}

/** 读一次"引导说过没有"。读不到文件 = 没说过。 */
function checkFirstRun () {
  const f = welcomedPath()
  if (!f) return false
  isFirstRun = !fs.existsSync(f)
  return isFirstRun
}

/** 记下"引导说过了"。写不进去也不影响使用（下次还会说一遍，无害）。 */
function markWelcomed () {
  const f = welcomedPath()
  if (!f) return
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, `${new Date().toISOString()}\n`, { mode: 0o600 })
    isFirstRun = false
  } catch { /* 写不进去就算了 */ }
}

function loadPosition () {
  const file = statePath()
  if (!file) return null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    loadSettingsFrom(raw)
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) return raw
  } catch { /* 首次启动没有这个文件，正常 */ }
  return null
}

/** 从已经读到的 JSON 里取气泡开关，避免把同一个文件读两遍 */
function loadSettingsFrom (raw) {
  // ⚠️ 缩放要**在 bubble 那条判断之前**恢复 —— 窗口尺寸依赖它，
  //    而且不能把两条判断合并成一句 `if (!raw?.bubble) return`：
  //    那样只有 bubble 字段的旧文件就永远读不到缩放。
  // ⚠️ 恢复时**也要夹上限** —— 用户的位置文件可能已经被坏版本写成 165 倍了
  if (Number.isFinite(raw?.scale)) petScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw.scale))
  if (!raw?.bubble || typeof raw.bubble !== 'object') return
  // ⚠️ **每个字段都要恢复，不能只挑一个。**
  //    第一版只恢复了 `enabled`，于是 `style` / `sound` / `translate`
  //    虽然被写进了文件，重启后却被丢掉 ——
  //    **用户换的形象一重启就变回去了**，而且完全没有提示。
  bubbleSettings = {
    ...bubbleSettings,                       // 保留默认值兜底
    ...raw.bubble,
    enabled: { ...(raw.bubble.enabled ?? {}) },
  }
}

function savePosition () {
  const file = statePath()
  if (!file || !win || win.isDestroyed()) return
  const [x, y] = win.getPosition()

  // 位置和气泡开关存在同一个文件里 —— 都是"用户偏好"，
  // 分成两个文件只会多一处可能不同步的地方。
  const data = { x, y, scale: petScale, bubble: bubbleSettings }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // ⚠️ **mode: 0o600** —— 和 translate.json 保持一致。
    //    这里存的是窗口位置、用的形象、气泡开关，不算敏感，
    //    但它是"用户偏好"，没道理让同机器的其他账号读得到。
    //    （体检时发现这个文件是 644 而 translate.json 是 600 ——
    //      不一致本身就是隐患：以后往这里加字段的人会以为"这个文件是公开的"。）
    // ⚠️ **`writeFileSync` 的 `mode` 只在「文件不存在、要新建」时生效** ——
    //    已经存在的文件不会被改权限。所以老用户升级上来时，
    //    那个 644 的旧文件会一直是 644（体检时就是这么发现的：
    //    代码改了、跑完体检还是报 644）。
    //    必须显式 chmod 一次。
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
    try { fs.chmodSync(file, 0o600) } catch { /* 改不动就算了 */ }
  } catch { /* 写不进去就算了，不该影响使用 */ }
}

/**
 * 气泡的逐状态开关（需求 4：可勾选哪些状态说话）。
 *
 * 结构：{ enabled: { idle: true, working: false, ... } }
 * 没记录的键一律当作开启 —— 默认全开比默认全关更符合直觉。
 * fixed 的状态（needsInput / blocked）不受这里影响，见 bubble-controller。
 */
/**
 * **默认形象** —— 全新安装、或者配置里那套找不到时用它。
 *
 * ⚠️ **改这里的时候，`src/renderer/pet.js` 的 `ACTIVE_STYLE` 兜底也要跟着改。**
 *    渲染层是独立进程、拿不到这个常量，只能各写一份；
 *    两边不一致的话，开发时直接开预览页会看到另一套形象。
 *    `test-mainmenu.mjs` 里有一条检查专门守这个一致性。
 *
 * 排序（右键菜单里的先后）不在这里 —— 在每套自己的 `manifest.json` 的 `order` 字段。
 */
const DEFAULT_STYLE = 'big-fish'

let bubbleSettings = { enabled: {}, translate: true, style: DEFAULT_STYLE, sound: true }

function loadSettings () {
  const file = statePath()
  if (!file) return
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw.bubble && typeof raw.bubble.enabled === 'object') {
      bubbleSettings = {
        enabled: { ...raw.bubble.enabled },
        translate: raw.bubble.translate !== false,
        style: typeof raw.bubble.style === 'string' ? raw.bubble.style : DEFAULT_STYLE,
        sound: raw.bubble.sound !== false,
      }
    }
  } catch { /* 首次启动没有这个文件，正常 */ }
}

function setBubbleEnabled (state, enabled) {
  bubbleSettings.enabled[state] = Boolean(enabled)
  savePosition()
}

/**
 * 默认位置：屏幕右下角。
 *
 * ⚠️ 这里要绕开 Dock。
 * workArea 在 Dock 常显时是排除 Dock 的，但 Dock 设为「自动隐藏」时
 * workArea 等于整个屏幕 —— 那时如果只留 32px 边距，宠物就正好压在
 * 自动弹出的 Dock 上，会挡住 Dock 图标的点击。
 * 所以检测到 workArea 和 bounds 几乎一样（= Dock 自动隐藏），就多留一段。
 */
const DOCK_CLEARANCE = 90

function defaultPosition () {
  const display = screen.getPrimaryDisplay()
  const { workArea, bounds } = display
  const dockAutoHidden = Math.abs(workArea.height - bounds.height) < 8
  const bottomMargin = dockAutoHidden ? DOCK_CLEARANCE : MARGIN
  return {
    x: Math.round(workArea.x + workArea.width - winW() - MARGIN),
    y: Math.round(workArea.y + workArea.height - winH() - bottomMargin),
  }
}

// ─────────────────────────── 窗口 ───────────────────────────

function createWindow () {
  const pos = loadPosition() ?? defaultPosition()

  win = new BrowserWindow({
    width: winW(),
    height: winH(),
    x: pos.x,
    y: pos.y,

    // 桌宠是"主窗口"，保持 normal —— 它应该出现在程序坞的窗口列表里
    type: 'normal',

    // 桌宠的核心外观要求
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,

    /*
     * ⭐ 桌宠**绝不抢焦点**。
     *
     * 这条不只是体验问题，还是划词翻译能不能用的前提：
     * 划词监听查的是"前台 App 的选中文字"，而我们的窗口一旦抢到焦点，
     * 前台就变成我们自己 —— 用户在 Safari 里选中一段英文，
     * 探测到的却是 Electron，永远读不到那段文字。
     *
     * 不抢焦点不影响交互：拖动和点击都是渲染层通过 IPC 驱动
     * setPosition 实现的，不走系统级的窗口拖拽。
     */
    focusable: false,

    // 注：backgroundThrottling 是 webPreferences 的选项，不是这里的 ——
    // 它已经在下方的 webPreferences 里设成 false 了。

    // macOS：不要因为窗口类型切换而抢走 App 的激活状态
    acceptFirstMouse: true,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  // ── ⭐ 需求 6：完全置顶 ──
  // 平台差异（macOS 要用 'screen-saver' 这一级才盖得住 Dock、
  // Windows 不支持 setVisibleOnAllWorkspaces）都收在 platform.js 里。
  platform.applyAlwaysOnTop(win)
  platform.applyAllWorkspaces(win)

  // 默认让整窗穿透鼠标，只有指针真正压在宠物身上时才接管。
  // forward: true 让 renderer 仍能收到 mousemove，从而判断"是否悬停在宠物上"。
  win.setIgnoreMouseEvents(true, { forward: true })

  // ⚠️ **初始加载也要带上形象名。**
  //
  //    原来这里只是 `loadFile(index.html)`，没有 query ——
  //    而渲染层是 `new URLSearchParams(location.search).get('style') || 'big-fish'`，
  //    于是**每次重启都回退到鲸鱼娘**，用户换的形象白换了，而且没有任何提示。
  //    （只有"当场切换"走 applyStyle() 才带 query，所以表现是"切了当时有效、重启就没了"。）

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { style: activeStyle() } })

  // 渲染层加载完再把音效开关推下去（loadFile 是异步的，early send 会丢）
  //
  // ⚠️⚠️ **必须用 `on` 而不是 `once`。**
  //
  //    踩过的坑（用户报「工作中会插一帧站立帧图」）：
  //    切换形象走的是 `applyStyle()` → `win.loadFile(...)`，**窗口会整个重新加载**，
  //    `did-finish-load` 会**再次触发**。写成 `once` 的话监听在启动时就用掉了 ——
  //    于是**切换形象之后 clips 再也不会推送**：
  //        CLIPS['working'] 是空的 → 走代码里兜底的 workingCycle()
  //        → 它用 work0~work6，而这套素材只有 work0~work2
  //        → **work3~work6 缺帧 → showFrame 回退到 awake**
  //        → 播 working 时**中间插进一帧站立姿势**（就是用户截图里那张）
  //
  //    为什么只有 Q版大肥鱼 / 成熟鲸鱼娘中招：它们 manifest 里写了 clips；
  //    鲸鱼娘没写（走 workingCycle() 本来就是对的），所以看不出问题。
  //
  //    验证方法：启动日志里 `[pet] 收下 N 个多帧动画:` **每切换一次形象就该多一行**。
  win.webContents.on('did-finish-load', () => {
    applySoundSetting()
    sendToRenderer('pet:frame-bounds', frameBoundsTable())
    // ⚠️ **每套宠物的多帧动画不一样**（帧数、时长、位移都不同），
    //    所以写在各自的 manifest.json 里，这里读出来推给渲染层。
    //    原来 CLIPS 是两套共用的常量 —— 加第二套宠物时必然打架。
    sendToRenderer('pet:clips', styleClips())
  })

  // ⚠️ 用 showInactive 而不是 show()。
  //
  //    show() 会**抢焦点** —— app 启动时如果你正在别的窗口里打字，
  //    光标会被夺走。桌宠是常驻的小工具，任何时候都不该打断用户
  //    （用户报过"状态变更影响我对当前窗口的操作"，顺藤摸瓜查到这里：
  //     状态变更本身不抢焦点，实测 6 次全过；**启动这一下才是真会抢的**）。
  win.once('ready-to-show', () => win.showInactive())

  win.on('moved', savePosition)
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })
}

/** 让窗口在"可交互"和"点击穿透"之间切换 */
function setInteractive (interactive) {
  if (!win || win.isDestroyed()) return
  win.setIgnoreMouseEvents(!interactive, { forward: true })
}

/**
 * 显式设置程序坞图标。
 *
 * ⚠️ 为什么不能只靠 .app 里的 AppIcon.icns：
 * 我们的「胖头鱼.app」只是一个壳 —— 它执行的是 node_modules 里的
 * Electron.app。**真正运行的进程是 Electron**，所以 macOS 解析到的
 * 是 Electron 自己的图标（那个原子 logo）。
 *
 * 之前一直显示我们的图标，是因为程序坞缓存了"用哪个 .app 启动的"这个关联；
 * 一旦 killall Dock 让缓存失效，就露出了 Electron 的原形。
 *
 * app.dock.setIcon() 是运行时覆盖，和 bundle 怎么启动无关，最可靠。
 * 注意它只认位图（PNG），不认 .icns。
 */
function hideDockIcon () {
  // ⚠️⚠️ **守卫必须在最前面 —— `app.dock` 只有 macOS 有。**
  //
  //    Windows 上 `app.dock` 是 `undefined`，先调 `.hide()` 会直接抛
  //    `TypeError: Cannot read properties of undefined (reading 'hide')`，
  //    而这个函数在 app ready 之后就被调用 —— **窗口根本建不出来**。
  //
  //    踩到的经过：原来守卫写在 `app.dock.hide()` **后面**（想的是"先隐藏，
  //    再判断要不要设图标"），在 macOS 上完全正常，所以一直没暴露。
  //    **只有真跑到 Windows 上才会崩** —— 审计时才发现。
  //
  //    `test-mainmenu.mjs` 里有一条检查专门守"macOS 专有 API 前面必须有守卫"。
  if (process.platform !== 'darwin' || !app.dock) return

  // ⚠️ **用户要求：程序坞里不显示图标。**
  //
  //    她是个**一直置顶的桌宠**，本来就不该占程序坞的位置 ——
  //    程序坞是给「正在用的 App」留的，她更像菜单栏常驻的小工具。
  //    隐藏之后：
  //      · 托盘图标（菜单栏右上角）**还在**，右键菜单照常能出
  //      · 右键宠物本体也能出菜单
  //      · 设置窗口弹出时会主动抢焦点（见 openSettingsWindow）
  //
  //    `app.dock.hide()` 让整个 app 变成 accessory
  //    （不占程序坞、不进 Cmd+Tab）。必须在 app ready 之后调。
  app.dock.hide()

  // 隐藏之后还是把图标设上 —— 万一它露出来（比如设置窗口抢焦点时），
  // 得是我们的图标而不是 Electron 的原子 logo。
  const png = path.join(ASSET_DIR, 'icon-512.png')
  const image = nativeImage.createFromPath(png)
  if (image.isEmpty()) {
    console.warn(`[dock] 图标读不出来: ${png}（跑一下 tools/make_icon.py）`)
    return
  }
  app.dock.setIcon(image)
  // 把 Dock 状态打出来 —— 我看不到屏幕，"程序坞里几个图标"这种事
  // 只能靠这些字段间接判断，不然修完也不知道有没有修好。
  //   isVisible=false → 整个 app 没进 Dock（说明壳的 LSUIElement 传下来了）
  //   getBundleId()   → 正常应该还是 com.github.Electron；
  //                     如果变成我们自己的 id，说明跑的是真 bundle 而不是壳
  // execPath 能看出跑的是哪个 bundle：
  //   .../胖头鱼.app/...            → 真 bundle
  //   .../node_modules/electron/...  → 壳（当前情况）
  const inOwnBundle = !process.execPath.includes('node_modules')
  console.log(`[dock] 已设置程序坞图标  visible=${app.dock.isVisible()}`
    + `  name=${app.getName()}  跑在${inOwnBundle ? '自己的 bundle' : 'Electron 的 bundle（壳）'}`)
}

// ─────────────────────────── 气泡窗口 ───────────────────────────

let bubbleWin = null
let bubble = null

/**
 * 气泡是**独立的窗口**，不是宠物窗口的一部分。
 *
 * 为什么不塞进宠物窗口：那需要把宠物窗口加高到能容纳气泡，
 * 而多出来的那块透明区域会挡住桌面点击（`点击宠物不用穿透，空白位置可以穿透`
 * 这条约定会被破坏）。独立窗口则可以做成"永远点击穿透"，留白完全无副作用。
 */
function createBubbleWindow () {
  bubbleWin = new BrowserWindow({
    width: BUBBLE_W,
    height: BUBBLE_H,

    // macOS 上要 'panel'（NSPanel）—— 否则气泡会在程序坞图标的右键菜单里
    // 单独列一项，看起来像第二个程序。Windows 上没有对应概念，返回空对象。
    ...platform.bubbleWindowExtras(),

    transparent: true,
    frame: false,

    // 标题留空：万一某些场景仍会露出来，也不该显示成一个独立的名字
    title: '',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,          // 气泡永远不抢焦点
    skipTaskbar: true,
    show: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'bubble-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  platform.applyAlwaysOnTop(bubbleWin)
  platform.applyAllWorkspaces(bubbleWin)

  // ⭐ 永远点击穿透：气泡只是显示，从不接受点击。
  // 这样它的透明留白不会挡住桌面上任何东西。
  bubbleWin.setIgnoreMouseEvents(true)

  bubbleWin.loadFile(path.join(__dirname, 'bubble', 'index.html'))
  bubbleWin.once('ready-to-show', () => {
    // 不 show，等第一条气泡来了再显示，避免启动时闪一下空窗
  })
}

/**
 * 摆放气泡时用的尺寸 —— 就是窗口尺寸，不是内容尺寸。
 *
 * 气泡在窗口里是底部对齐的（#wrap 用 justify-content: flex-end），
 * 所以只要把窗口底边贴到宠物头顶就行，内容多大都不影响定位。
 */
/**
 * 气泡窗口的当前尺寸。
 *
 * ⚠️ **高度是变的** —— 长翻译要更高的窗口，否则会被 `overflow:hidden` 裁掉。
 *    宽度固定（内容宽度是设计好的），高度由 `bubble-controller` 按**文本长度
 *    估算**后通过 `setBubbleHeight` 告诉我们。
 *
 *    ⚠️ **绝不能按"渲染后的内容尺寸"来设** —— 那会形成正反馈
 *       （窗口变 → 换行变 → 内容尺寸变 → 窗口再变，最后塌缩成一字一行）。
 *       估算函数只看字符数，和窗口当前多大无关，所以没有这个环。
 */
const bubbleSize = { width: BUBBLE_W, height: BUBBLE_H }
/**
 * 气泡窗口的尺寸上限比例 —— **从 bubble-controller 取，不要在这里再写一份**。
 * 那边按这个比例算文本放不放得下，这边按同一个比例夹窗口高度；
 * 两边不一致的话会出现"渲染层以为装得下、主进程却夹掉了"。
 */
const BUBBLE_MAX_H_RATIO = bubbleController.MAX_HEIGHT_RATIO ?? 1.0

function currentWorkArea () {
  try {
    const petBounds = win && !win.isDestroyed() ? win.getBounds() : null
    const display = petBounds
      ? screen.getDisplayNearestPoint({ x: petBounds.x, y: petBounds.y })
      : screen.getPrimaryDisplay()
    return display.workArea
  } catch {
    return null
  }
}

/**
 * 气泡窗口的预热延迟。
 *
 * 3 秒是一个折中：桌宠的首屏（加载 512×512 的动画帧）大概要 1~2 秒，
 * 让气泡错开这段高峰；而用户第一次看到气泡一般在 5 秒之后（启动打招呼），
 * 3 秒足够赶在前面。
 */
const BUBBLE_WARMUP_MS = 3000

let bubbleReady = false

/**
 * 确保气泡窗口和控制器就绪。**所有要用气泡的地方都要先过这里。**
 *
 * 为什么需要它：气泡窗口原来是启动时无条件创建的，占着 76MB 内存却可能
 * 一整轮对话都用不上（用户可能把气泡关了、或者一直没触发状态变化）。
 * 现在改成延后 3 秒预热，但**任何一次"要说话"都会立刻补建** ——
 * 所以延后只是省内存，不会丢话。
 */
function ensureBubble () {
  if (bubbleReady) return
  bubbleReady = true
  createBubbleWindow()
  initBubble()
  console.log('[pet] 气泡窗口已就绪')
}

function initBubble () {
  const table = dialogues.load(process.env.PET_LANG || 'zh', app.getPath('userData'))

  bubble = bubbleController.createController({
    dialogues: table,
    settings: bubbleSettings,
    getPetBounds: () => (win && !win.isDestroyed() ? win.getBounds() : null),
    characterHeadOffset,
    getBubbleSize: () => bubbleSize,
    /**
     * 设定气泡窗口高度（由 bubble-controller 按文本长度算好）。
     *
     * 会夹到 `[BUBBLE_H, 屏幕可用高度 × 0.6]` —— 太矮装不下、太高盖住桌面。
     * 窗口本身不在这里 setBounds：位置由 `onMove` 统一负责，
     * 两处都设的话会互相覆盖。
     */
    setBubbleHeight: (h) => {
      const work = currentWorkArea()
      const maxH = work ? Math.floor(work.height * BUBBLE_MAX_H_RATIO) : BUBBLE_H * 2
      const next = Math.max(BUBBLE_H, Math.min(maxH, Math.round(Number(h) || BUBBLE_H)))
      if (next !== bubbleSize.height) {
        bubbleSize.height = next
      }
    },
    workArea: currentWorkArea,
    onShow: (payload) => {
      if (!bubbleWin || bubbleWin.isDestroyed()) return
      if (!bubbleWin.isVisible()) bubbleWin.showInactive()   // showInactive：不抢焦点
      bubbleWin.webContents.send('bubble:show', payload)
    },
    onHide: () => {
      if (!bubbleWin || bubbleWin.isDestroyed()) return
      bubbleWin.webContents.send('bubble:hide')
    },
    onMove: (x, y) => {
      if (!bubbleWin || bubbleWin.isDestroyed()) return
      // ⚠️ 尺寸必须固定，**绝不能按内容尺寸 setBounds**。
      //
      // 踩过的坑：曾经用 reportSize 上报的内容尺寸来 setBounds，
      // 结果形成正反馈 —— 窗口缩小 → CSS 的 max-width:100% 跟着变小 →
      // 文字换行 → 气泡更窄 → 上报更小 → 窗口再缩 → 塌缩成一字一行。
      // 内容宽度依赖窗口宽度，就不能反过来让窗口跟着内容走。
      // ⚠️ 用 bubbleSize.height（会变），不是常量 —— 长翻译时窗口要更高
      bubbleWin.setBounds({ x, y, width: BUBBLE_W, height: bubbleSize.height })
    },
  })
}

// ───────────────── 设置菜单（右键宠物弹出）─────────────────

/**
 * 宠物形象的菜单项（需求 3）。
 *
 * 有几套素材就列几项 —— 见 availableStyles() 的约定。
 * 只有一套时也照常显示（勾选态），不做特殊处理：
 * "菜单里为什么没有这一项"比"只有一项可选"更让人困惑。
 */
/**
 * DSH 那几项：状态 + 接上 / 断开。
 *
 * ⚠️ **为什么这里必须是可点的，不能只是一行状态文字**：
 *    原来"怎么接上"写的是「去仓库根目录跑 node install-plugin.mjs」——
 *    macOS 上从源码跑还算自然，**但 Windows 用户装的是 .exe**：
 *    没有那个目录、多半也没装 Node.js，**这条提示根本没法照做**。
 *    现在接插件由 App 自己做（它自带 Node 运行时和 fs）。
 *
 * 装上之后**只剩「重启 DSH」需要用户动手** —— 那一步躲不掉，
 * 插件是 DSH 启动时加载的。所以文案必须把这一点说清楚，
 * 不然用户会以为"点了没用"。
 */
function dshMenuItems () {
  const connected = bridge.isConnected()
  const profiles = dshPlugin.listProfiles()
  const installed = profiles.filter((p) => p.installed)

  const items = [{
    label: connected
      ? 'DSH：已连接 ✅'
      : (installed.length ? 'DSH：已接上，等 DSH 重启' : 'DSH：未接上'),
    enabled: false,
  }]

  // 没装 DSH 是**完全正常**的用法（她本来也能自己待着），
  // 所以这里只说明一下，不做成"错误"。
  if (profiles.length === 0) {
    items.push({ label: '  （没找到 DSH，不用管）', enabled: false })
    return items
  }

  for (const p of profiles) {
    items.push({
      label: `  ${p.installed ? '断开' : '接上'} ${p.name}`,
      click: () => {
        const r = p.installed
          ? dshPlugin.remove(p.patchPath)
          : dshPlugin.install(p.patchPath)
        if (!r.ok) {
          console.warn(`[pet] ${p.installed ? '断开' : '接上'} ${p.name} 失败: ${r.error}`)
          return
        }
        ensureBubble()
        bubble?.sayExternal({
          text: p.installed
            ? `已经从「${p.name}」断开了。重启 DSH 就彻底分开。`
            : `已经把插件接进「${p.name}」了。重启 DSH 才会生效 —— 插件是启动时加载的。`,
          durationMs: 12000,
          tone: 'normal',
        })
      },
    })
  }
  return items
}

/**
 * 「启动」这一组：开机启动 + 跟随 DSH 一起启动。
 *
 * ── ⚠️ 勾选状态必须**实时问系统**，不能读我们自己存的 ──
 *
 * 用户完全可以去系统设置里把开机启动关掉（macOS 的「登录项与扩展」、
 * Windows 的「任务管理器 → 启动应用」）。那时我们菜单里的勾**必须跟着没** ——
 * 否则就是个骗人的界面。
 *
 * 所以这里每次弹菜单都调 `launch.loginItemState()`，读的是系统真实状态。
 * `launch.json` 里那份 `openAtLogin` 只是**意图**，显示以系统为准。
 */
function launchMenuItems () {
  const cfg = launch.read(app)
  const st = launch.loginItemState(app)

  // ⚠️ macOS 13+ 有个中间态：**注册上了但用户还没批准**。
  //    这时实际不会启动，但也不该显示成"没勾"让人以为点坏了 ——
  //    文案要说清楚"等系统批准"。
  const loginLabel = st.needsApproval
    ? '开机启动（等系统设置里批准）'
    : (st.registered && !st.on ? '开机启动（被系统设置禁用了）' : '开机启动')

  return [
    { label: '启动', enabled: false },
    {
      label: loginLabel,
      type: 'checkbox',
      checked: st.on,
      click: (menuItem) => {
        const want = menuItem.checked
        if (!launch.setLoginItem(app, want)) return
        launch.write(app, { openAtLogin: want })
        console.log(`[launch] 开机启动 → ${want}`)
      },
    },
    {
      label: '跟随 DSH 一起启动',
      type: 'checkbox',
      checked: cfg.followDsh,
      click: (menuItem) => {
        // ⚠️ 勾上的同时把 `exePath` 写进去 —— 插件要靠它 spawn 我们。
        //    用户勾的这一刻我们一定在跑，所以拿得到真实路径。
        const ok = launch.write(app, {
          followDsh: menuItem.checked,
          exePath: process.execPath,
        })
        console.log(`[launch] 跟随 DSH → ${menuItem.checked}${ok ? '' : '（写入失败）'}`)
      },
    },
  ]
}

function styleMenuItems () {
  const styles = availableStyles()
  const items = [{ label: '宠物形象', enabled: false }]

  for (const style of styles) {
    // ⚠️ **素材没做完的形象不该能选中。**
    //
    //    踩过的坑：`tools/new-pet.mjs` 建骨架时会写一个 manifest.json，
    //    而菜单原来**只检查 manifest 在不在** —— 于是刚建完骨架、
    //    一张图都还没有的「月薪喵」立刻出现在菜单里，
    //    用户点过去看到的是一个**缺图占位符**，而且不知道怎么办。
    //
    //    现在按「需要几张 / 实际有几张」判断，不齐就标出来并禁用。
    const need = style.frameCount
    const have = style.frameHave
    const ready = need === 0 || have >= need

    // ⚠️ **素材不齐也允许切。**
    //
    //    第一版是不齐就禁用 —— 但做一套新宠物本来就是「做几张就想看一眼」，
    //    禁用等于逼人全部做完才能看，太重。
    //    现在缺的帧会自动用 awake 顶替（见 pet.js 的 showFrame），
    //    所以切过去**不会崩、不会空白**，只是动作不全 —— 标注出来就行。
    items.push({
      label: ready ? `  ${style.name}` : `  ${style.name}（还缺 ${need - have}/${need} 张）`,
      type: 'radio',
      checked: bubbleSettings.style === style.id,
      click: () => {
        bubbleSettings.style = style.id
        savePosition()
        applyStyle(style.id)
      },
    })
  }
  return items
}

/**
 * 提示音开关（需求 1 的辅助：她被别的窗口盖住时，声音是唯一的提醒）。
 */
function soundMenuItems () {
  return [{
    label: '提示音（需要确认时）',
    type: 'checkbox',
    checked: bubbleSettings.sound !== false,
    click: (menuItem) => {
      bubbleSettings.sound = menuItem.checked
      savePosition()
      applySoundSetting()
    },
  }]
}

/** 把声音开关推给渲染层（它管播放，主进程只管偏好）。 */
function applySoundSetting () {
  sendToRenderer('pet:sound', { enabled: bubbleSettings.sound !== false })
}

function translateMenuItems () {
  const config = translateConfig.load(app.getPath('userData'))
  const usingLlm = config.provider === 'llm'
  const hasKey = Boolean(config.llm.apiKey)

  const pick = (provider) => {
    translateConfig.save(app.getPath('userData'), { ...config, provider })
    translateClient.clearLlmCooldown()
    bubbleSettings.translate = true
    savePosition()
    console.log(`[translate] 已切换到 ${provider}`)
  }

  return [
    {
      label: '复制英文即翻译',
      type: 'checkbox',
      checked: bubbleSettings.translate !== false,
      click: (menuItem) => {
        bubbleSettings.translate = menuItem.checked
        savePosition()
      },
    },
    { type: 'separator' },
    {
      // ⚠️ 不要写成「翻译记忆库 + 机器翻译」——
      // "机器翻译"在行业里是"和人工翻译相对"的意思，**不表示本机**，
      // 但普通用户容易读成"这台机器"。加个"在线"就没歧义了。
      label: '接口：免费在线翻译',
      type: 'radio',
      checked: !usingLlm,
      click: () => pick('mymemory'),
    },
    {
      // 没填 key 时置灰并说明原因 —— 选了也用不了，不如直接告诉用户
      label: usingLlm && !hasKey ? '接口：自定义大模型（未填 Key）' : '接口：自定义大模型',
      type: 'radio',
      checked: usingLlm,
      enabled: hasKey,
      click: () => pick('llm'),
    },
    {
      label: '设置翻译接口…',
      click: openSettingsWindow,
    },
  ]
}

function buildMenuTemplate (visible) {
  // ⚠️ **这里原来有「隐藏胖头鱼 / 显示胖头鱼」一项，用户要求删掉。**
  //    她是个置顶桌宠，「隐藏」不是常用操作；而且**藏起来之后就找不回来了**
  //    —— 原来唯一的找回方式是点程序坞图标，现在程序坞里也没有她了，
  //    见 hideDockIcon。留着这一项等于挖坑：点一下她消失，然后再也叫不出来。
  //    `toggleVisibility` 这个函数先留着，以后要做「按快捷键临时藏一下」还能用。
  void visible
  return [
    // ── DSH 连接状态 + 接/断 ──
    //
    // ⚠️ 原来这里是一条**不可点**的状态文字，而"怎么接上"要靠用户
    //    自己去仓库根目录跑 `node install-plugin.mjs` ——
    //    **Windows 用户装了 .exe 之后根本没有那个目录**，
    //    等于给了一条没法照做的提示。现在 App 自己就能接（见 dsh-plugin.js）。
    ...dshMenuItems(),
    { type: 'separator' },
    ...launchMenuItems(),
    { type: 'separator' },
    ...styleMenuItems(),
    { type: 'separator' },
    ...soundMenuItems(),
    ...translateMenuItems(),
    { type: 'separator' },
    ...bubbleMenuItems(),
    { type: 'separator' },
    ...dialogueMenuItems(),
    // ── 调试：模拟一次出错（⚠️ **只在开发模式显示**）──
    //
    // 这条链路（"出错常驻"）平时很难复现 —— 得真的等到 agent 报错，
    // 而那时用户多半正忙。所以留一个手动入口。
    //
    // ⚠️ **但它不该出现在用户拿到的包里。**
    //    用户实测反馈："模拟出错的选项没有去掉"。
    //    对一个普通用户来说，"模拟一次出错"是个看不懂、也不敢点的东西。
    //
    //    所以用 `app.isPackaged` 卡住：**开发模式（开发壳 / npm start）能看见，
    //    打出来的 .app / .exe 里没有**。
    //    （插件那边收到 `test-error` 的处理留着不动 —— 开发时还要用。）
    ...(app.isPackaged ? [] : [
      {
        label: '模拟一次出错（验证"举着手常驻"）',
        click: () => {
          const sent = bridge.request({ type: 'request', kind: 'test-error' })
          console.log(`[pet] 请求插件模拟出错 ${sent ? '' : '—— 插件没连着'}`)
          if (!sent) {
            ensureBubble()
            bubble?.sayExternal({
              text: 'DSH 插件没连着，模拟不了。\n（先确认 DSH 在跑、插件已加载）',
              durationMs: 6000,
              tone: 'error',
            })
          }
        },
      },
      { type: 'separator' },
    ]),
    {
      label: '打开数据目录',
      click: () => {
        const dir = statePath()
        if (dir) shell.openPath(path.dirname(dir))
      },
    },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ]
}

/**
 * 右键菜单的内容。**入口有两个**：右键宠物本体，或者点菜单栏的托盘图标。
 * （原来还写过一个"隐藏胖头鱼"，已经删了 —— 藏起来就找不回来了。
 *   程序坞图标也按用户要求隐藏了，见 hideDockIcon。）
 *
 * 气泡的逐状态开关（需求 4）。
 *
 * fixed 的状态（needsInput / blocked）不出现勾选框 —— 它们是这个产品存在的理由，
 * 关掉就等于把桌宠降级成一个纯装饰。用一条不可点的说明代替勾选框，
 * 让人知道"这两个不是漏了，是故意不给你关"。
 */
/**
 * 台词相关的菜单项。
 *
 * 为什么要「编辑台词」这个入口：话术一直存在 `dialogues/zh.md`，
 * **但没有任何地方告诉用户它在哪** —— 右键菜单里的「打开数据目录」
 * 打开的是 userData，而话术以前只在 App 目录里。
 * 更麻烦的是**打包成 .dmg 之后 App 包是只读的**，用户根本改不了。
 *
 * 现在：编辑时把内置那份复制到 userData 再打开（**已存在则不覆盖**，那是用户改过的）。
 * 之后启动时 userData 那份优先，所以改完重启就生效，升级也不会冲掉。
 */
function dialogueMenuItems () {
  const lang = process.env.PET_LANG || 'zh'
  let userPath = null
  try {
    // ⚠️ 不能在模块加载期算 userData 路径（见 statePath 上面的注释），
    //    所以这里在"构建菜单"时才算 —— 那时 app 已经 ready。
    userPath = dialogues.userCopyPath(lang, app.getPath('userData'))
  } catch { /* 拿不到就按"还没有副本"处理 */ }

  const editing = Boolean(userPath && fs.existsSync(userPath))
  return [
    {
      label: editing ? '编辑台词（改的是你自己的那份）' : '编辑台词…',
      click: () => {
        let dest
        try {
          const r = dialogues.ensureUserCopy(lang, app.getPath('userData'))

  // 内置话术升级了 → **弹个提示**。只写日志的话用户根本看不到，
  // 而这件事他必须知道：他的改动被备份了、文件被换成了新版内置。
  const notice = dialogues.takeUpdateNotice?.()
  if (notice) {
    const { dialog } = require('electron')
    dialog.showMessageBox({
      type: 'info',
      title: '台词文件已更新',
      message: `胖头鱼的话术升级了（${notice.from || '旧版'} → ${notice.to}）`,
      detail: '你原来那份已经备份好了，不会被丢掉：\n\n'
        + `${notice.backup}\n\n`
        + '台词文件本身已经换成新版内置。想把你的改动搬回来，'
        + '对比一下那个备份文件就行。',
      buttons: ['打开备份所在文件夹', '知道了'],
      defaultId: 1,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) shell.showItemInFolder(notice.backup)
    }).catch(() => {})
  }
          dest = r.path
          console.log(`[menu] 编辑台词 → ${dest}${r.created ? '（已从内置复制一份）' : ''}`)
        } catch (err) {
          console.error('[menu] 没法准备台词副本:', err.message)
          return
        }
        shell.openPath(dest).then((err) => {   // 用系统默认编辑器
          if (err) console.error('[menu] 打不开编辑器:', err)
        })
      },
    },
    ...(editing
      ? [{
          label: '恢复默认台词',
click: async () => {
              // ⚠️ **必须二次确认。** 这一下是**不可逆**的：
              //    用户那份台词会被删掉，下次启动回到内置默认。
              //    用户明确要求加这一步（"二次确认后才正式重置"）。
              const { dialog } = require('electron')
              // 程序坞藏起来之后 app 是 accessory，弹窗要主动抢一下焦点，
              // 否则对话框可能开在别的窗口后面 —— 用户会以为点了没反应。
              if (process.platform === 'darwin' && app.focus) app.focus({ steal: true })
              const opts = {
                type: 'warning',
                title: '恢复默认台词',
                message: '确定要恢复成内置的默认台词吗？',
                detail: '你自己改的那份会先**备份**、再从原位置删掉，'
                  + '下次启动就用内置那份了。\n\n'
                  + `原文件：${userPath}`,
                buttons: ['恢复默认', '取消'],
                // ⚠️ **默认按钮和 Esc 都落在"取消"上。**
                //    手滑敲回车不该把用户改的台词弄没 —— 想恢复得**主动点**「恢复默认」。
                defaultId: 1,
                cancelId: 1,
                noLink: true,
              }
              let response = 1
              try {
                const r = (win && !win.isDestroyed())
                  ? await dialog.showMessageBox(win, opts)
                  : await dialog.showMessageBox(opts)
                response = r.response
              } catch (err) {
                console.error('[menu] 恢复默认台词：弹确认框失败:', err.message)
                return
              }
              if (response !== 0) {
                console.log('[menu] 恢复默认台词：用户取消了')
                return
              }

              // ① 先备份 —— 万一用户改错了还能捞回来
              try {
                const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '')
                const backup = `${userPath}.bak-before-reset-${stamp}`
                fs.copyFileSync(userPath, backup)
                console.log(`[menu] 恢复默认台词：已备份到 ${backup}`)
              } catch (err) {
                console.error('[menu] 备份失败，为安全起见不删了:', err.message)
                return
              }
              // ② 删掉用户那份
              try {
                fs.unlinkSync(userPath)
                console.log(`[menu] 已删除用户台词副本: ${userPath}`)
              } catch (err) {
                console.error('[menu] 删除失败:', err.message)
                return
              }
              // ③ **立刻换回内置那份** —— 不然要重启才生效，用户会以为没反应
              try {
                const table = dialogues.load(process.env.PET_LANG || 'zh', app.getPath('userData'))
                bubble?.setDialogues?.(table)
                console.log(`[menu] 已恢复默认台词：${Object.keys(table).length} 个状态`)
              } catch (err) {
                console.error('[menu] 重新载入台词失败:', err.message)
              }
            },
        }]
      : []),
  ]
}

function bubbleMenuItems () {
  const items = [{ label: '气泡对话', enabled: false }]

  const table = bubble?.getDialogues?.() ?? {}
  for (const [state, entry] of Object.entries(table)) {
    if (entry.fixed) {
      items.push({ label: `  ${labelOf(state)} · 固定开启`, enabled: false })
      continue
    }
    items.push({
      label: `  ${labelOf(state)}`,
      type: 'checkbox',
      checked: bubbleSettings.enabled[state] !== false,
      click: (menuItem) => {
        setBubbleEnabled(state, menuItem.checked)
      },
    })
  }
  return items
}

/** 状态名 → 给人看的名字。映射在 src/state-labels.js（唯一真源）。 */
function labelOf (state) {
  return STATE_LABELS[state] ?? state
}

function toggleVisibility () {
  if (!win || win.isDestroyed()) return
  if (win.isVisible()) win.hide()
  else win.showInactive() // showInactive：显示但不抢焦点，桌宠不该打断你打字
}

// ─────────────────────────── IPC ───────────────────────────

/** renderer 报告指针是否压在宠物身上 */
ipcMain.on('pet:hover', (_event, hovering) => setInteractive(Boolean(hovering)))

// 渲染层每次状态切换都报一次 —— 气泡据此挑话。
// 通道名和"主→渲染"的 pet:state 区分开，避免双向同名。
ipcMain.on('pet:state-changed', (_event, clip, opts) => {
  ensureBubble()
  ensureBubble()
  bubble?.onState(clip, opts)
})

// ── 设置弹窗 ──

ipcMain.handle('settings:load', () => {
  const config = translateConfig.load(app.getPath('userData'))
  return { provider: config.provider, llm: { ...config.llm } }
})

ipcMain.handle('settings:test', async (_event, values) => {
  const config = translateConfig.normalize({ provider: 'llm', llm: values })
  const result = await translateClient.testConnection(config)
  // 测通了就把冷却清掉 —— 用户刚修好配置，没道理还让它等
  if (result.ok) translateClient.clearLlmCooldown()
  console.log(`[translate] 连通性测试：${result.ok ? '成功 ' + result.ms + 'ms' : '失败 ' + result.error}`)
  return result
})

ipcMain.handle('settings:save', (_event, values) => {
  const saved = translateConfig.save(app.getPath('userData'), { provider: 'llm', llm: values })
  translateClient.clearLlmCooldown()
  // 保存即切换 —— 用户点保存的意图就是"以后用这个大模型"
  bubbleSettings.translate = true
  savePosition()
  closeSettingsWindow()
  console.log('[translate] 已切换到自定义大模型')
  return { ok: true, config: saved }
})

ipcMain.on('settings:cancel', closeSettingsWindow)

// 单击她 → 弹余额。数据是插件推过来的，这里只负责显示。
ipcMain.on('pet:show-balance', showBalance)

/**
 * 按内容高度调整弹窗。
 *
 * 宽度固定（内容宽度是设计好的），高度交给页面自己报 ——
 * 这样以后加字段、改文案都不会把底部按钮挤出可视区。
 */
ipcMain.on('settings:resize', (_event, height) => {
  if (!settingsWin || settingsWin.isDestroyed()) return
  const h = Number(height)
  if (!Number.isFinite(h) || h < 120 || h > 900) return
  settingsWin.setContentSize(SETTINGS_W, Math.ceil(h))
})

// 「时刻」：打招呼、被吵醒。和状态分开处理，不参与升级计时。
ipcMain.on('pet:moment', (_event, kind) => {
  ensureBubble()
  bubble?.onMoment(kind)
})

/**
 * 右键宠物 → 弹出设置菜单。
 *
 * 托盘图标在菜单栏右上角，很不显眼 —— 用户找不到设置入口是必然的。
 * 右键桌宠本身是最符合直觉的位置。
 */
ipcMain.on('pet:menu', () => {
  const visible = Boolean(win && !win.isDestroyed() && win.isVisible())
  const items = buildMenuTemplate(visible)

  // 菜单看不见摸不着，出问题时没有日志就只能靠猜。
  // 这条日志抓到过 labelOf() 漏了 wave/startle、菜单里显示英文 key。
  console.log(`[menu] ${items.length} 项: ` + items.map((i) => i.label ?? '---').join(' | '))

  // ⚠️⚠️ **菜单弹出期间必须关掉点击穿透。**
  //
  //    桌宠窗口默认是"整窗穿透鼠标"的（见 createWindow 里的
  //    `setIgnoreMouseEvents(true, { forward: true })`）——
  //    只有指针真压在宠物身上时才接管。
  //
  //    问题是：**原生菜单是从这个窗口弹出来的**。窗口既然在穿透，
  //    点菜单外面那一下就会**穿透过去**，原生菜单收不到该有的 dismiss，
  //    **菜单就一直挂在那儿**（用户在 Windows 上实测报的就是这个）。
  //
  //    弹出的这一段临时设成"可交互"，关掉时再恢复穿透。
  setInteractive(true)

  // ── ⚠️⚠️ Windows：必须让窗口**临时可激活**，否则菜单关不掉 ──
  //
  //    踩到的：用户报"点菜单外面菜单不关"。第一版只改了"点击穿透"
  //    （`setIgnoreMouseEvents`）—— **没用**，因为那不是原因。
  //
  //    真正的原因是 **`focusable: false`**：
  //    Windows 上这个选项让窗口带上 `WS_EX_NOACTIVATE`，**窗口不可激活**。
  //    而原生弹出菜单需要**一个能激活的宿主窗口**才能进入系统的模态菜单循环 ——
  //    宿主不可激活时，系统不认为这个菜单"有主"，
  //    **点外面时也就不知道该 dismiss 哪个菜单**，于是它一直挂着。
  //
  //    `setFocusable` 在文档里只对 **Windows / Linux** 有效（macOS 无此概念），
  //    所以这里按平台判断，免得在 macOS 上报错。
  //
  //    ⚠️ 这样做的代价：菜单开着的那一小会儿她"可激活"。
  //    但用户是**主动右键她**才弹出菜单的，这一下抢焦点是预期内的；
  //    菜单一关立刻 `setFocusable(false)` 恢复"绝不抢焦点"。
  let restoreFocusable = false
  if (process.platform === 'win32' && typeof win.setFocusable === 'function') {
    try {
      win.setFocusable(true)
      win.focus()
      restoreFocusable = true
    } catch (e) {
      console.warn(`[menu] 临时设可激活失败（菜单可能关不掉）: ${e.message}`)
    }
  }

  Menu.buildFromTemplate(items).popup({
    window: win,
    // 菜单关掉（选了某一项、按 Esc、点外面）都会走这个回调
    callback: () => {
      if (restoreFocusable && win && !win.isDestroyed()) {
        try { win.setFocusable(false) } catch { /* 关窗口时可能已经没了 */ }
      }
      // ⚠️ 这里**一律设回穿透**，不做"恢复原状"：
      //    用户刚点完菜单，指针多半已经不在她身上了；
      //    就算还在，穿透也只是"这一下点不到她" —— 鼠标一动
      //    渲染层的 mousemove 判定就会重新接管。
      //    反过来（留一块可交互区）会变成"她挡住的那 220×240 一片点不动"，
      //    那个比这个烦人得多。
      setInteractive(false)
    },
  })
})


/** 拖动：renderer 给屏幕坐标，主进程跟着挪窗口 */
ipcMain.on('pet:drag', (_event, { dx, dy }) => {
  // 拖动时气泡跟着走，否则会停在原地变成"孤儿气泡"
  queueMicrotask(() => bubble?.reposition())
  if (!win || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  win.setPosition(Math.round(x + dx), Math.round(y + dy))
})

/** 拖动结束时把位置写盘 */
/**
 * 缩放：renderer 给一个**倍率**，主进程算窗口尺寸并**锚定底边中心**。
 *
 * ⚠️ **为什么必须锚定底边中心，不能只改尺寸**：
 *    窗口的 (x, y) 是左上角。尺寸一变而左上角不动的话，
 *    宠物的**脚会顺着往下跑**（她站在窗口底部）——
 *    放大一次就往下掉一截，看起来像"跳了一下"。
 *
 * ⚠️ 下限 0.5（再小看不清）；**上限不设** —— 用户要先看放大效果，
 *    糊不糊由他自己判断（素材 512 / 内容高 435，2 倍以上会开始软）。
 */
ipcMain.on('pet:resize', (_event, { scale }) => {
  if (!win || win.isDestroyed() || !Number.isFinite(scale)) return
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
  if (Math.abs(next - petScale) < 0.001) return

  const [x, y] = win.getPosition()
  const [w, h] = win.getSize()
  petScale = next
  const nw = winW(), nh = winH()
  // 底边中心不变：横向按中心补偿、纵向按底边补偿
  const nx = Math.round(x + (w - nw) / 2)
  const ny = Math.round(y + (h - nh))
  win.setBounds({ x: nx, y: ny, width: nw, height: nh })
  // 气泡跟着走（它的定位靠 getPetBounds 的真实尺寸，不用改大小）
  ensureBubble()
  bubble?.reposition()
  console.log(`[pet] 缩放 → ${(next * 100).toFixed(0)}%  (${nw}×${nh})  位置 ${nx},${ny}`)
})

/** 缩放结束写盘（和拖动结束一样） */
ipcMain.on('pet:resize-end', savePosition)

/** 问当前缩放（renderer 启动时同步一次） */
ipcMain.handle('pet:get-scale', () => petScale)

/**
 * 问一句"我是不是第一次启动" —— 渲染层据此决定要不要说引导台词。
 *
 * 用 `invoke` 而不是"主进程推"：渲染层问的时机在它自己 ready 之后，
 * 推的话可能早于监听注册（踩过 `once('did-finish-load')` 那次的坑）。
 */
ipcMain.handle('pet:is-first-run', () => {
  const first = checkFirstRun()
  // 打一行 —— 这条链路（主进程判断 → 渲染层询问 → 说引导）跨了三个文件，
  // 不打印的话"没反应"时分不清是判断错了还是通道没通。
  console.log(`[pet] 渲染层问首次启动 → ${first}`)
  return first
})

/** 渲染层说"引导已经展示过了" → 记下来，下次不再说 */
ipcMain.on('pet:welcomed', () => {
  markWelcomed()
  console.log('[pet] 已记录「引导说过了」')
})

/**
 * 渲染层主动让气泡说一句话（目前只有"首次启动的引导"用）。
 *
 * ⚠️ 为什么不让渲染层直接改自己的 DOM：气泡是**另一个窗口**，
 *    渲染层碰不到它。所有台词都得经 `bubble` 控制器。
 *
 * ⚠️ 走的是 `sayExternal` —— 它会**上翻译锁**、占住 `currentState`，
 *    所以状态台词不会立刻把引导顶掉。这正是引导需要的效果。
 */
/**
 * 用户点了一下她 = 「我看到了」。
 *
 * 需求：「错误状态需要常驻 …… 用户查看 dsh 窗口时再停止」。
 * 这是三种"停止"方式里**最可靠的一种** —— 用户主动表态，不需要任何权限、
 * 也不会误判（另外两种见 attention.js：agent 恢复活动 / 前台切到 DSH）。
 *
 * ⚠️ 走 `bubble.acknowledge()` 而不是 `hideExternal()` ——
 *    后者只撤"外部气泡"（翻译那种），而这里要撤的是**状态气泡**。
 */
ipcMain.on('pet:acknowledge', () => {
  console.log('[pet] 用户点了她 → 「我看到了」，停止常驻和催促')
  ensureBubble()
  bubble?.acknowledge?.()
  // ⚠️ **还要告诉 DSH 那边的插件。**
  //    常驻的 blocked 是**插件**推过来的（它现在会一直保持），
  //    只撤桌宠的气泡是不够的 —— 状态还在 blocked，动画还是举着手，
  //    而且下次插件再 publish 时又会把气泡推回来。
  //    （bridge 是双向的：`request` 就是这个方向。）
  const sent = bridge.request({ type: 'request', kind: 'ack' })
  console.log(`[pet] 已通知插件「用户确认了」${sent ? '' : '（插件没连着）'}`)
})

ipcMain.on('pet:say', (_event, payload) => {
  if (!payload || typeof payload.text !== 'string') return
  ensureBubble()
  bubble?.sayExternal({
    text: payload.text,
    note: typeof payload.note === 'string' ? payload.note : '',
    durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : 12000,
    tone: typeof payload.tone === 'string' ? payload.tone : 'normal',
  })
})

ipcMain.on('pet:drag-end', savePosition)

ipcMain.handle('pet:get-bounds', () => {
  if (!win || win.isDestroyed()) return null
  const [x, y] = win.getPosition()
  // ⚠️ 用**当前**尺寸，不是基准 —— 气泡靠这个定位，写死常量的话缩放之后气泡就会歪。
  return { x, y, width: winW(), height: winH() }
})

/** renderer 主动问连接状态（启动时同步一次） */
/**
 * 「用户去看 DSH 了」的检测。
 *
 * 三种"停止常驻"的方式里，这一条是**自动**的那条（另外两条：
 * DSH 里 agent 恢复活动、点一下她）。详细的取舍见 `src/attention.js` 的文件头。
 *
 * ⚠️ `shouldWatch` 只在 **`blocked` / `needsInput`** 时返回 true ——
 *    这两个是"举着手等你"的状态。其余时候完全不跑那个 250ms 的 osascript。
 */
const attention = attentionWatcher.createWatcher({
  shouldWatch: () => {
    const st = bubble?.getState?.()
    return st === 'blocked' || st === 'needsInput' || st === 'needInput'
  },
  onSeen: () => {
    // 和"点一下她"走同一条路：撤气泡 + 停催促 + **通知插件**
    ensureBubble()
  bubble?.acknowledge?.()
    bridge.request({ type: 'request', kind: 'ack' })
  },
})

/**
 * 插件等多久还没连上，就说一句提示。
 *
 * 30 秒：DSH 侧插件的重连退避是从 1 秒起步翻倍到 30 秒，
 * 正常情况几秒内就握上手了；30 秒还没动静基本可以确定"没装/没重启"。
 */
const PLUGIN_HINT_DELAY_MS = (() => {
  // 环境变量覆盖 —— 只为**测试**方便（把 30 秒压成 3 秒）。
  // 生产路径不受影响：没设这个变量就是 30 秒。
  const raw = Number(process.env.PET_PLUGIN_HINT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 30000
})()

/**
 * 启动后盯一会儿：**插件一直没连上就主动说一句**。
 *
 * ── 为什么需要它（这是实测踩出来的）──
 *
 * 桌宠靠一个 DSH 插件知道 agent 在干什么。而那个插件**要手动装**
 * （`node install-plugin.mjs`）+ **重启 DSH** 才生效 ——
 * 三步里漏掉任何一步，桌宠的表现是：
 *
 *     · 正常显示、能拖能点、能说话
 *     · **但永远停在"空闲"**
 *     · **而且不报任何错**
 *
 * 看起来就像"DSH 没活干"，用户会以为**桌宠坏了**或者**插件根本没做**。
 * （清空重装验证时我自己就漏了第 ② 步，愣了一会儿才发现。）
 *
 * ⚠️ 所以这里只提示一次，而且**文案要同时覆盖两种情况** ——
 *    因为"没用 DSH"和"插件没装好"在桌宠看来长得一模一样。
 */
function watchForPlugin () {
  const timer = setTimeout(() => {
    if (bridge.isConnected()) {
      console.log('[pet] 插件已连上，不需要提示')
      return
    }
    console.log(`[pet] ${PLUGIN_HINT_DELAY_MS / 1000} 秒了插件还没连上 → 说一句提示`)
    ensureBubble()

    // ⚠️ **文案不能再叫用户去跑命令。**
    //    原来写的是「跑一下 node install-plugin.mjs --profile desktop」——
    //    这在 macOS 开发者机器上说得通，**但 Windows 用户装的是 .exe**：
    //    他没有那个项目目录、多半也没装 Node.js，**这条提示根本没法照做**。
    //    现在接插件由 App 自己做（启动时也试过一轮，见 dsh-plugin.js），
    //    所以这里只可能是三种情况，分开说。
    const st = dshPlugin.autoInstall()
    let text
    if (st.action === 'no-dsh') {
      // ⚠️ 这条要覆盖**三种**"没找到"的原因，而且给出可操作的办法 ——
      //    「没装 DSH」和「装了但位置不一样」从桌宠这边看**长得一模一样**。
      text = [
        '我没找到 DSH，所以现在只能自己待着。',
        '',
        '如果你在用 DSH，可能是这几种情况：',
        '  · 还没启动过它 —— 先启动一次，profile 才会建出来',
        '  · 装在别的位置 —— 设个环境变量 DSH_HOME 指过去',
        `  · 就是没有 —— 忽略我就好～`,
        '',
        `（我的查找顺序：DSH_HOME 环境变量 > ${dshPlugin.resolveDshHome()}）`,
      ].join('\n')
    } else if (st.action === 'error') {
      text = [
        '我想接上 DSH，但没成功。',
        '',
        `原因：${st.error}`,
        '',
        '右键点我 → DSH 那几项，可以自己再试一次。',
      ].join('\n')
    } else {
      // ⚠️ **要说清"接了几个"** ——
      //    DSH 有几种形态（官方桌面端 / 浏览器形态 / 从源码跑），
      //    **每种在 ~/.dsh/profiles/ 下有自己的一个 profile**。
      //    我们**全都接上**，所以这里可能一次动了不止一个。
      const names = st.profiles.join('、')
      text = [
        st.profiles.length > 1
          ? `我把插件接进了 ${st.profiles.length} 个 DSH 配置：${names}`
          : `我已经把插件接进「${names}」了。`,
        '',
        '**重启一下 DSH** 就生效 —— 插件是它启动时加载的。',
        '',
        '（重启完还是没反应的话，右键点我看看 DSH 那行写的是什么）',
      ].join('\n')
    }
    bubble?.sayExternal({ text, durationMs: 25000, tone: 'normal' })
  }, PLUGIN_HINT_DELAY_MS)
  // 别让它拖住退出
  timer.unref?.()
  return timer
}

ipcMain.handle('pet:bridge-status', () => ({
  connected: bridge.isConnected(),
}))

/**
 * 把 manifest 里各帧的包围盒发给渲染层。
 *
 * 摸头要判"鼠标在不在她头顶"，而**头顶位置逐帧都不同** ——
 * 她坐着、站着、跳起来、举双手时差别很大。
 * 参考实现用固定比例（fx ∈ [0.05, 0.6]），那是因为它的鲸鱼总是侧身；
 * 我们角色姿态多，固定比例会判歪（她蹲下时你会"摸到空气"）。
 *
 * 数据很小（21 帧 × 4 个数），加载时发一次就够。
 */
function frameBoundsTable () {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(ASSET_DIR, activeStyle(), 'manifest.json'), 'utf8'))
    const canvas = manifest.canvasSize || 512
    const out = {}
    for (const [name, asset] of Object.entries(manifest.assets ?? {})) {
      const b = asset.bounds
      if (!b) continue
      out[name] = {
        left: b.left / canvas, top: b.top / canvas,
        right: b.right / canvas, bottom: b.bottom / canvas,
        centerX: b.centerX / canvas,
        width: b.width / canvas, height: b.height / canvas,
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 角色头顶距宠物窗口顶边多少像素。
 *
 * 为什么需要：宠物窗口 220×240，而图片是**正方形按宽 100% 缩放** ——
 * 图片只有 220 高，底部对齐后上方空出 20px；再加上角色在原画布里的
 * 顶部留白，她的头顶其实在窗口顶边下方约 29px 处。
 *
 * 气泡如果只按窗口顶边定位，就会离她头顶空出一大截（踩过）。
 *
 * ⚠️ 用**静止姿势**那一帧算，不用全局最小值 ——
 * 全局最小值来自「需要确认」那帧头顶的问号，会让气泡贴到窗口最上面。
 */
function characterHeadOffset () {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(ASSET_DIR, activeStyle(), 'manifest.json'), 'utf8'))
    const canvas = manifest.canvasSize || 512
    // ⚠️ 同样要用**当前**尺寸 —— 否则缩放后气泡离她头顶会差一大截。
    const imgH = winW()                      // 正方形图，显示高度 = 窗口宽度
    const bottomGap = Math.max(0, winH() - imgH)
    const idle = manifest.assets?.idle_pillow_awake
      ?? Object.values(manifest.assets ?? {})[0]
    return bottomGap + ((idle?.bounds?.top ?? 0) / canvas) * imgH
  } catch {
    return 0
  }
}

// ─────────────────── 翻译接口设置弹窗 ───────────────────

let settingsWin = null

/**
 * 打开设置弹窗。
 *
 * 用模态子窗口（parent + modal）：
 *   - 需要键盘输入，所以必须可聚焦（和桌宠、气泡相反）
 *   - 设 parent 之后**不进程序坞的窗口列表**，符合"气泡/辅助窗口不该
 *     看起来像独立程序"这条已经确认的约定
 *   - 同一时刻只开一个，重复点就把已有的窗口拉到前面
 */
function openSettingsWindow () {
  // ⚠️ 程序坞图标藏起来之后 app 是 accessory 身份 ——
  //    新开的窗口**不会自动成为前台**，会躲在别的窗口后面（甚至看不见）。
  //    所以打开设置前先把自己激活一下。
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return
  }

  settingsWin = new BrowserWindow({
    width: SETTINGS_W,
    // 初始高度随便给一个，页面加载完会按实际内容调整（见 settings:resize）
    height: 420,
    parent: win && !win.isDestroyed() ? win : undefined,
    modal: process.platform === 'darwin',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '设置翻译接口',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  settingsWin.setMenu(null)
  settingsWin.loadFile(path.join(__dirname, 'settings', 'index.html'))
      settingsWin.once('ready-to-show', () => {
        settingsWin.show()
        // accessory 身份下必须显式抢一次焦点，否则窗口开在别人后面
        if (process.platform === 'darwin' && app.focus) app.focus({ steal: true })
        settingsWin.focus()
      })
  settingsWin.on('closed', () => { settingsWin = null })

  // ⚠️ **这个窗口「点外面不关」，只能点保存 / 取消关。**
  //
  //    我一度加过「失焦就关」（以为用户报的"点外面不关"指的是这个窗口）——
  //    **那是错的，用户报的是右键菜单**。而且这个窗口里要填 **API Key**，
  //    用户的典型动作是"切到浏览器复制 Key"，失焦就关会把刚填的全弄丢。
  //
  //    所以：**保持它是个老老实实的窗口**，只有明确点按钮 / 按 Esc 才关。
  //    （macOS 上它是 `modal`，点父窗口会"哔"一声但不关 —— 保持一致。）
}

/** 保存后统一走这里：切到大模型 + 关窗 */
function closeSettingsWindow () {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
}

// ─────────────────────── 宠物形象（需求 3）───────────────────────

/**
 * 扫出可用的形象。
 *
 * 约定：`assets/<形象名>/manifest.json` 存在就是一个可用形象。
 * **只认目录结构，不认注册表** —— 加一套素材就是复制一个目录进去，
 * 不需要改任何代码，也不会有"注册了但目录不在"这种不一致。
 */
function availableStyles () {
  const dir = path.join(__dirname, '..', 'assets')
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const styles = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifest = path.join(dir, entry.name, 'manifest.json')
    if (!fs.existsSync(manifest)) continue
    let name = entry.name
    let description = ''
    let frameCount = 0
    let order = null
    try {
      const data = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if (data.name) name = data.name
      if (data.description) description = data.description
      // 右键菜单里的先后。**不写就排到最后** —— 所以新加一套素材
      // 不写 order 也能用，只是排在已声明的那几套后面。
      if (Number.isFinite(data.order)) order = data.order
      // ⚠️ **要数一数素材做完了没有**，不能只看 manifest 在不在。
      //    tools/new-pet.mjs 建骨架时就会写 manifest ——
      //    只看它的话，刚建完骨架的宠物立刻出现在菜单里可选中，
      //    点过去是一张都加载不出来的空白（实测踩到：用户切到月薪喵，
      //    桌面上显示的是一个缺图占位符）。
      frameCount = Array.isArray(data.frames) ? data.frames.length : 0
    } catch { /* manifest 坏了也照样列出来，用目录名兜底 */ }

    // 实际有几个 .webp（不数 manifest 里那个 done 字段 —— 没人维护它）
    let frameHave = 0
    try {
      frameHave = fs.readdirSync(path.join(dir, entry.name))
        .filter((f) => f.endsWith('.webp')).length
    } catch { /* 读不了就当 0 */ }

    styles.push({ id: entry.name, name, description, frameCount, frameHave, order })
  }

  // ⚠️ **菜单顺序按 `manifest.json` 的 `order` 排，不再靠目录名。**
  //
  //    以前直接返回 `readdirSync` 的顺序 —— 在 APFS 上碰巧是字母序，
  //    看起来"能用"，但那是**巧合**：
  //      ① 换个文件系统顺序就不一样了
  //      ② 想让 Q版大肥鱼 排第一，光靠目录名根本做不到
  //    现在顺序由每套素材自己声明（`order`），加一套新宠物不用改代码。
  //
  //    `order` 没写的排最后；都没写的之间按目录名排 ——
  //    保证结果**稳定**，不会因为目录扫描顺序变了菜单就跳来跳去。
  styles.sort((a, b) => {
    const oa = a.order ?? Number.MAX_SAFE_INTEGER
    const ob = b.order ?? Number.MAX_SAFE_INTEGER
    if (oa !== ob) return oa - ob
    return a.id.localeCompare(b.id)
  })
  return styles
}

/** 当前形象；配置里的那个目录不存在时退回第一个可用的 */
/**
 * 当前这套宠物的多帧动画（`manifest.json` 的 `clips` 段）。
 *
 * ⚠️ 读不到就返回空对象 —— 渲染层保留自己的默认值，
 *    老素材（manifest 里没写 clips 的）照常工作。
 */
function styleClips () {
  try {
    const m = JSON.parse(fs.readFileSync(
      path.join(ASSET_DIR, activeStyle(), 'manifest.json'), 'utf8'))
    return (m && typeof m.clips === 'object' && m.clips) ? m.clips : {}
  } catch {
    return {}
  }
}

function activeStyle () {
  const styles = availableStyles()
  if (styles.length === 0) return DEFAULT_STYLE
  const wanted = bubbleSettings.style
  return styles.some((s) => s.id === wanted) ? wanted : styles[0].id
}

/**
 * 把形象作用到窗口上。
 *
 * 用 loadFile 的 query 传形象名、**重新加载整个窗口**。
 * 比"发 IPC 让渲染层换图"简单得多，也不会留下半新半旧的状态。
 */
function applyStyle () {
  if (!win || win.isDestroyed()) return
  const indexHtml = path.join(__dirname, 'renderer', 'index.html')
  win.loadFile(indexHtml, { query: { style: activeStyle() } })
}

// ─────────────────── 余额 / 本轮花费 ───────────────────

/**
 * 余额和本轮花费的缓存。
 *
 * **由 DSH 插件推过来**，不是 App 自己去拉 —— 拉余额要 API Key，
 * 而 Key 应该留在 DSH 进程里。App 只收算好的数字，全程碰不到凭据。
 */
let accountInfo = { balance: null, cost: null, at: 0 }

function onAccountInfo (msg) {
  if (msg.kind === 'balance') accountInfo.balance = msg.balance
  if (msg.kind === 'cost') accountInfo.cost = msg.cost
  if (msg.kind === 'sessions') {
    // 在跑的会话数 —— 直接转给渲染层显示角标，主进程不留状态
    console.log(`[pet] 并发会话数 ← ${msg.count}`)
    sendToRenderer('pet:sessions', { count: msg.count })
  }
  accountInfo.at = Date.now()
}

/** 点她时显示。数据还没有就如实说，别显示一个假数字。 */
/**
 * 余额分档。
 *
 * ⚠️ 阈值是**绝对金额**，不是百分比 ——
 * 因为 DeepSeek 的余额接口只给"还剩多少钱"，**不给"总额是多少"**，
 * 算不出百分比。（要折成百分比就得先假设一个"满额"，那个假设各人不同，
 * 硬编一个数只会误导。）
 *
 * 想改成别的数就改这里。将来做成设置项也行。
 */
const BALANCE_TIERS = { ok: 50, low: 10 }

function balanceTier (balance) {
  const total = Number(balance?.total)
  if (!Number.isFinite(total)) return 'ok'
  if (total < BALANCE_TIERS.low) return 'critical'
  if (total < BALANCE_TIERS.ok) return 'low'
  return 'ok'
}

function showBalance () {
  const { balance } = accountInfo

  if (!balance) {
    // 没数据就**主动去问**，而不是干等下一次定时推送。
    // 刚重启那段空窗期里用户点她，只看到"还没拿到"是很挫败的。
    const asked = bridge.request({ type: 'request', kind: 'balance' })
    ensureBubble()
    bubble?.sayExternal({
      text: asked
        ? '查一下余额……\n（马上就好）'
        : '还没连上 DSH 插件。\n（余额要靠它去查，API Key 不在我这儿）',
      durationMs: asked ? 4000 : 8000,
      tone: 'normal',
    })
    return
  }

  const currency = balance.currency === 'CNY' ? '¥' : `${balance.currency} `
  const lines = [`余额 ${currency}${balance.total}`]

  // 赠送 / 充值分开列 —— 但**只在两者都非零时才列**。
  // 全是自己充的时候，"余额 ¥56.21" 下面再写一行"充值 ¥56.21" 是废话，
  // 两行一模一样反而让人以为哪里重复了。
  const granted = Number(balance.granted)
  const toppedUp = Number(balance.toppedUp)
  if (granted > 0 && toppedUp > 0) {
    lines.push(`· 赠送 ${currency}${balance.granted}`)
    lines.push(`· 充值 ${currency}${balance.toppedUp}`)
  }

  // 本轮花费是上一轮结束时的结算，有就一起显示
  if (accountInfo.cost) {
    const c = accountInfo.cost
    lines.push('')
    lines.push(`上一轮 ≈${currency}${c.total.toFixed(4)}`)
    lines.push(`· 输入 ${c.tokens} tokens`)
  }

  // 让她顺便做个表情 —— 光一串数字没有情绪
  sendToRenderer('pet:balance-mood', { tier: balanceTier(balance) })

  ensureBubble()
  bubble?.sayExternal({
    text: lines.join('\n'),
    durationMs: 10000,
    tone: 'normal',
  })
}

// ─────────────────────── 划词翻译（需求 7）───────────────────────

let translator = null
/**
 * 选中/复制了一段文字 → 翻译 → 上气泡。
 *
 * 这里刻意**不看状态开关** —— 用户明确要翻译，不该因为
 * "工作中气泡关了"就没反应。
 */
/**
 * 待定气泡：翻译还没回来时先给个反馈。
 *
 * 为什么需要：划词翻译是**复制触发**的 —— 用户不知道自己那一下到底有没有
 * 被识别到。等 1~10 秒期间屏幕上什么都没有，看起来就像"没反应"。
 * 用户原话：「有时候我不知道有没有真正触发到，如果触发了，
 *            只是还在翻译中，能不能先提供『翻译复制文本中…』气泡文本」。
 *
 * ⚠️ **延迟 PENDING_DELAY_MS 才弹** —— 本地缓存命中、或者接口很快时
 *    （实测常见 200~400ms）根本不需要闪这一下。
 *    先弹再马上换掉的话是"闪一下"，比不弹还难受。
 */
const PENDING_TEXT = '翻译复制文本中…'
const PENDING_DELAY_MS = 200

/**
 * 每次翻译的序号。
 *
 * ⚠️ **防竞态。** 用户连续划两段时会有两个 handleForeignText 同时在跑，
 *    而它们的返回顺序**不保证**（第二次快、第一次慢是常事）。
 *    没有这个序号的话，先划的那段结果会**盖掉**后划的 ——
 *    用户看到的是"翻译了上一段"。
 */
let translateSeq = 0

async function handleForeignText (text, source) {
  if (!translateClient.looksTranslatable(text)) return
  const seq = ++translateSeq
  console.log(`[translate] ${source} 触发（${text.length} 字）：${text.slice(0, 40)}`)

  // 第一拍：延迟弹「翻译中…」。定时器要留着，结果回来时取消。
  let pendingShown = false
  const pendingTimer = setTimeout(() => {
    if (seq !== translateSeq) return          // 已经有更新的一次翻译了
    pendingShown = true
    console.log('[translate] 还在翻，先弹待定气泡')
    ensureBubble()
    bubble?.sayExternal({ text: PENDING_TEXT, durationMs: 0, tone: 'normal' })
  }, PENDING_DELAY_MS)

  // 每次翻译都重新读配置 —— 文件很小，换来的是"改完保存即生效"
  const config = translateConfig.load(app.getPath('userData'))

  // ⚠️ **用 try/finally 保证待定气泡一定被处理掉。**
  //    `translate()` 的约定是"成功返回对象、失败返回 null"、不抛异常 ——
  //    但它内部有 fetch / JSON.parse / 超时，任何一处漏出来的异常都会让
  //    下面的 clearTimeout 执行不到，那句「翻译复制文本中…」就永远挂在桌面上。
  //    待定气泡是**常驻**的（durationMs: 0），它不会自己消失。
  let result = null
  try {
    result = await translateClient.translate(text, { config })
  } catch (error) {
    console.warn(`[translate] 意外异常：${error?.message ?? error}`)
  } finally {
    clearTimeout(pendingTimer)
  }

  // 过期的翻译直接丢掉，别覆盖新结果
  if (seq !== translateSeq) {
    console.log('[translate] 这一次已经过期（有更新的翻译），结果丢弃')
    return
  }

  // 异常导致 result 为 null 时，走下面那条"所有接口都失败"的分支 ——
  // 它会弹失败气泡把待定气泡盖掉，正是我们要的。

  if (!result) {
    // ⚠️ 所有接口都失败时**必须说一声**。
    // 之前是直接 return，用户看到的是"复制了没反应"，完全不知道
    // 是断网、key 过期还是额度用完。沉默是最糟的失败方式。
    const reason = translateClient.getLastFailureReason()
    console.warn(`[translate] 所有接口都失败：${reason}`)
    const failHead = sourcePreview(text)
    ensureBubble()
    bubble?.sayExternal({
      note: `翻译失败${reason ? '：' + reason : ''}`,
      text: clampForBubble(failHead),
      durationMs: bubbleDuration(failHead.length),
      tone: 'error',
    })
    return
  }

  // ⚠️ 接口对认不出的词会把**原文原样返回**。
  // 实测："translate" → "translate"、"kubernetes" → "Kubernetes"。
  // 这种情况弹气泡只会让人以为"翻了但没翻"，不如不弹。
  if (isUntranslated(text, result.text)) {
    console.log(`[translate] ${result.provider} 原样返回，不弹气泡：${text.slice(0, 30)}`)
    // ⚠️ 这条分支**不显示任何结果** —— 所以必须主动把待定气泡撤掉，
    //    否则「翻译复制文本中…」会一直挂在桌面上（常驻气泡不会自己走）。
    if (pendingShown) bubble?.hideExternal()
    return
  }
  console.log(`[translate] ${result.provider} → ${result.text.slice(0, 40)}`)

  // 首选的大模型失败、退到了免费接口 → 明确告诉用户这一条是机翻。
  // 不说的话，用户会以为大模型就这水平。
  const note = result.fallbackFrom ? `${result.fallbackFrom}连接失败，以下为机翻：` : ''

  // 原文在前（只留开头当"这是哪一段"的锚点）、译文在后，中间空一行。
  // ⚠️ 原文必须**只留预览** —— 否则两份共享窗口高度额度，被截的会是译文，
  //    而用户要的恰恰是译文（见 SOURCE_PREVIEW_CHARS）。
  const head = sourcePreview(text)
  const body = `${head}\n\n${result.text}`

  ensureBubble()
  bubble?.sayExternal({
    note,
    text: clampForBubble(body),
    // 时长按**整条气泡**的字数算（原文预览 + 译文），不是只按译文
    durationMs: bubbleDuration(body.length),
    tone: 'translate',
  })
}

/**
 * 判断接口是不是"没翻"。
 *
 * 归一到只留字母数字再比 —— 接口常常只改标点或大小写
 * （"Hello." → "hello"、"kubernetes" → "Kubernetes"），那也算没翻。
 */
function isUntranslated (source, result) {
  const norm = (t) => String(t ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
  const a = norm(source)
  const b = norm(result)
  return a.length > 0 && a === b
}

/**
 * 送进气泡之前的**兜底**长度上限。
 *
 * ⚠️⚠️ **这里原来写的是 220，那是个瓶颈 —— 而且和气泡那边的截断重复了。**
 *
 *    背景：气泡的高度现在是**按文本长度自适应**的（见 bubble-controller 的
 *    `estimateHeight` / `fitText`），上限是屏幕可用高度，1080p 下能装 1100 字左右。
 *
 *    但主进程这里**先把文本砍到 220 字**，于是：
 *        原文 400 字 → 砍到 221 字 → 气泡只用到 266px（上限 1055px）
 *    自适应**完全没被用上**，用户看到的还是"翻了一小段就没了"。
 *    （实测发现的：用户问"气泡高度是否可以不限制"，一量才发现瓶颈不在这儿。）
 *
 *    现在这里只留一个**很宽松的兜底**，真正的截断交给气泡那侧按
 *    "屏幕装得下多少"来算 —— 那是唯一知道窗口能多高的地方。
 *
 *    留兜底的用途：文本极端长时（比如复制了一整篇文章）不要做无谓的
 *    实时估算和 DOM 构造，先把量级压下来。
 */
const BUBBLE_HARD_LIMIT = 20000

function clampForBubble (text) {
  const raw = String(text ?? '')
  if (raw.length <= BUBBLE_HARD_LIMIT) return raw
  return raw.slice(0, BUBBLE_HARD_LIMIT).trimEnd() + '…'
}

/**
 * 气泡里**原文**最多显示多少字（译文不受这个限制）。
 *
 * 为什么：气泡里放的是「原文 + 空行 + 译文」两份，而窗口高度是有上限的
 * （屏幕可用高度）—— 两份**共享**这个额度。
 * 原文 1200 字 + 译文，合起来远超上限，结果**译文反而被截** ——
 * 而用户要的恰恰是译文。
 *
 * 原文只留一个"开头"，让他能确认翻的是哪一段就够了 ——
 * 那段文字他**刚复制过**，不需要再占屏幕。
 *
 * 用户原话：「原文只显示前 100 字，把额度全给译文」。
 */
const SOURCE_PREVIEW_CHARS = 100

/** 原文预览：超过就截到 100 字加省略号 */
function sourcePreview (text) {
  const raw = String(text ?? '').trim()
  if (raw.length <= SOURCE_PREVIEW_CHARS) return raw
  return raw.slice(0, SOURCE_PREVIEW_CHARS).trimEnd() + '…'
}

/**
 * 气泡显示多久。
 *
 * 用户要求「按时长线性延长」—— 原来是 `min(20000, 6000 + len*120)`，
 * 也就是**封顶 20 秒**，而 1100 字的译文根本读不完（按 400 字/分钟要 2 分多钟）。
 *
 * 取值：每 100 字 +3 秒，**上限 90 秒**。
 * ⚠️ 这个速度（约 33 字/秒）**比真实阅读快得多** —— 是有意的：
 *    气泡是**提示**不是阅读器，而且它挡在桌面上。
 *    真要细读，再复制一次就好（重复复制会重新触发，见 selection.js 的 changeCount）。
 */
const BUBBLE_BASE_MS = 6000
const BUBBLE_PER_100_MS = 3000
const BUBBLE_MAX_MS = 90000

function bubbleDuration (length) {
  const n = Math.max(0, Number(length) || 0)
  const ms = BUBBLE_BASE_MS + Math.ceil(n / 100) * BUBBLE_PER_100_MS
  return Math.min(BUBBLE_MAX_MS, ms)
}

function initTranslate () {
  // 首次运行生成一份带说明的配置模板，用户照着改就行
  const file = translateConfig.ensureFile(app.getPath('userData'))
  console.log(`[translate] 接口: ${translateConfig.describe(
    translateConfig.load(app.getPath('userData')))}`)
  if (file) console.log(`[translate] 配置文件: ${file}`)

  translator = selectionWatcher.createWatcher({
    isEnabled: () => bubbleSettings.translate !== false,
    onText: handleForeignText,
    readClipboard: () => clipboard.readText(),
    ownAppName: '胖头鱼',
  })
  translator.start()
}

// ─────────────────────────── DSH 桥接 ───────────────────────────

function sendToRenderer (channel, payload) {
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}

async function startBridge () {
  const dir = statePath()
  if (!dir) {
    console.warn('[bridge] 拿不到 userData 目录，桥接未启动')
    return
  }
  try {
    await bridge.start({
      stateDir: path.dirname(dir),
      onState: (msg) => {
        // 插件推过来的原始状态，交给 renderer 决定怎么演
        sendToRenderer('pet:state', msg)
      },
      onInfo: onAccountInfo,
      onConnectionChange: (connected) => {
        console.log(`[bridge] DSH 插件${connected ? '已连接' : '已断开'}`)
        sendToRenderer('pet:bridge', { connected })
      },
    })
  } catch (error) {
    console.error('[bridge] 启动失败:', error.message)
  }
}

// ─────────────────────────── 生命周期 ───────────────────────────

// 启动早期打点：从 Finder 启动看不到控制台，只能靠日志定位"闪一下就没了"
console.log('[main] 模块已加载, pid=' + process.pid)
process.on('exit', (code) => console.log(`[main] 进程退出 code=${code}`))

// 桌宠是常驻工具：关掉所有窗口不等于退出
app.on('window-all-closed', (event) => {
  if (!isQuitting) event.preventDefault?.()
})

/**
 * 清掉**陈旧的**单实例锁。
 *
 * 为什么需要：app 被强杀（SIGKILL / 崩溃 / `pkill -9`）时，Chromium 留下的
 * `SingletonLock` 会指向一个**已经死掉**的 pid，而
 * `app.requestSingleInstanceLock()` **认不出来它是陈旧的** —— 从此每次都返回
 * false，app 再也起不来。用户看到的现象是"双击图标没反应"，日志里只有一句
 * "单实例锁: 被拒绝"，**从这句话完全看不出锁是坏的**。
 *
 * 实测踩过一次：锁指向 pid 16270（早死了）、hostname 也没变、
 * 没有任何进程占着 userData，但就是起不来。手动删掉三个 Singleton* 才恢复。
 *
 * 判据：锁是个符号链接，内容是 `<hostname>-<pid>`。
 *   · pid 解析不出来        → 不是我们认识的格式，不动（宁可不动也不能误删活跃锁）
 *   · pid 还活着            → 真的在跑，不动
 *   · hostname 不是本机     → 可能是共享目录，不动
 *   · 都不满足              → 陈旧，删
 *
 * ⚠️ 只删 SingletonLock / SingletonCookie / SingletonSocket 这三个符号链接，
 *    且在 `app.whenReady()` **之前**做 —— 锁是 requestSingleInstanceLock 用的。
 */
/**
 * 这个 pid 是不是还活着。
 *
 * ⚠️ **不能用 `process.kill(pid, 0)` 判断** —— 实测两个坑叠加，结论是错的：
 *   1. **僵尸进程**（父进程还没回收）会让 kill(pid,0) **成功** ——
 *      实测 app 早就不见了，锁里那个 pid 却一直"活着"，于是陈旧锁永远清不掉。
 *   2. **沙箱内外行为不一致** —— 在受限环境里连 `kill(1, 0)`（launchd）都返回失败。
 *
 * 改用 `ps` 看进程状态：**Z 是僵尸，等同于死**。
 * ps 查不到这个 pid 时它自己会非零退出，也当作死。
 */
function pidIsAlive (pid) {
  try {
    const stat = execFileSync('ps', ['-p', String(pid), '-o', 'stat='],
      { encoding: 'utf8', timeout: 2000 }).trim()
    if (!stat) return false             // ps 没有输出 = 进程不存在
    return !stat.startsWith('Z')        // Z = 僵尸 → 当作死
  } catch (e) {
    // ⚠️ **必须区分"ps 说没这个进程"和"ps 自己跑不起来"。**
    //    ps 因为权限而失败时如果也返回"已死"，就会把一个**有效**的锁删掉
    //    —— 后果是两个实例同时跑、两个宠物。宁可漏清理，也不能误删。
    //    （实测：受限环境里 spawnSync ps 会直接 EPERM。）
    if (e.code === 'EPERM' || e.code === 'ENOENT' || e.code === 'EACCES') {
      console.log(`[main] 陈旧锁检查: ps 跑不起来（${e.code}），保守起见当作进程还活着`)
      return true
    }
    return false                        // ps 正常退出但没找到这个 pid
  }
}

function clearStaleSingletonLock () {
  // ⚠️ **每个分支都要留一句话。** 第一版这里全是静默 return，
  //    结果"没生效"的时候完全无从查起 —— 日志里干干净净，
  //    既没有成功也没有失败，只能靠猜。
  let dir
  try {
    dir = app.getPath('userData')
  } catch (e) {
    console.log(`[main] 陈旧锁检查: 拿不到 userData 路径（${e.message.slice(0, 50)}），跳过`)
    return false
  }
  const lock = path.join(dir, 'SingletonLock')

  let target
  try {
    target = fs.readlinkSync(lock)     // 不是符号链接会抛，正好跳过
  } catch (e) {
    console.log(`[main] 陈旧锁检查: 读不到锁（${e.code}），当作没有`)
    return false
  }

  const m = /^(.*)-(\d+)$/.exec(target)
  if (!m) {
    console.log(`[main] 陈旧锁检查: 格式不认识 → ${target}，不动`)
    return false
  }
  const [, host, pidText] = m
  const pid = Number(pidText)

  if (host !== os.hostname()) {
    console.log(`[main] 陈旧锁检查: host 不是本机（${host} ≠ ${os.hostname()}），不动`)
    return false
  }
  if (pidIsAlive(pid)) {
    console.log(`[main] 陈旧锁检查: pid ${pid} 还活着 → 锁有效`)
    return false
  }
  console.log(`[main] 陈旧锁检查: pid ${pid} 已死 → 判定为陈旧锁`)

  // 走到这里说明：锁指向的进程确实没了 —— 陈旧锁
  let removed = 0
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(dir, name)); removed += 1 } catch { /* 没有就算了 */ }
  }
  console.log(`[main] 清掉陈旧单实例锁（指向已死的 pid ${pid}），删除 ${removed} 个文件`)
  return true
}

// 单实例：重复启动时把已有窗口唤出来
clearStaleSingletonLock()               // 必须在 requestSingleInstanceLock 之前
const gotLock = app.requestSingleInstanceLock()
console.log(`[main] 单实例锁: ${gotLock ? '取得' : '被拒绝（已有实例在跑）'}`)
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.showInactive()
  })

  app.whenReady().then(() => {
    hideDockIcon()
    createWindow()
    // ⚠️ **气泡窗口延后建，不要在这一拍就建。**
    //
    //    体检数据：桌宠空闲占 317MB，其中**气泡渲染进程就占 76MB** ——
    //    而它从启动到"第一次真的要说话"之间**完全用不到**。
    //
    //    延后 3 秒（等桌宠先显示出来、首屏不跟它抢内存）再建；
    //    这期间如果就有话要说，`ensureBubble()` 会立刻补建，不会丢话。
    setTimeout(() => {
      ensureBubble()
    }, BUBBLE_WARMUP_MS)
    attention.start()
    initTranslate()
    startBridge()
    // ⚠️ **启动时先接一次，不等那 30 秒。**
    //
    //    两个原因：
    //      ① 接完 DSH 的 live-reload watcher 才会重新挂载插件 ——
    //         早接上，用户可能不用重启 DSH 就能用（取决于它怎么监视）
    //      ② watchForPlugin 里那次是"兜底 + 告知用户"，
    //         不该是"第一次尝试"
    //    没装 DSH 时它什么都不做（`no-dsh`），所以是安全的。
    {
      // ⚠️ 清掉上次留下的「用户主动退出」标记 —— 否则它会挡住这一次的「跟随启动」。
      if (launch.clearUserQuit(app)) console.log('[launch] 清掉了上次的「用户主动退出」标记')

      // ⚠️ 每次启动都把 `launch.json` 里的 `exePath` 刷成当前路径。
      //    用户可能把 app 挪了位置（或者从 dmg 里直接跑），路径会变 ——
      //    而插件是拿它去 spawn 的，写错了就永远拉不起来，而且不报错。
      launch.syncExePath(app)

      const st = dshPlugin.autoInstall()
      // ⚠️ 措辞要分情况 —— `already` 时 `profiles` 里放的是"扫到的全部"，
      //    写成"这次动了 X"会让人以为它每次都改文件（实测我自己就被误导了一下）。
      const detail = st.action === 'already'
        ? `（已在 ${(st.profiles ?? []).join(', ')} 里装着，没动）`
        : (st.profiles?.length ? `（这次动了 ${st.profiles.join(', ')}）` : '')
      console.log(`[pet] 启动时检查 DSH 插件：${st.action}${detail}`
        + (st.failed?.length ? `  失败 ${st.failed.map((f) => f.name).join(', ')}` : ''))
    }

    watchForPlugin()

    /**
 * 焦点诊断。
 *
 * 用户报过：「操作别的窗口时，桌宠状态变更会打断我打字（光标丢了）」。
 * 用 osascript 查前台应用太慢（往返 240ms），抓不到瞬间的抢焦点 ——
 * 所以让 app **自己**报：只要它被激活、或者某个窗口拿到焦点，就打一行。
 *
 * 日志里出现这些行，就说明**确实被抢了**，而且能看出是哪个窗口、什么时刻。
 * 配合 `[bridge] 状态 ← xxx` 的时间戳，就能定位是哪一次状态变更引起的。
 */
app.on('browser-window-focus', (_event, focused) => {
  console.log(`[focus] ⚠️ 窗口拿到焦点: ${focused?.getTitle?.() || '(无标题)'}`
    + `  id=${focused?.id}  桌宠=${focused === win}  气泡=${focused === bubbleWin}`)
})
app.on('browser-window-blur', (_event, blurred) => {
  console.log(`[focus] 窗口失焦: id=${blurred?.id}`)
})

app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else if (win && !win.isDestroyed()) win.showInactive()
    })
  })
}

app.on('before-quit', () => {
  attention.stop()
  isQuitting = true
  // ⚠️ **用户主动退出 ⇒ 记一笔**，免得插件过一会儿又把她拉起来。
  //    放在这里而不是菜单的 click 里，是因为 Cmd+Q 走的是 before-quit，
  //    两条路都要覆盖到。（系统关机也会走到这，但那没关系 ——
  //    DSH 重启后这个标记会自动失效，见 launch.js 里的说明。）
  launch.markUserQuit(app)
  bubble?.destroy()          // 清掉还没到点的升级计时器
  savePosition()
  bridge.stop()
})
