/**
 * launch.js — 「开机启动」和「跟随 DSH 一起启动」两个开关。
 *
 * ─────────────────────────────────────────────────────────────────
 * 一、开机启动怎么做
 * ─────────────────────────────────────────────────────────────────
 *
 * 用 Electron 自带的 `app.setLoginItemSettings()` —— 它**两个平台都覆盖**，
 * 而且各自接到系统的正规入口上：
 *
 *   macOS 13+  走 `SMAppService.mainApp`
 *              ⇒ 出现在 **系统设置 → 通用 → 登录项与扩展**
 *   Windows    写注册表 `HKCU\…\CurrentVersion\Run`
 *              ⇒ 出现在 **任务管理器 → 启动应用**
 *
 * ⚠️ **两个平台都要能读回真实状态，不能只信我们自己存的。**
 *    用户完全可以去系统设置里关掉 —— 那时我们菜单里的勾**必须跟着没**，
 *    否则就是个骗人的界面。
 *
 * ─────────────────────────────────────────────────────────────────
 * 二、为什么「跟随 DSH」要单独写一个文件
 * ─────────────────────────────────────────────────────────────────
 *
 * 「跟随 DSH 一起启动」是**插件**实现的（插件跑在 DSH 里，由它把我们拉起来）。
 * 但插件要拉起我们，得先知道**我们装在哪**。
 *
 * ⚠️ **不能靠 `bridge.json`** —— 那个文件只有我们**跑过之后**才存在，
 *    而"跟随 DSH"最需要它的场景恰恰是"我们没在跑"。
 *
 * ⇒ 所以另写一份 `launch.json`，和 `bridge.json` 同目录，
 *   **用户一勾选就落盘**（那时我们一定在跑，能拿到自己的真实路径）。
 *   插件只读它，不需要我们在跑。
 *
 * ─────────────────────────────────────────────────────────────────
 * 三、谁读谁写
 * ─────────────────────────────────────────────────────────────────
 *
 *   `launch.json`   我们**写**，插件**读**。
 *   两个开关的**意图**存在这里；开机启动的**实际状态**以系统为准。
 *
 * ⚠️ 插件改了之后**必须重启一次 DSH 才生效**（插件是 DSH 启动时加载的）。
 *    这是一次性的事 —— 之后勾选/取消都不用重启。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** `launch.json` 的默认值。缺字段一律按这个算。 */
const DEFAULTS = {
  openAtLogin: false,
  followDsh: false,
  exePath: '',
}

/**
 * `launch.json` 的完整路径。
 *
 * ⚠️ **不能在模块加载期算** —— `app.getPath('userData')` 那时候可能还没准备好，
 *    或者运行环境不允许写该目录（会抛 `Failed to get 'userData' path'`
 *    并让整个 app 起不来）。所以延迟到真正要读写时再算，失败一律静默降级。
 *    （同一个坑在 `statePath()` 那边踩过，见那里的注释。）
 */
function launchPath (app) {
  try {
    return path.join(app.getPath('userData'), 'launch.json')
  } catch {
    return null
  }
}

/** 读。文件不在 / 坏了都返回默认值 —— **不要因为读不到就让 app 起不来**。 */
function read (app) {
  const p = launchPath(app)
  if (!p) return { ...DEFAULTS }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return {
      openAtLogin: raw.openAtLogin === true,
      followDsh: raw.followDsh === true,
      exePath: typeof raw.exePath === 'string' ? raw.exePath : '',
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** 写（合并式）。返回写成功没有。 */
function write (app, patch) {
  const p = launchPath(app)
  if (!p) return false
  const next = { ...read(app), ...patch }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    return true
  } catch (error) {
    console.warn(`[launch] 写 launch.json 失败: ${error.message}`)
    return false
  }
}

/**
 * 把 `exePath` 更新成当前这个可执行文件。
 *
 * ⚠️ **每次启动都写一遍。** 用户可能把 app 挪了位置、或者从 dmg 里直接跑，
 *    路径会变；而插件那边是拿它去 spawn 的，写错了就永远拉不起来。
 */
function syncExePath (app) {
  const now = process.execPath
  if (read(app).exePath === now) return false
  return write(app, { exePath: now })
}

/**
 * 开机启动在**系统里**的真实状态。
 *
 * ⚠️ **不能只返回 `openAtLogin`** —— Windows 上用户可以在任务管理器里
 *    把这一项**禁用**（注册表还在，但被 `StartupApproved` 挡了）。
 *    这时 `openAtLogin` 仍是 `true`，但**实际不会启动**。
 *    Electron 给了 `executableWillLaunchAtLogin` 专门区分这种情况。
 *
 * 返回：
 *   on            —— **实际会不会开机启动**（这是我们该显示的勾）
 *   registered    —— 注册项在不在（`on` 为 false 但它是 true ⇒ 被用户禁用了）
 *   needsApproval —— macOS 13+：注册了但用户还没批准
 *   status        —— macOS 的原始状态串，方便排查
 */
function loginItemState (app) {
  let s
  try {
    // ⚠️ macOS 不用传 path/args；Windows 传了才能读到我们自己那一项。
    //    两边都传 `process.execPath` 是安全的（macOS 会忽略）。
    s = app.getLoginItemSettings({ path: process.execPath })
  } catch (error) {
    console.warn(`[launch] 读登录项状态失败: ${error.message}`)
    return { on: false, registered: false, needsApproval: false, status: 'error' }
  }

  const status = s.status ?? ''

  // macOS 13+：`requires-approval` = 注册上了，但等着用户在系统设置里点允许。
  // ⚠️ 这时**实际还不会启动**，所以 `on` 要给 false，但菜单里要说明原因。
  const needsApproval = status === 'requires-approval'

  let on = Boolean(s.openAtLogin)
  if (process.platform === 'win32') {
    // Windows：以"实际会不会启动"为准（能识破任务管理器里的禁用）
    on = Boolean(s.executableWillLaunchAtLogin) && !needsApproval
  } else if (needsApproval) {
    on = false
  }

  return {
    on,
    registered: Boolean(s.openAtLogin),
    needsApproval,
    status,
  }
}

/**
 * 设置开机启动。
 *
 * ⚠️ Windows 上 `enabled` 和 `openAtLogin` **两个都要传**：
 *    · `openAtLogin` 管注册表里那一项在不在
 *    · `enabled` 管 `StartupApproved`（**任务管理器里那个开关**）
 *    只传 `openAtLogin` 的话，用户之前在任务管理器里禁用过，
 *    我们再打开时**它仍然是禁用的** —— 表现为"勾了但没用"。
 */
function setLoginItem (app, on) {
  try {
    app.setLoginItemSettings(
      process.platform === 'win32'
        ? { openAtLogin: on, enabled: on, path: process.execPath, args: [] }
        : { openAtLogin: on },
    )
    return true
  } catch (error) {
    console.warn(`[launch] 设置开机启动失败: ${error.message}`)
    return false
  }
}

/**
 * ⚠️ **「用户主动退出」标记** —— 用来防止"退出之后自己又冒出来"。
 *
 * ── 为什么需要它（用户报的 bug）──
 * 插件那边的「跟随 DSH 一起启动」原来是：只要连不上就试着拉起她。
 * 结果用户右键退出之后，过一会儿她又会被拉起来。
 * 用户的原话：「退出了应该就是退出了，除了重启 DSH 或者在应用列表
 * 打开 APP，否则都不会打开」。
 *
 * ⇒ 光靠"DSH 启动后 90 秒内允许拉起"这个窗口还不够 ——
 *    如果用户正好在窗口内退出，还是会被拉。所以再加这个标记。
 *
 * ── 怎么判断"这个标记算不算数" ──
 * 标记里存**写下的时间戳**。插件的规则是：
 *
 *     标记时间戳 **晚于** 插件加载时间  ⇒ 是**本次会话**里用户退出的 ⇒ 不拉 ❌
 *     标记时间戳 **早于** 插件加载时间  ⇒ 是**上次会话**留下的   ⇒ 可以拉 ✅
 *
 * 这样 DSH 一重启，上次的标记就自动失效了 —— 不需要谁去清它。
 */
function quitMarkPath (app) {
  try {
    const file = launchPath(app)
    return file ? path.join(path.dirname(file), 'quit-by-user.json') : null
  } catch { return null }
}

/** 用户主动退出时调一次。写不进去就算了（不影响退出）。 */
function markUserQuit (app) {
  const file = quitMarkPath(app)
  if (!file) return false
  try {
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), atISO: new Date().toISOString() }, null, 2),
      { mode: 0o600 })
    console.log(`[launch] 已记下「用户主动退出」标记：${file}`)
    return true
  } catch { return false }
}

/** 启动时调一次 —— 清掉上次留下的标记，免得它挡住这一次的「跟随启动」。 */
function clearUserQuit (app) {
  const file = quitMarkPath(app)
  if (!file) return false
  try {
    if (fs.existsSync(file)) { fs.unlinkSync(file); return true }
  } catch { /* 删不掉不致命 */ }
  return false
}

module.exports = {
  // ⚠️ 这两个是给「用户主动退出」用的，见上面的说明
  quitMarkPath,
  markUserQuit,
  clearUserQuit,
  DEFAULTS,
  launchPath,
  read,
  write,
  syncExePath,
  loginItemState,
  setLoginItem,
}
