/**
 * platform.js — 所有平台差异集中在这里
 *
 * 为什么单独抽一个文件：
 * 现在是 macOS 版本，但已经确定要做 Windows 版本。平台差异如果散在
 * main.js 各处用 `if (process.platform === 'darwin')` 就地判断，
 * 将来做 Windows 时就得满仓库找 —— 而且**一定会漏掉几处**，
 * 漏掉的表现又往往是"某个特性静默失效"。
 *
 * 集中到这里的收益：Windows 开发时，**要改的地方全在这一个文件里**。
 *
 * ⚠️ 这里只处理"两平台行为不同"的部分。纯粹 macOS 独有的东西
 * （app.dock）留在 main.js 里就地判断，因为它压根没有跨平台对应物。
 */

'use strict'

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'
const isLinux = process.platform === 'linux'

/**
 * 置顶。
 *
 * macOS 上必须用 'screen-saver' 这一级才能盖住 Dock —— 'floating' 和
 * 'status' 都会沉在 Dock 之下（实测过）。
 *
 * ⚠️ 但 `level` 参数**只有 macOS 支持**，Windows/Linux 上会被忽略。
 * 所以 Windows 上"完全置顶"能不能盖住任务栏是**另一回事**，
 * 需要实机验证，不能指望这里传个字符串就解决。
 */
function applyAlwaysOnTop (win) {
  win.setAlwaysOnTop(true, isMac ? 'screen-saver' : 'normal')
}

/**
 * 在所有工作区可见、且能浮在全屏应用之上。
 *
 * ⚠️ **Windows 不支持这个 API**（Electron 文档明确），直接跳过。
 * 不要试图"传个参数糊弄过去" —— 静默无效比明确跳过更难查。
 */
function applyAllWorkspaces (win) {
  if (isWindows) return
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    // 这个选项只在 macOS 有意义：
    // 不加的话 Electron 会把进程类型改成 UIElement，导致 App 从程序坞消失
    ...(isMac ? { skipTransformProcessType: true } : {}),
  })
}

/**
 * 气泡窗口的平台专有选项。
 *
 * macOS 用 `type: 'panel'`（NSPanel）—— 它不进程序坞的窗口列表，
 * 否则气泡会看起来像一个独立程序。
 * Windows 上没有对应概念，返回空对象；那边靠 `skipTaskbar: true` 已经够了。
 */
function bubbleWindowExtras () {
  return isMac ? { type: 'panel' } : {}
}

/**
 * 旧名字的 userData 目录（改名过渡期往这里也写一份 bridge.json）。
 *
 * 各平台的 userData 位置不同，所以这里也得跟着分平台 ——
 * 不然 Windows 上会去建一堆 `C:\Users\xxx\Library\Application Support\...`
 * 这种莫名其妙的目录。
 */
function legacyStateDirs (appName, legacyNames) {
  const base = userDataBase()
  if (!base) return []
  return legacyNames.map((name) => require('node:path').join(base, name))
}

/** 当前平台的 userData 根目录（不含 App 名） */
function userDataBase () {
  if (isWindows) {
    const appData = process.env.APPDATA || process.env.LOCALAPPDATA
    return appData || null
  }
  if (isMac) {
    const home = process.env.HOME
    return home ? require('node:path').join(home, 'Library', 'Application Support') : null
  }
  const home = process.env.HOME
  if (!home) return null
  return require('node:path').join(process.env.XDG_CONFIG_HOME || require('node:path').join(home, '.config'))
}

module.exports = {
  isMac,
  isWindows,
  isLinux,
  applyAlwaysOnTop,
  applyAllWorkspaces,
  bubbleWindowExtras,
  legacyStateDirs,
  userDataBase,
}
