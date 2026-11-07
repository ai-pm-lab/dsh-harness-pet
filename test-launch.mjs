/**
 * test-launch.mjs — 「开机启动」和「跟随 DSH 一起启动」的检查。
 *
 * ⚠️ 这里**不碰真实的登录项**（那会改用户的系统设置）。
 *    真机验证过一次就够了（`setLoginItemSettings` 设 true → status 变 `enabled`
 *    → 设 false → 变 `not-registered`），这里守的是**接线**：
 *    菜单项在不在、launch.json 读写的边界、插件那边该不该 spawn。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  ' + extra : ''}`) }
}

const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
const launchSrc = fs.readFileSync(path.join(ROOT, 'src', 'launch.js'), 'utf8')
const plugin = fs.readFileSync(path.join(ROOT, 'pet-plugin', 'index.js'), 'utf8')

console.log('\n【1.996】开机启动 / 跟随 DSH')
{
  // ① 菜单：「启动」那组，而且在「宠物形象」上面
  check('有 launchMenuItems()', /function launchMenuItems\s*\(/.test(main))
  check('菜单里插了它', /\.\.\.launchMenuItems\(\)/.test(main))
  const iLaunch = main.indexOf('...launchMenuItems()')
  const iStyle = main.indexOf('...styleMenuItems()')
  check('「启动」排在「宠物形象」**上面**', iLaunch > 0 && iStyle > 0 && iLaunch < iStyle,
    `launch@${iLaunch} < style@${iStyle}`)
  check('有「开机启动」项', /label: loginLabel/.test(main) || /开机启动/.test(main))
  check('有「跟随 DSH 一起启动」项', /跟随 DSH 一起启动/.test(main))

  // ② ⚠️ 勾选状态必须**实时问系统**，不能读我们自己存的
  check('launchMenuItems 每次调 loginItemState()',
    /function launchMenuItems[\s\S]{0,400}loginItemState\(app\)/.test(main))
  check('launch.js 里有 loginItemState', /function loginItemState/.test(launchSrc))
  // macOS 的 requires-approval 中间态要有专门文案
  check('处理了 macOS 的 requires-approval', /requires-approval/.test(launchSrc))
  // Windows：任务管理器禁用后 openAtLogin 还是 true，要用 executableWillLaunchAtLogin 识破
  check('Windows 用 executableWillLaunchAtLogin 识破"被禁用"',
    /executableWillLaunchAtLogin/.test(launchSrc))

  // ③ ⚠️ Windows 上 enabled 和 openAtLogin 都要传
  check('setLoginItem 在 Windows 上传了 enabled',
    /platform === 'win32'[\s\S]{0,200}enabled:\s*on/.test(launchSrc))

  // ④ exePath 每次启动都同步
  check('启动时调 syncExePath', /launch\.syncExePath\(app\)/.test(main))
  check('勾「跟随 DSH」时写入 exePath',
    /followDsh: menuItem\.checked[\s\S]{0,120}exePath: process\.execPath/.test(main))

  // ⑤ 插件侧
  check('插件 import 了 spawn', /import \{ spawn \} from 'node:child_process'/.test(plugin))
  check('插件有 maybeLaunchPet', /function maybeLaunchPet/.test(plugin))
  check('只读 launch.json（不是 bridge.json）', /launchConfigCandidates/.test(plugin))
  check('没勾时**不**启动', /if \(!cfg\?\.followDsh\) return false/.test(plugin))
  // ⚠️ 三个必须处理的细节
  check('① spawn 带 detached（DSH 退出不带走她）', /detached:\s*true/.test(plugin))
  check('① spawn 后 unref()', /child\.unref\(\)/.test(plugin))
  check('② spawn 前清掉 ELECTRON_RUN_AS_NODE',
    /delete env\.ELECTRON_RUN_AS_NODE/.test(plugin))
  check('③ 有冷却时间（防死循环）', /LAUNCH_COOLDOWN_MS/.test(plugin))
  check('③ 有最大尝试次数', /LAUNCH_MAX_ATTEMPTS/.test(plugin))
  // 两个插入点：没有 bridge.json / 连不上
  check('插入点一：没有 bridge.json 时尝试',
    /maybeLaunchPet\('没有 bridge\.json'\)/.test(plugin))
  check('插入点二：连不上时尝试（陈旧 bridge.json）',
    /maybeLaunchPet\('连不上/.test(plugin))
  check('区分「连上过又断」和「压根没连上」', /let opened = false/.test(plugin))
  // 兜底猜路径
  check('有兜底的安装路径猜测', /guessPetExe/.test(plugin))
  check('macOS 兜底猜 /Applications', /'\/Applications\/胖头鱼\.app/.test(plugin))
}

console.log('\n【1.998】"退出之后不该自己冒出来"（用户报的 bug）')
{
  // ⚠️ 用户报的现象：DSH 运行中，右键退出桌宠 ⇒ 过一会儿她自己又冒出来了。
  //    根因：插件的「跟随 DSH 一起启动」原来是"只要连不上就试着拉"，
  //    加 60 秒冷却、最多 3 次 ⇒ 退出后的第 60/120/180 秒各拉一次。
  //
  //    修法两层：
  //      ① **时间窗口** —— 只在 DSH 启动后 90 秒内允许拉起
  //      ② **「用户主动退出」标记** —— 本会话内用户退出过 ⇒ 不拉
  //                                    （标记早于插件加载时间 ⇒ 上次会话的 ⇒ 忽略）
  check('插件有拉起时间窗口', /LAUNCH_WINDOW_MS/.test(plugin))
  check('窗口判断在 maybeLaunchPet 里', /now - pluginLoadedAt > LAUNCH_WINDOW_MS/.test(plugin))
  check('尝试次数降到 1（原来是 3）', /LAUNCH_MAX_ATTEMPTS = 1\b/.test(plugin))
  check('插件读「用户主动退出」标记', /function readQuitMark/.test(plugin))
  check('标记只在**本会话内**有效（比时间戳）',
    /quitMark\.at > pluginLoadedAt/.test(plugin))
  // ⚠️ **这里必须做功能测试，不能只测"代码里有没有这个词"。**
  //    实测踩过：写成 `/launch\.clearUserQuit\(app\)/.test(main)`，
  //    把调用改成 `false && launch.clearUserQuit(app)` 之后**测试照样是绿的**
  //    —— 典型的"永远通过的测试"，比没有测试更糟。
  // ⚠️ 静态检查只能守"接线在不在"。**实测过它的局限**：
  //    把调用改成 `false && launch.clearUserQuit(app)`，正则照样匹配、测试照样绿。
  //    ⇒ 所以这里额外要求**那一行不是被短路的**（行首不是 0/false/!），
  //      并且必须在 before-quit / whenReady 的上下文里。
  //    ⚠️ 真正的"有没有被调到"要靠 E2E（启动 app 再退出，看文件在不在），
  //       这里做不到 —— **这是已知缺口，如实记着**。
  const notShortCircuited = (src, call) => {
    const lines = src.split('\n').filter((l) => l.includes(call))
    if (!lines.length) return false
    return lines.every((l) => !/^\s*(if\s*\(\s*)?(false|0|!)/.test(l.trim()) || /if\s*\(\s*launch\./.test(l))
  }
  check('桌宠退出时写标记（接线，且没被短路）',
    notShortCircuited(main, 'launch.markUserQuit(app)'))
  check('桌宠启动时清标记（接线，且没被短路）',
    notShortCircuited(main, 'launch.clearUserQuit(app)'))
  check('launch.js 导出这两个函数',
    /markUserQuit,/.test(launchSrc) && /clearUserQuit,/.test(launchSrc))

  // ── 功能测试：真的调一遍，看文件有没有被写/被删 ──
  {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'quitmark-'))
    const fakeApp2 = {
      getPath: () => tmp2,
      getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-registered' }),
      setLoginItemSettings: () => {},
    }
    const { createRequire } = await import('node:module')
    const req2 = createRequire(import.meta.url)
    const l2 = req2(path.join(ROOT, 'src', 'launch.js'))

    const markFile = l2.quitMarkPath(fakeApp2)
    check('标记文件的路径算得出来', typeof markFile === 'string' && markFile.endsWith('quit-by-user.json'))

    check('一开始没有标记', !fs.existsSync(markFile))
    l2.markUserQuit(fakeApp2)
    check('⭐ markUserQuit 真的写出了文件', fs.existsSync(markFile))
    const mark = JSON.parse(fs.readFileSync(markFile, 'utf8'))
    check('⭐ 写进去的时间戳是个合理的毫秒数',
      typeof mark.at === 'number' && Math.abs(Date.now() - mark.at) < 60000)
    l2.clearUserQuit(fakeApp2)
    check('⭐ clearUserQuit 真的把文件删掉了', !fs.existsSync(markFile))
    check('重复 clear 不报错', (() => { try { l2.clearUserQuit(fakeApp2); return true } catch { return false } })())

    // 插件那边的判定规则：只有"晚于插件加载时间"的标记才算数
    check('插件用 quitMark.at > pluginLoadedAt 判定（本会话才算）',
      /quitMark\.at > pluginLoadedAt/.test(plugin))
    fs.rmSync(tmp2, { recursive: true, force: true })
  }
  check('标记写在 before-quit（覆盖 Cmd+Q，不只是菜单）',
    /before-quit[\s\S]{0,300}markUserQuit/.test(main))
}

// ── launch.json 的读写边界（用假的 app 对象，不碰真文件）──
console.log('\n【1.997】launch.json 读写')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-test-'))
  const fakeApp = {
    getPath: () => tmp,
    getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-registered' }),
    setLoginItemSettings: () => {},
  }
  const { createRequire } = await import('node:module')
  const require_ = createRequire(import.meta.url)
  const launch = require_(path.join(ROOT, 'src', 'launch.js'))

  check('读不存在的文件 → 默认值', JSON.stringify(launch.read(fakeApp)) ===
    JSON.stringify({ openAtLogin: false, followDsh: false, exePath: '' }))
  launch.write(fakeApp, { followDsh: true })
  check('写之后能读回来', launch.read(fakeApp).followDsh === true)
  launch.write(fakeApp, { exePath: '/x/y' })
  const r = launch.read(fakeApp)
  check('是合并写，不覆盖别的字段', r.followDsh === true && r.exePath === '/x/y')
  fs.writeFileSync(launch.launchPath(fakeApp), '{ 坏掉的 json')
  check('文件坏了 → 退回默认值（不让 app 起不来）',
    JSON.stringify(launch.read(fakeApp)) ===
    JSON.stringify({ openAtLogin: false, followDsh: false, exePath: '' }))
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n  ${fail === 0 ? '✅ 启动相关的检查通过' : '❌ 有问题'}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
