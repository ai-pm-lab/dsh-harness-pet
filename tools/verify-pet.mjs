#!/usr/bin/env node
/**
 * verify-pet.mjs — 校验一套桌宠素材**齐不齐、合不合规**
 *
 * 用法：
 *     npm run verify:pet -- whale-girl        # 查某一套
 *     npm run verify:pet                      # 查现在启用的那套
 *
 * 查什么：
 *   ① 图够不够 —— 按**那套自己的清单**逐张比对
 *   ② 有没有多余的图
 *   ③ 有没有空文件（生成失败留下的）
 *   ④ 体积分布（发现"某一张明显不对"）
 *   ⑤ manifest.json 在不在
 *
 * ── 用哪一套的清单？──
 *
 * ⚠️ 优先读 `assets/<id>/manifest.json`，没有才退回 `pet-spec.json`。
 *
 *    **为什么必须优先用 manifest**：`pet-spec.json` 的 `frames` 是
 *    「**代码需要**哪些帧」（和具体形象无关，现在 33 项），
 *    而每套形象实际做了多少张各不相同 —— 拿它去查某一套会**满屏假缺失**
 *    （月薪喵的工作帧用自己的 `miao_work_*` 命名，whale-girl 缺 `startle_2~6` 等）。
 *    实测踩到过。
 *
 *    ⚠️ **`whale-girl` 的 manifest 原来认不出来。** 它是早期写的，
 *    用的是 `animations` + `assets` 那套**旧格式**，没有 `frames` 字段 ——
 *    于是这里静默退回 `pet-spec.json`，一旦规格重新 dump 就会误报缺失。
 *    已经给它补上了 `frames`（26 张，只列磁盘上实际有的）。
 *    **加新形象时 manifest 一定要有 `frames`**，否则会走这条退路。
 *
 * 退出码：0 = 全过；1 = 有问题
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 查哪一套 ──
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
let style = args[0]
if (!style) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pet.js'), 'utf8')
  style = /const ACTIVE_STYLE = '([^']+)'/.exec(src)?.[1]
  if (!style) {
    console.error('❌ 没能从 pet.js 里读出 ACTIVE_STYLE，请显式指定: npm run verify:pet -- <id>')
    process.exit(1)
  }
  console.log(`（没指定，按 pet.js 里启用的那套查: ${style}）\n`)
}

const dir = path.join(ROOT, 'assets', style)
if (!fs.existsSync(dir)) {
  console.error(`❌ 没有 assets/${style}/ 这个目录`)
  console.error('   建一套新的: npm run new:pet -- <id> "显示名"')
  process.exit(1)
}

// ── 清单：优先这套自己的 manifest ──
const manPath = path.join(dir, 'manifest.json')
let manifest = null
if (fs.existsSync(manPath)) {
  try { manifest = JSON.parse(fs.readFileSync(manPath, 'utf8')) } catch { /* 下面会报 */ }
}

const specPath = path.join(ROOT, 'pet-spec.json')
let petSpec = null
if (fs.existsSync(specPath)) {
  try { petSpec = JSON.parse(fs.readFileSync(specPath, 'utf8')) } catch { /* 忽略 */ }
}

const FRAME_SIZE = petSpec?.asset?.frameSize ?? 512
let NEED = []
let source = ''
if (manifest && Array.isArray(manifest.frames) && manifest.frames.length) {
  NEED = manifest.frames.map((f) => ({ logical: f.logical, file: f.file }))
  source = 'assets/' + style + '/manifest.json'
} else if (petSpec) {
  NEED = petSpec.frames.map((f) => ({ logical: f.logical, file: f.file }))
  source = 'pet-spec.json（代码需要的全部帧 —— 这套没 manifest，走了退路）'
} else {
  console.error('❌ 既没有 manifest.json 也没有 pet-spec.json，没法校验')
  process.exit(1)
}

let problems = 0
const warn = (m) => console.log(`  ⚠️  ${m}`)
const bad = (m) => { console.log(`  ❌ ${m}`); problems += 1 }

console.log(`校验 assets/${style}/`)
console.log(`  清单来源: ${source}`)
console.log(`  需要 ${NEED.length} 张，规格 ${FRAME_SIZE}×${FRAME_SIZE}\n`)

// ── ① manifest ──
if (!manifest) {
  bad('没有 manifest.json —— 右键菜单「宠物形象」靠它列出这一套')
} else {
  if (!manifest.name) warn('manifest.json 里没有 name，菜单会显示目录名')
  console.log(`  ✅ manifest.json（name: ${manifest.name ?? '(没写)'}）`)
}

// ── ② 逐张查 ──
const present = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.webp')))
const missing = NEED.filter((f) => !present.has(f.file))
const sizes = []
const tiny = []
for (const f of NEED) {
  if (!present.has(f.file)) continue
  const st = fs.statSync(path.join(dir, f.file))
  if (st.size < 1024) tiny.push({ file: f.file, size: st.size })
  sizes.push(st.size)
}

if (missing.length) {
  bad(`缺 ${missing.length} 张：`)
  for (const m of missing) console.log(`        ${String(m.logical).padEnd(14)} → ${m.file}`)
} else {
  console.log(`  ✅ ${NEED.length} 张图都在`)
}

if (tiny.length) {
  bad(`有 ${tiny.length} 张小得可疑（可能是生成失败留下的空文件）：`)
  for (const t of tiny) console.log(`        ${t.file}  ${t.size} 字节`)
}

// ── ②b 磁盘上的 .webp 必须和清单**一一对应** ──
//
// 踩过的坑：把月薪喵的 manifest 从 20 张删到 16 张时，
// **漏删了一个文件** —— 因为 `ready2` 映射的文件名是 `ready.webp`
// （和逻辑名不一致的那个例外），而我只按 `ready_2.webp` 去删。
// 后果很难发现：脚本按"有没有加载到 ready2"判断庆祝用两帧还是四帧，
// 文件还在 → 判定失败 → 用了四帧的循环 → 后两帧是空的。
//
// **是运行时自检（selfTestReadyClip）抓出来的，不是静态检查。**
// 这条测试把那个教训固化下来。
{
  const man = NEED.map((f) => f.file)
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.webp'))
  const ghost = man.filter((f) => !onDisk.includes(f))
  const stray = onDisk.filter((f) => !man.includes(f))
  if (ghost.length) bad(`清单里有 ${ghost.length} 张磁盘上不存在：${ghost.join(' ')}`)
  if (stray.length) bad(`磁盘上有 ${stray.length} 张清单没列（删漏了？）：${stray.join(' ')}`)
  if (!ghost.length && !stray.length) console.log(`  ✅ 磁盘上的 .webp 和清单一一对应（${man.length} 张）`)
}

// ── ③ 多余的 ──
const expected = new Set(NEED.map((f) => f.file))
const extra = [...present].filter((f) => !expected.has(f))
if (extra.length) {
  warn(`有 ${extra.length} 张不在清单里（多半没事，确认一下是不是改名漏改）：`)
  for (const f of extra.slice(0, 8)) console.log(`        ${f}`)
  if (extra.length > 8) console.log(`        …还有 ${extra.length - 8} 张`)
}

// ── ④ 体积分布 ──
if (sizes.length > 4) {
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length
  const kb = (n) => Math.round(n / 1024)
  console.log(`  ℹ️  体积: 平均 ${kb(avg)} KB，最小 ${kb(Math.min(...sizes))} KB，最大 ${kb(Math.max(...sizes))} KB`)
  const odd = sizes.filter((s) => s < avg * 0.25).length
  if (odd) warn(`${odd} 张明显比其他小（不到平均的 1/4）—— 可能是空白图或抠图失败`)
}

// ── ⑤ 更严格的几何检查交给 Python ──
console.log()
console.log('  ℹ️  尺寸 / 透明通道 / 轮廓比例，跑这两个（它们用 PIL 真解码）：')
console.log(`       python3 tools/verify_assets.py`)
console.log(`       python3 tools/silhouette.py --ref pet-art/${style}/refs/00-petdex-站立.png --style ${style}`)

console.log()
if (problems) {
  console.log(`❌ 有 ${problems} 个问题`)
  console.log('   还缺的图用 AI 生成: python3 tools/batch-gen.py --style ' + style)
  process.exit(1)
}
console.log('✅ 素材完整')
