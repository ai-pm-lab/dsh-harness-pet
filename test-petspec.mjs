#!/usr/bin/env node
/**
 * test-petspec.mjs — 做新宠物的那套工具，自己要有测试
 *
 * 为什么：这三个工具（dump-spec / new-pet / verify-pet）是**给别人做新宠物用的**，
 * 它们错了比没有更糟 —— 用户会照着错的清单准备素材，然后发现跑不起来。
 *
 * 而且写这三个工具时**已经踩了两次同样的坑**：
 *   · 第一版 `new-pet` 手写分组表 → 漏了 4 张图
 *   · 第二版改成"按片段分组" → 又漏（ready 5 张只列 4 张，还多出个"其它"）
 * 两次都是"想让它更好看"反而漏东西。所以这里**逐张比对**，不靠分组。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
let ok = true
const check = (label, pass, extra = '') => {
  console.log(`  ${pass ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`)
  if (!pass) ok = false
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

console.log('【1】规格文件存在且完整')
const spec = JSON.parse(read('pet-spec.json'))
check('有 frames', Array.isArray(spec.frames) && spec.frames.length > 0, `${spec.frames.length} 张`)
check('有 clips', Array.isArray(spec.clips) && spec.clips.length > 0, `${spec.clips.length} 个`)
check('有 dialogues', Object.keys(spec.dialogues).length > 0, `${Object.keys(spec.dialogues).length} 个状态`)
check('有待机链', Array.isArray(spec.idleChain) && spec.idleChain.length > 0, `${spec.idleChain.length} 个节点`)
check('有素材规格', Boolean(spec.asset?.frameSize), `${spec.asset?.frameSize}px`)

console.log('\n【2】规格和实际素材一致（逐张比对，不靠分组）')
// ⚠️ **这里原来写死比 `assets/whale-girl`，是错的。**
//
//    `pet-spec.json` 的 `frames` 是「**代码需要**哪些帧」（来自 FRAME_FILES），
//    而 `assets/<id>/` 是「**实际做了**哪些」—— 两者本来就可能不同：
//    老形象缺后来新增的动画帧是正常的（whale-girl 就缺 startle_2~6 / ready_5 /
//    wave_3 这 7 张，运行时 showFrame 会回退到 awake）。
//
//    所以检查改成三条：
//      ① 规格里的每张，**至少有一套形象有**（哪都没有 = 代码引用了不存在的素材，是真错）
//      ② 每套形象的目录里**有多余文件**才算错（目录不该有规格外的图）
//      ③ 每套缺哪些 —— **只报信息，不算错**（那是素材进度，不是 bug）
const want = spec.frames.map((f) => f.file)
const wantSet = new Set(want)
const styles = spec.asset?.styles
check('规格记录了每套形象实际有哪些帧（asset.styles）', Boolean(styles && Object.keys(styles).length > 0),
  styles ? Object.keys(styles).join(' ') : '老规格没这个字段，跑 npm run dump:spec')

if (styles) {
  const hasAnywhere = new Set(Object.values(styles).flatMap((s) => s.has))
  const nowhere = [...wantSet].filter((f) => !hasAnywhere.has(f))
  check(`规格里的 ${wantSet.size} 张每张都至少有一套形象有`, nowhere.length === 0,
    nowhere.length ? `哪都没有: ${nowhere.join(' ')}` : '')

  for (const [id, s] of Object.entries(styles)) {
    // ⚠️ **"目录里有规格外的图"不算错。**
    //    形象可以有专有帧（月薪喵就有 28 张 greet + 4 张 miao_work，
    //    它们只在 STYLE_FRAMES['yuexin-miao'] 里，是个"打招呼动画"用的），
    //    也可以是还没接进代码的备用素材。
    //    真正的错是上面那条"规格要的帧哪都没有"。
    const extra = s.has.filter((f) => !wantSet.has(f))
    const lack = [...wantSet].filter((f) => !s.has.includes(f))
    console.log(`     ℹ️  ${id}: ${s.has.length} 张，规格外 ${extra.length} 张，还缺 ${lack.length} 张`)
    if (extra.length) console.log(`         规格外（专有/备用）：${extra.slice(0, 6).join(' ')}${extra.length > 6 ? ` …共 ${extra.length} 张` : ''}`)
    if (lack.length) console.log(`         还缺：${lack.join(' ')}`)
  }
}

console.log('\n【3】每个片段引用的帧都在规格里')
const logicals = new Set(spec.frames.map((f) => f.logical))
const badRefs = []
for (const c of spec.clips) {
  for (const l of new Set(c.frames)) if (!logicals.has(l)) badRefs.push(`${c.name}→${l}`)
}
check('片段引用的逻辑名都有效', badRefs.length === 0, badRefs.join(' '))

console.log('\n【4】待机链引用的帧也在规格里')
const chainBad = []
for (const n of spec.idleChain ?? []) {
  for (const l of new Set(n.frames ?? [])) if (!logicals.has(l)) chainBad.push(`${n.name}→${l}`)
}
check('待机链引用的逻辑名都有效', chainBad.length === 0, chainBad.join(' '))

console.log('\n【5】没有假动画（多帧同图又没位移）')
//
// ⚠️ 这条和 pet.js 的 `selfTestFakeMotion` 是同一件事，但**在规格层面再查一次** ——
//    规格是给做新宠物的人看的，如果里面就带着假动画，照着做出来的也是假的。
const fake = spec.clips.filter((c) => c.frameCount > 1 && c.motion === 'still')
check('没有假动画', fake.length === 0, fake.map((c) => `${c.name}(${c.frameCount}帧)`).join(' '))

console.log('\n【6】每个状态都有中文名')
const labelsSrc = read('src/state-labels.js')
const missingLabel = Object.keys(spec.dialogues).filter((k) => {
  // 状态表里要么作为 key 出现（`idle:`），要么在 labelWithKey 的注释里
  return !new RegExp(`\\b${k}:`).test(labelsSrc)
})
check('都能查到中文名', missingLabel.length === 0, missingLabel.join(' '))

console.log('\n【7】三个工具都注册成 npm script')
const scripts = JSON.parse(read('package.json')).scripts
for (const name of ['dump:spec', 'new:pet', 'verify:pet']) {
  check(`npm run ${name}`, Boolean(scripts[name]), scripts[name] ?? '')
}

console.log('\n【8】工作流文档和实际命令对得上')
const doc = read('docs/pet-workflow.md')
for (const cmd of ['npm run new:pet', 'npm run dump:spec', 'npm run verify:pet']) {
  check(`文档里提到 ${cmd}`, doc.includes(cmd))
}

console.log(`\n${ok ? '✅ 做新宠物的工具链验证通过' : '❌ 有问题'}`)
process.exit(ok ? 0 : 1)
