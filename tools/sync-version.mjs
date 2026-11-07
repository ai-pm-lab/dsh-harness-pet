#!/usr/bin/env node
/**
 * sync-version.mjs — 把 `package.json` 的版本号同步到其他**手写**的地方。
 *
 * ── 为什么需要它 ──
 *
 * 版本号本来散在三个地方：
 *   1. `package.json`                        ← 唯一权威
 *   2. `胖头鱼（开发版）.app/Contents/Info.plist`       ← **手写的壳**，不跟着 package.json 走
 *   3. `dialogues/*.md` 顶部如果有 `<!-- version: x.y.z -->` 标记
 *
 * 体检时发现 2 和 3 都停在 `0.1.0` 而 `package.json` 已经是 `0.2.0` ——
 * 而**这不只是显示问题**：内置台词的覆盖逻辑是「版本变了才覆盖」，
 * 版本号对不上的话，用户改了台词却不被备份、或者每次启动都被覆盖。
 *
 * ⚠️ 将来用 `electron-builder` 打包之后，它会自己把 package.json 的版本
 *    写进真 bundle 的 Info.plist —— 那时这个脚本只剩 README 那一处要管。
 *    但**在那之前**，这个手写壳就是唯一的"可双击入口"，必须同步。
 *
 * 用法：
 *   node tools/sync-version.mjs           # 同步
 *   node tools/sync-version.mjs --check   # 只检查，不一致就退出码 1（给 preflight 用）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK = process.argv.includes('--check')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
if (!/^\d+\.\d+\.\d+/.test(VERSION)) {
  console.error(`❌ package.json 里的 version 不像版本号: ${VERSION}`)
  process.exit(2)
}

const changes = []
const problems = []
const skipped = []

function patch (label, file, transform) {
  const abs = path.join(ROOT, file)
  if (!fs.existsSync(abs)) {
    // ⚠️ **不存在就跳过，不要报错。**
    //
    // 踩到的：`Info.plist` 那个目标在 `.dev/胖头鱼（开发版）.app/` 里，
    // 而 `.dev/` 是 **gitignored** 的（只是本机的开发壳）。
    // ⇒ 干净 clone 出来的仓库里没有它 ⇒ 这里报"文件不存在" ⇒
    //   `--check` 退出码 1 ⇒ **`test-mainmenu.mjs` 在别人的机器上直接变红**。
    //
    // **这个 bug 在开发机上看不出来**（`.dev/` 一直在），
    // 只有干净 clone 才会暴露 —— 做公开仓库时才发现的。
    skipped.push(label)
    return
  }
  const before = fs.readFileSync(abs, 'utf8')
  const after = transform(before)
  if (after === null) {
    problems.push(`${label}: 没找到要替换的版本号 —— 格式变了吗？`)
    return
  }
  if (before === after) return
  changes.push({ label, file, before, after })
  if (!CHECK) fs.writeFileSync(abs, after)
}

// ── 1. 壳的 Info.plist（两个键都要改）──
patch('Info.plist', '.dev/胖头鱼（开发版）.app/Contents/Info.plist', (s) => {
  // ⚠️ **"没找到模式"和"已经是对的"要分开** —— 都返回 null 的话，
  //    同步成功之后再跑一次 --check 会误报"格式变了吗"（实测踩到）。
  //    null = 真的没找到；原样返回 = 已经对了、不用改。
  if (!/<key>CFBundleShortVersionString<\/key>/.test(s)) return null
  return s
    .replace(/(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
      `$1${VERSION}$2`)
    .replace(/(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/,
      `$1${VERSION}$2`)
})

// ── 2.（已移除）README 的「## 当前状态（vX.Y.Z）」──
//
// ⚠️ **这一节已经从 README 删掉了**（用户要求：README 给普通用户看，
//    不该在里面堆版本号和开发状态）。所以这里不再同步 README。
//
// 去掉之后有个连带好处：README 变成**不用跟着版本号改**的文件，
// 发版时少一处要维护、也少一处会忘记同步的地方。
//
// `preflight.sh` 和 `test-mainmenu.mjs` 里那两条"版本号一致性"的**说法**
// 也跟着去掉了 README —— 不然它们会去 README 里找已经不存在的东西。

// ── 3. 内置台词头部如果带版本标记，也跟着走 ──
//    （格式见 README「台词文件」那节；没有标记就跳过，不算错）
for (const lang of ['zh']) {
  const rel = `dialogues/${lang}.md`
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) continue
  const s = fs.readFileSync(abs, 'utf8')
  const m = s.match(/<!--\s*version:\s*(\d+\.\d+\.\d+)\s*-->/)
  if (!m) continue
  if (m[1] === VERSION) continue
  changes.push({ label: `dialogues/${lang}.md`, file: rel, before: s, after: s.replace(m[0], `<!-- version: ${VERSION} -->`) })
  if (!CHECK) fs.writeFileSync(abs, s.replace(m[0], `<!-- version: ${VERSION} -->`))
}

// ── 输出 ──
console.log(`package.json 的版本：${VERSION}`)
console.log()

if (problems.length) {
  for (const p of problems) console.log(`  ⚠️  ${p}`)
  console.log()
}

if (!changes.length) {
  console.log('  ✅ 其他地方都是这个版本，不用改')
  process.exit(problems.length ? 1 : 0)
}

for (const c of changes) {
  console.log(`  ${CHECK ? '❌' : '🔧'} ${c.label}  → ${VERSION}`)
}

if (CHECK) {
  console.log()
  if (skipped.length) console.log(`  ℹ️  跳过（本机没有这些文件，正常）: ${skipped.join(', ')}`)
  console.log('  ❌ 版本号不一致。跑 `node tools/sync-version.mjs` 同步。')
  process.exit(1)
}

console.log()
console.log(`  ✅ 已同步 ${changes.length} 处`)
