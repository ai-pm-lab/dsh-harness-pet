#!/usr/bin/env node
/**
 * install-plugin.mjs — 把桌宠插件接进 DSH 的 web profile
 *
 * 为什么不用 `dsh plugin add`：
 *   - 那个路径要 pnpm + npm registry 可达（国内经常不通）
 *   - 插件是零依赖的，没必要走包管理
 *   - 用绝对路径加载，插件版本永远跟 App 一起走，不会错配
 *
 * 做法：往 profile 的 cordis.patch.yml 里写一段**托管区块**，
 * 用注释标记边界，只动这一段，绝不碰用户的其他配置。
 *
 * 用法：
 *   node install-plugin.mjs            # 安装 / 更新
 *   node install-plugin.mjs --remove   # 卸载（只删托管区块）
 *   node install-plugin.mjs --dry-run  # 只显示会改什么
 *   node install-plugin.mjs --profile web
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ⚠️ 开始标记里带版本号（见下方 managedBlock 的说明），
// 所以识别时必须按**前缀**匹配，不能用完整字面量。
const MARK_PREFIX = '# --- dsh-harness-pet managed'
const MARK_END = '# --- end dsh-harness-pet managed'

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}

const dryRun = flag('--dry-run')
const remove = flag('--remove')
const profile = opt('--profile', 'web')

// 插件目录 = 本脚本所在目录下的 pet-plugin/
const here = path.dirname(new URL(import.meta.url).pathname)
const pluginDir = path.join(here, 'pet-plugin')

// ── 定位 DSH home 与 profile ──
// 优先级：显式配置 > $DSH_HOME > ~/.dsh（与 DSH 自己的解析顺序一致）
function resolveDshHome () {
  const explicit = opt('--dsh-home', null)
  if (explicit) return explicit
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

const dshHome = resolveDshHome()
const profileDir = path.join(dshHome, 'profiles', profile)
const patchPath = path.join(profileDir, 'cordis.patch.yml')

function fail (msg, hint) {
  console.error(`❌ ${msg}`)
  if (hint) console.error(`   ${hint}`)
  process.exit(1)
}

if (!fs.existsSync(profileDir)) {
  fail(
    `找不到 profile 目录：${profileDir}`,
    `先启动一次 DSH（dsh --profile ${profile}）让它初始化，或用 --dsh-home 指定正确的家目录。`,
  )
}
if (!fs.existsSync(patchPath)) {
  fail(
    `找不到 ${patchPath}`,
    '该 profile 可能还没被初始化过。',
  )
}
if (!remove && !fs.existsSync(path.join(pluginDir, 'index.js'))) {
  fail(`找不到插件入口：${path.join(pluginDir, 'index.js')}`)
}

// ── 读写 ──

const original = fs.readFileSync(patchPath, 'utf8')

/** 删掉旧的托管区块（如果存在）—— 按前缀识别，兼容任意版本号 */
function stripManaged (text) {
  const lines = text.split('\n')
  const begin = lines.findIndex((l) => l.startsWith(MARK_PREFIX))
  if (begin < 0) return text
  const end = lines.findIndex((l, i) => i >= begin && l.startsWith(MARK_END))
  const cut = end < 0 ? lines.length : end + 1
  return lines.slice(0, begin).concat(lines.slice(cut)).join('\n').replace(/\n{3,}/g, '\n\n')
}

const pluginVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')).version
  } catch { return '0.0.0' }
})()

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
  const entry = path.join(pluginDir, 'index.js')
  return [
    `${MARK_PREFIX} v${pluginVersion} (auto-generated; do not edit) ---`,
    '- insert:',
    '    - id: dsh-harness-pet',
    `      name: ${JSON.stringify(entry)}`,
    '      config:',
    '        verbose: true',
    MARK_END,
    '',
  ].join('\n')
}

const stripped = stripManaged(original)
const next = remove
  ? stripped
  : `${stripped.replace(/\s*$/, '\n')}\n${managedBlock()}`

// ── 基本校验：别把用户的配置写坏 ──

function sanityCheck (text) {
  const problems = []
  const lines = text.split('\n')
  const begins = lines.filter((l) => l.startsWith(MARK_PREFIX)).length
  const ends = lines.filter((l) => l.startsWith(MARK_END)).length
  if (begins !== ends) problems.push(`托管区块标记不成对（begin=${begins}, end=${ends}）`)
  if (begins > 1) problems.push(`出现多个托管区块（${begins} 个）`)
  const head = text.trimStart()
  if (!head.startsWith('[') && !head.startsWith('-') && !head.startsWith('#')) {
    problems.push('文件开头不像合法的 cordis.patch.yml')
  }
  return problems
}

const problems = sanityCheck(next)
if (problems.length) {
  fail('校验未通过，已放弃写入：\n   - ' + problems.join('\n   - '))
}

// ── 输出 ──

console.log(`DSH home : ${dshHome}`)
console.log(`profile  : ${profile}`)
console.log(`补丁文件 : ${patchPath}`)
console.log(`插件目录 : ${pluginDir}  (v${pluginVersion})`)
console.log()

if (original === next) {
  console.log('✓ 无需改动（已经是目标状态）')
  process.exit(0)
}

if (dryRun) {
  console.log('── 将要写入的内容（--dry-run，未落盘）──')
  console.log(next)
  process.exit(0)
}

// 备份：每次都留一份带时间戳的
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backup = `${patchPath}.bak-${stamp}`
fs.writeFileSync(backup, original)
fs.writeFileSync(patchPath, next)

console.log(remove ? '✅ 已移除托管区块' : '✅ 已写入托管区块')
console.log(`   备份：${path.basename(backup)}`)
console.log()
console.log('下一步：重启 DSH 让它加载插件')
console.log(`   dsh --profile ${profile}`)
console.log()
console.log('提示：web profile 的 patchReload 是 live，通常无需重启；')
console.log('      若没生效，再重启一次即可。')
