#!/usr/bin/env node
/**
 * test-modules.mjs — 模块导出与调用点的一致性检查
 *
 * 为什么单独写这个：
 * 曾经在 translate-config.js 里**写了 save() 但忘了导出**，
 * 结果点菜单里的「接口：自定义大模型」直接弹出
 * "TypeError: translateConfig.save is not a function" 的崩溃框。
 *
 * 这类错误的共同点是：**代码看起来完全正常**（函数确实写了、
 * 调用点也确实在那儿），只有真正点到那一条路径才会炸。
 * 单元测试也不容易覆盖到（要刚好走到那个分支）。
 *
 * 所以这里做**静态检查**：把 main.js 里所有 `xxx.yyy(` 形式的调用
 * 抓出来，逐个核对 yyy 是否真的在模块的导出里。
 * 覆盖不到运行时行为，但能精确拦住这一类。
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

let ok = true
function check (label, pass, extra = '') {
  console.log(`  ${pass ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!pass) ok = false
}

// main.js 里 require 进来的本地模块 → 变量名
const MODULES = {
  platform: './src/platform.js',
  bridge: './src/bridge.js',
  dialogues: './src/dialogues.js',
  bubbleController: './src/bubble-controller.js',
  translateClient: './src/translate.js',
  translateConfig: './src/translate-config.js',
  selectionWatcher: './src/selection.js',
}

const mainSrc = fs.readFileSync(path.join(__dirname, 'src', 'main.js'), 'utf8')

console.log('【1】main.js 调用的每个方法都真的导出了吗')

for (const [alias, rel] of Object.entries(MODULES)) {
  let mod
  try {
    mod = require(path.join(__dirname, rel))
  } catch (error) {
    check(`${alias} 能加载`, false, error.message)
    continue
  }

  // 抓 `alias.method(` —— 只看方法调用，不看属性访问
  const pattern = new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g')
  const called = new Set()
  for (const match of mainSrc.matchAll(pattern)) called.add(match[1])

  if (called.size === 0) {
    console.log(`  ⏭  ${alias}：没有方法调用`)
    continue
  }

  const missing = [...called].filter((name) => typeof mod[name] !== 'function')
  check(
    `${alias}（${called.size} 个方法：${[...called].join(', ')}）`,
    missing.length === 0,
    missing.length ? `❌ 没有导出：${missing.join(', ')}` : '',
  )
}

console.log('\n【2】渲染层/preload 用到的模块也检查一遍')

for (const rel of ['src/bubble/bubble.js', 'src/settings/settings.js']) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8')
  const html = rel.includes('bubble')
    ? 'src/bubble/index.html'
    : 'src/settings/index.html'
  const htmlSrc = fs.readFileSync(path.join(__dirname, html), 'utf8')

  // ⚠️ 方向很重要：要查的是「**脚本引用的 id 在不在 HTML 里**」，
  // 不是反过来。HTML 里多几个只给 CSS 用的 id 完全正常
  // （第一版就写反了，把 CSS 用的 #tail 误报成错误）。
  //
  // 这个检查能拦住最常见的静默失败：getElementById 返回 null，
  // 然后 el.addEventListener 抛错，整个脚本不执行。
  const htmlIds = new Set([...htmlSrc.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]))
  const scriptIds = new Set([
    ...[...src.matchAll(/getElementById\(['"]([\w-]+)['"]\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]),
  ])
  const missingIds = [...scriptIds].filter((id) => !htmlIds.has(id))
  check(
    `${rel} 引用的 ${scriptIds.size} 个元素 id 都在 HTML 里`,
    missingIds.length === 0,
    missingIds.length ? `引用了不存在的 id：${missingIds.join(', ')}` : '',
  )
}

console.log('\n【3】跨平台准备：平台差异有没有漏在外面')

// 平台专有的 API 必须只在 platform.js 里出现，
// 散在外面的话，做 Windows 版时一定会有漏掉的。
const PLATFORM_ONLY = [
  "setAlwaysOnTop(true, 'screen-saver')",
  'setVisibleOnAllWorkspaces',
  "type: 'panel'",
]
for (const rel of ['src/main.js', 'src/bridge.js']) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8')
  const leaked = PLATFORM_ONLY.filter((needle) => {
    // 只看真正的调用，注释里提到不算
    const lines = src.split('\n').filter((l) => l.includes(needle) && !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    return lines.length > 0
  })
  check(`${rel} 没有漏出平台专有 API`, leaked.length === 0,
    leaked.length ? `应该收进 platform.js：${leaked.join(' / ')}` : '')
}

console.log('\n【4】跨平台路径')
const platform = require(path.join(__dirname, 'src', 'platform.js'))
check('platform.js 能算出 userData 根目录', Boolean(platform.userDataBase()), platform.userDataBase())
check('macOS 上算出的是 ~/Library/Application Support',
  process.platform !== 'darwin' || platform.userDataBase().endsWith('Library/Application Support'))

// 插件的路径逻辑必须覆盖三大平台（它是独立分发的，不能 require 这里）
const pluginSrc = fs.readFileSync(path.join(__dirname, 'pet-plugin', 'index.js'), 'utf8')
check('插件处理了 Windows 的 %APPDATA%', pluginSrc.includes('APPDATA'))
check('插件处理了 macOS 的 Library/Application Support', pluginSrc.includes('Library'))
check('插件处理了 Linux 的 XDG_CONFIG_HOME', pluginSrc.includes('XDG_CONFIG_HOME'))

console.log('\n【5】同一个常量不要在两个文件里各定义一份')

// ⚠️ 踩过的坑：把 TAIL_OVERLAP 定义在 bubble-controller.js 和 main.js 两处，
// 改了 main.js 那份（根本没被引用）还美滋滋地以为生效了 ——
// 表现是"改了没反应"，查半天。
const constOwners = new Map()
for (const rel of ['src/main.js', 'src/bubble-controller.js', 'src/platform.js', 'src/bridge.js']) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8')
  for (const m of src.matchAll(/^const ([A-Z][A-Z0-9_]{2,}) =/gm)) {
    if (!constOwners.has(m[1])) constOwners.set(m[1], [])
    constOwners.get(m[1]).push(rel)
  }
}
const dupes = [...constOwners].filter(([, files]) => files.length > 1)
check('没有跨文件重复定义的大写常量', dupes.length === 0,
  dupes.map(([name, files]) => `${name} 在 ${files.join(' 和 ')}`).join('；'))

console.log('\n【新】测试文件自己不许有重复 import')
// 我自己连着踩了两次：往 test-bubble.mjs / test-translate.mjs 里补
// `import fs from 'node:fs'` 时没查重，直接报
//   `SyntaxError: Identifier 'path' has already been declared`
// 整个测试文件跑不起来。这类错只影响测试、不影响产品，特别容易漏 ——
// 所以让测试自己守。
{
  const dir = ROOT
  const files = fs.readdirSync(dir).filter((f) => /^test-.*\.mjs$/.test(f))
  check(`扫到 ${files.length} 个 test-*.mjs`, files.length >= 5)
  let dup = 0
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
    const seen = new Set()
    for (const l of lines) {
      const t = l.trim()
      if (!t.startsWith('import ')) continue
      if (seen.has(t)) { dup += 1; console.log(`      ❌ ${f}: 重复 ${t}`) }
      seen.add(t)
    }
  }
  check('没有重复的 import 行', dup === 0, `发现 ${dup} 处`)
}

console.log(`\n${ok ? '✅ 模块一致性检查通过' : '❌ 有问题'}`)
process.exit(ok ? 0 : 1)
