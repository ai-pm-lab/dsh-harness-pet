#!/usr/bin/env node
/**
 * new-pet.mjs — 给一套新桌宠建骨架
 *
 * 用法：
 *     npm run new:pet -- pixel-whale "像素鲸鱼"
 *
 * 建出什么：
 *     assets/<id>/
 *       manifest.json      ← 形象元信息（菜单里显示的名字就是它）
 *       README.md          ← 这套还缺哪些图、怎么补
 *       .gitkeep
 *     pet-art/<id>/          ← 源图放这儿（AI 生成的 PNG，别删）
 *     dialogues/<lang>.md 的模板 → 打印出来，不直接覆盖现有的
 *
 * ⚠️ **不生成图片。** 图要靠 `tools/gen-frames.py` 逐张生成 + 人工挑，
 *    这个脚本只负责把目录结构和"还缺什么"的清单摆好。
 *
 * 图稿清单从 `pet-spec.json` 读（`npm run dump:spec` 导出的），
 * **不是写死在这里** —— 写死的话，以后加一个动画，新宠物的清单就漏一项。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const id = args[0]
const displayName = args[1] || id

if (!id) {
  console.error('用法: npm run new:pet -- <id> "显示名"')
  console.error('例如: npm run new:pet -- pixel-whale "像素鲸鱼"')
  process.exit(1)
}
if (!/^[a-z][a-z0-9-]*$/.test(id)) {
  console.error(`❌ id 只能用小写字母、数字、连字符（现在: ${id}）`)
  console.error('   它会被当成目录名和菜单里的 key，别用中文或空格')
  process.exit(1)
}

// ── 读规格 ──
const specPath = path.join(ROOT, 'pet-spec.json')
if (!fs.existsSync(specPath)) {
  console.error('❌ 找不到 pet-spec.json —— 先跑 `npm run dump:spec` 生成它')
  process.exit(1)
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))

const styleDir = path.join(ROOT, 'assets', id)
if (fs.existsSync(styleDir)) {
  console.error(`❌ assets/${id}/ 已经存在了`)
  process.exit(1)
}

// ── ① 素材目录 ──
fs.mkdirSync(styleDir, { recursive: true })
const manifest = {
  name: displayName,
  description: `由 tools/new-pet.mjs 生成，还需要补 ${spec.frames.length} 张图`,
  frameSize: spec.asset.frameSize,
  // ⚠️ 这张清单是**目标和现状的对照**。做完一张就把对应项的 `done` 改成 true，
  //    或者直接跑 `npm run verify:pet -- <id>` 让它自己查文件在不在。
  frames: spec.frames.map((f) => ({ logical: f.logical, file: f.file, done: false })),
  generatedAt: new Date().toISOString().slice(0, 10),
}
fs.writeFileSync(path.join(styleDir, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n')

// ── ② 源图目录 ──
const artDir = path.join(ROOT, 'pet-art', id)
fs.mkdirSync(artDir, { recursive: true })
fs.writeFileSync(path.join(artDir, '.gitkeep'), '')

// ── ③ 这套还缺什么的清单 ──
// ⚠️ **清单直接从规格平铺列出，不做分组。**
//
//    第一版手写了一张分组表 → 漏掉 slowBlink / blinkTwice 等四张。
//    第二版改成"按片段分组" → 又漏了（ready 有 5 张只列出 4 张，
//    还冒出一个"其它"，因为一张图被多个片段共用时归属会打架）。
//
//    **两次都是"想让它更好看"反而漏东西。** 平铺最笨，但一张不落。
//    要看每张图归谁用，`pet-spec.json` 的 clips[].frames 里写得很清楚。
const fileOf = Object.fromEntries(spec.frames.map((f) => [f.logical, f.file]))
// 反向索引：这张图被哪些片段用到（多个片段共用很正常，如实列出来）
const usedBy = {}
for (const c of spec.clips) {
  for (const l of new Set(c.frames)) (usedBy[l] ??= []).push(c.name)
}
for (const n of spec.idleChain ?? []) {
  for (const l of new Set(n.frames)) (usedBy[l] ??= []).push(`待机:${n.name}`)
}

const rows = spec.frames.map((f) => {
  const by = usedBy[f.logical] ?? []
  return `| \`${f.logical}\` | \`${f.file}\` | ${by.length ? by.join('、') : '—'} | ⬜ |`
})
const todo = `
**${spec.frames.length} 张，一张不能少：**

| 逻辑名 | 文件名 | 用在哪 | 好了吗 |
|---|---|---|---|
${rows.join('\n')}
`
fs.writeFileSync(path.join(styleDir, 'README.md'), `# ${displayName}

> 由 \`npm run new:pet -- ${id} "${displayName}"\` 生成

## 还缺什么

**${spec.frames.length} 张图**，规格见 [\`pet-spec.json\`](../../pet-spec.json)：

| 项 | 要求 |
|---|---|
| 尺寸 | **${spec.asset.frameSize} × ${spec.asset.frameSize}**，透明背景 |
| 格式 | \`.webp\` |
| 构图 | 内容居中，**占高约 85%** |
| 源图 | 留在 \`pet-art/${id}/\`（**别删**）|

## ⚠️ 两个**能量化**的比例（别只靠眼睛看）

做月薪喵时踩了两次，都是"看一眼觉得还行"结果不对：

| 指标 | 怎么量 | 为什么要 |
|---|---|---|
| **轮廓比例** | \`python3 tools/silhouette.py --ref pet-art/${id}/_reference.png --style ${id}\` | 耳朵张开度跑偏过一次（93% vs 参考图 65%）—— **画成了大翅膀** |
| **底边形状** | \`python3 tools/bottom_shape.py --style ${id}\` | 底边中间凸起/凹进过一次，参考图是**平直横线** |

**这两样都是几何量，能量出来。** 生成后逐张跑一遍，比"我看了一眼"可靠。

${todo}
## 怎么补

\`\`\`bash
# ① 生成候选（AI，火山方舟 Seedream）
python3 tools/gen-frames.py --action <动作名> --count 3 --process --webp

# ② 挑一张登记进 manifest
python3 tools/add-frame.py --style ${id} --logical awake --from <选中的png>

# ③ 随时查还缺哪些
npm run verify:pet -- ${id}
\`\`\`

**做完了要接线**：\`src/renderer/pet.js\` 的 \`ACTIVE_STYLE\` / \`FRAME_FILES\`，
以及 \`manifest.json\` 里的 \`name\`。

完整流程见 [\`docs/pet-workflow.md\`](../../docs/pet-workflow.md)。
`)

console.log(`✅ 骨架建好了: assets/${id}/`)
console.log(`   显示名: ${displayName}`)
console.log(`   源图目录: pet-art/${id}/`)
console.log(`   需要补 ${spec.frames.length} 张图（清单见 assets/${id}/README.md）`)
console.log()
console.log('下一步：')
console.log(`   python3 tools/gen-frames.py --action awake --count 3 --process --webp`)
console.log(`   npm run verify:pet -- ${id}`)
