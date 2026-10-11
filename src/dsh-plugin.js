/**
 * dsh-plugin.js — 把桌宠插件接进 DSH（**由 App 自己完成，不需要用户敲命令**）
 *
 * ── 为什么要在 App 里做一遍 ──
 *
 * 原来这件事靠仓库根目录的 `install-plugin.mjs`，用户要：
 *   ① 装 Node.js  ② 开终端  ③ cd 到项目目录  ④ 跑 `node install-plugin.mjs`
 *
 * **在 macOS 上"从源码跑"还算自然** —— 但 **Windows 用户装的是 `.exe`**，
 * 他根本没有"项目目录"，那个脚本也**没打进安装包**。
 * 于是桌宠只能弹一句「跑一下 node install-plugin.mjs」——
 * **一条用户根本没法照做的提示**。（做 Windows 版时才暴露出来。）
 *
 * App 自己就有 Node 运行时和 `fs`，这几步完全可以它自己做。
 *
 * ── 插件文件从哪来 ──
 *
 * ⚠️ **插件不能留在 `app.asar` 里。**
 *    DSH 是普通 Node 进程，它 `import` 不了 asar 里东西 ——
 *    托管区块里写的是**真实文件路径**，asar 里的路径对它不是文件。
 *    所以 `pet-plugin/` 走 `extraResources` 随包发出去（见 package.json），
 *    运行时用 `process.resourcesPath` 找到它。
 *
 * ── 写的是「托管区块」──
 *
 * 只往 `cordis.patch.yml` 里插一段有注释边界的内容，
 * **绝不碰用户的其他配置**；`remove()` 只删这一段。
 */

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// ⚠️ 识别时按**前缀**匹配，不能用完整字面量 —— 开始标记里带版本号，
//    每个版本的字符串都不一样。删旧区块时也要能认出来。
const MARK_PREFIX = '# --- dsh-harness-pet managed'
const MARK_END = '# --- end dsh-harness-pet managed'
const PLUGIN_ID = 'dsh-harness-pet'

/**
 * DSH 家目录。
 *
 * ── 依据是 DSH 自己的文档，不是我猜的 ──
 *
 * DSH 的 `app.asar` 里那份配置目录写着：
 *
 *     | `dshHome` | `$DSH_HOME` or `~/.dsh` | Directory containing the user-global `AGENTS.md` |
 *
 * 所以优先级就是 **`$DSH_HOME` → `~/.dsh`**，和它保持一致。
 * （仓库根的 `install-plugin.mjs` 也是这么写的，两处别写岔。）
 *
 * ── 三个平台分别是 ──
 *   macOS    `/Users/<名>/.dsh`
 *   Linux    `/home/<名>/.dsh`
 *   Windows  `C:\Users\<名>\.dsh`     ← `os.homedir()` 在 Windows 上就是它
 *
 * ⚠️ **Windows 那条我没在真机上验过** —— 依据是"`~` 在 Windows 上就是
 *    `os.homedir()`"这个通行约定，加上 DSH 文档里的 `~/.dsh`。
 *    万一某个 DSH 装法用了别的位置，用户可以在右键菜单看到"没找到 DSH"，
 *    然后**用 `DSH_HOME` 环境变量指过去**（或者告诉我们）。
 */
function resolveDshHome () {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 插件入口的**真实文件路径**（不能在 asar 里） */
function pluginDir () {
  // 打包后：<安装目录>/resources/pet-plugin/
  //   Windows  %LOCALAPPDATA%\Programs\胖头鱼\resources\pet-plugin
  //   macOS    胖头鱼.app/Contents/Resources/pet-plugin
  // 开发时：<仓库根>/pet-plugin/
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'pet-plugin')
    if (fs.existsSync(path.join(packaged, 'index.js'))) return packaged
  }
  // 开发模式（或者 extraResources 没打进去时的兜底）
  return path.join(__dirname, '..', 'pet-plugin')
}

/** 插件入口文件。⚠️ 必须是 index.js —— Node 的 ESM 不支持目录导入 */
function pluginEntry () {
  return path.join(pluginDir(), 'index.js')
}

function pluginVersion () {
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginDir(), 'package.json'), 'utf8')).version
  } catch {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
    } catch { return '0.0.0' }
  }
}

/**
 * 扫出所有「能接的」profile。
 *
 * 判据是 `cordis.patch.yml` 存在 —— 那说明这个 profile 被 DSH 初始化过。
 * 只认目录结构，不认什么注册表（和 `availableStyles()` 一个思路）。
 */
function listProfiles () {
  const dir = path.join(resolveDshHome(), 'profiles')
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []                       // 没装 DSH（或者还没初始化）—— 不是错误
  }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const patch = path.join(dir, e.name, 'cordis.patch.yml')
    if (!fs.existsSync(patch)) continue
    out.push({ name: e.name, patchPath: patch, installed: isInstalled(patch) })
  }
  // 接过的排前面 —— 多 profile 时优先维护已经接上的那个
  out.sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0) || a.name.localeCompare(b.name))
  return out
}

/** 这个 profile 里有没有我们的托管区块 */
function isInstalled (patchPath) {
  try {
    return fs.readFileSync(patchPath, 'utf8').includes(MARK_PREFIX)
  } catch {
    return false
  }
}

/**
 * 删掉旧的托管区块，并**把尾部空行清干净**。
 *
 * ⚠️ **尾部必须清干净，否则不幂等**（实测踩到）：
 *    文件末尾那个 `\n` 会在 `split` 之后留下一个空串元素，
 *    join 回来就是 `…\n\n`；而 `install()` 还会再加一个分隔换行 ——
 *    于是**每跑一次就多一个空行**。表现是：
 *      第 1 次装 → 2 个换行
 *      第 2 次装 → 3 个换行（报 `updated`，明明内容没实质变化）
 *      第 3 次起 → 稳定在 3 个（因为 `\n{3,}` 被压成 `\n\n` 再加 1）
 *    不幂等的后果不只是"多一个空行"：**每次启动都改文件**
 *    ⇒ 触发 DSH 的 live-reload watcher ⇒ **插件被反复重新挂载**。
 *
 * 现在这里统一 `replace(/\n+$/, '')`，`install()` 那边固定加 `\n\n` ——
 * 两边都是确定值，跑多少次结果都一样。
 *
 * 按**前缀**识别开始标记（版本号会变，不能拿完整字面量去比）。
 */
function stripManaged (text) {
  const lines = text.split('\n')
  const begin = lines.findIndex((l) => l.startsWith(MARK_PREFIX))
  const base = begin < 0
    ? text
    : (() => {
        const end = lines.findIndex((l, i) => i >= begin && l.startsWith(MARK_END))
        const cut = end < 0 ? lines.length : end + 1
        return lines.slice(0, begin).concat(lines.slice(cut)).join('\n')
      })()
  // 尾部和中间的多余空行都收干净 —— 保证同一份内容永远算出同一个结果
  return base.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '')
}

function managedBlock () {
  // ⚠️ 两个踩过的坑，别动：
  //
  // 1. **必须指向 index.js，不能指向目录。**
  //    Node 的 ESM 不支持目录导入（ERR_UNSUPPORTED_DIR_IMPORT）——它不会像
  //    CommonJS 那样去读 package.json 的 main/exports。
  //    写成目录 = 插件静默不加载，而且没有任何报错。
  //
  // 2. **版本号写进注释是有意的。**
  //    监视 cordis.patch.yml 的是 DSH 的 live-reload watcher。App 升级后
  //    插件代码变了但补丁没变的话不会触发重载；版本号一变文件内容就变，
  //    watcher 才会重新挂载插件。
  //
  // 3. `JSON.stringify` 在这里是对的（不是偷懒）：Windows 路径里的反斜杠
  //    必须转义，而 YAML 的双引号风格正好认 `\\` —— 手拼字符串很容易漏。
  const entry = pluginEntry()
  return [
    `${MARK_PREFIX} v${pluginVersion()} (auto-generated; do not edit) ---`,
    '- insert:',
    `    - id: ${PLUGIN_ID}`,
    `      name: ${JSON.stringify(entry)}`,
    '      config:',
    '        verbose: true',
    MARK_END,
    '',
  ].join('\n')
}

/** 往一个 profile 里装上/更新托管区块。返回 { ok, changed, error } */
function install (patchPath) {
  try {
    if (!fs.existsSync(path.join(pluginDir(), 'index.js'))) {
      return { ok: false, error: `找不到插件入口：${pluginEntry()}` }
    }
    const original = fs.readFileSync(patchPath, 'utf8')
    // ⚠️ 分隔固定写成 `\n\n`（不是 `\n`）—— 见 stripManaged 的说明：
    //    两边都是确定值，跑多少次结果才一样。
    const next = stripManaged(original) + '\n\n' + managedBlock()
    if (next === original) return { ok: true, changed: false }
    // 先备份一次 —— 万一 YAML 写坏了，用户还能自己找回来
    try { fs.copyFileSync(patchPath, patchPath + '.dsh-harness-pet.bak') } catch { /* 备份失败不阻塞 */ }
    fs.writeFileSync(patchPath, next)
    return { ok: true, changed: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 从某个 profile 里卸掉（只删托管区块，其他配置一个字不动） */
function remove (patchPath) {
  try {
    const original = fs.readFileSync(patchPath, 'utf8')
    const next = stripManaged(original)
    if (next === original) return { ok: true, changed: false }
    fs.writeFileSync(patchPath, next)
    return { ok: true, changed: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * 启动时调一次：**能找到 DSH 就把所有 profile 都接上**。
 *
 * ── ⚠️ 为什么是「所有」，不是「一个」──
 *
 * DSH 有几种形态（官方桌面端 / 浏览器形态 / 从源码跑），
 * **每种形态在 `~/.dsh/profiles/` 下有自己的一个 profile 目录** ——
 * 官方桌面端是 `desktop`，浏览器形态是 `web`，等等。
 *
 * 一开始这里写的是"挑一个接"（优先接过的那 个）。**那是错的**：
 * 用户完全可能两种形态都用 —— 只接一个的话，
 * 另一种形态下她会**毫无反应**，而且不看代码根本不知道为什么。
 *
 * 接上所有 profile 的代价很小：都是同一段托管区块、都能一键断开、
 * 写之前都留 `.bak`。而漏接的代价是"她有时候不工作"。
 *
 * ⚠️ **为什么默认就接，而不是先弹窗问**：
 *    · 这正是这个 App 存在的意义 —— 不接上她就只是个摆件
 *    · 写的是**托管区块**，可一键撤销（右键菜单里逐个都能断）
 *    · 会先备份一份 `.bak`
 *    · 用户没装 DSH 的话，这里**什么都不做**（`listProfiles()` 返回空）
 *
 * 返回一个能直接拿来跟用户说的结果：
 *   { action: 'installed' | 'updated' | 'already' | 'no-dsh' | 'error',
 *     profiles: [...],      这次碰过的 profile 名
 *     all: [...] }          扫到的全部 profile 名
 */
function autoInstall () {
  const profiles = listProfiles()
  if (profiles.length === 0) return { action: 'no-dsh' }

  const touched = []          // 这次真的改了的
  const failed = []
  for (const p of profiles) {
    const r = install(p.patchPath)
    if (!r.ok) { failed.push({ name: p.name, error: r.error }); continue }
    if (r.changed) touched.push(p)
  }

  const all = profiles.map((p) => p.name)

  // 一个都没改成，但至少在某个 profile 里是装着的 → 已经是好的
  if (touched.length === 0) {
    if (failed.length === profiles.length) {
      return { action: 'error', error: failed[0].error, profile: failed[0].name, all }
    }
    return { action: 'already', profiles: all, all }
  }

  // 有"以前接过、这次更新了"的就算 updated，否则算 installed
  const action = touched.some((p) => p.installed) ? 'updated' : 'installed'
  return {
    action,
    profiles: touched.map((p) => p.name),
    all,
    ...(failed.length ? { failed } : {}),
  }
}

module.exports = {
  resolveDshHome,
  pluginEntry,
  listProfiles,
  isInstalled,
  install,
  remove,
  autoInstall,
  MARK_PREFIX,
}
