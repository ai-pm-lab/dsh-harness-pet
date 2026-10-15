#!/usr/bin/env node
/**
 * build-demo.mjs — 把演示页打包成**一个自包含的 HTML 文件**
 *
 * 为什么需要它：`src/renderer/preview.html` 是给开发用的，它依赖
 * 同目录的 `pet.js` / `state-labels.js`，而图片路径是硬编码的
 * `../../assets/<风格>/<文件>.webp`。**直接拷到桌面会打不开** ——
 * 打开是一张空白页，控制台里一堆 404。
 *
 * 所以这个脚本把几样东西全塞进一个文件：
 *   ① `state-labels.js` 和 `pet.js` → 内联进 `<script>`
 *   ② 每个形象的 webp → base64 data URI（按形象分组，见 `__DEMO_ASSETS`）
 *   ③ 每个形象的多帧动画（manifest 的 clips）→ `__DEMO_CLIPS`
 *   ④ 顶部一个**形象切换**下拉，换形象 = 换 `?style=` 重载
 *   ⑤ 去掉 `<script src=...>` 标签
 *
 * 产物：`Study/桌宠文件/胖头鱼演示文件.html`（双击就能看，不依赖仓库）
 *
 * ⚠️ **切形象为什么要重载页面**：
 *    `pet.js` 里 `ACTIVE_STYLE` 是从 `location.search` 读的 **const**，
 *    运行期改不了。而单文件版和真 App 一样、始终是同一个页面 ——
 *    所以切换 = 改 query 重载。图片和 clips 都按形象分好组内联在里面，
 *    重载后自然取到另一套。**不需要改 pet.js 的状态机。**
 *
 * 用法：`npm run build:demo`
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// ⚠️ **用户 2026-10-06 定的新规矩：桌宠项目的一切产物都放 `Study/桌宠文件/`，不放桌面。**
//
//    · 演示页（整个 App 的，几个形象都在里面）→ `桌宠文件/胖头鱼演示文件.html`
//    · 每个形象的产出 → `桌宠文件/<形象名>素材文件/`
//
//    原来写的是 `~/Desktop/胖头鱼演示文件.html`，后来一度两处都写 ——
//    现在**只写 `桌宠文件/` 这一处**，桌面那份用户已经删了。
//
//    想换地方：`DSH_DEMO_OUT=/some/path.html node tools/build-demo.mjs`
const OUT = process.env.DSH_DEMO_OUT
  || path.resolve(ROOT, '..', '桌宠文件', '胖头鱼演示文件.html')

// 目录不存在就创建 —— 这是用户指定的正式产出位置，不像以前那份"第二份副本"
// 需要"目录存在才写"。头一次跑的时候目录可能还没建。
const EXTRA_OUTS = []
const DEFAULT_STYLE = 'big-fish'   // ⚠️ 和 src/main.js 的 DEFAULT_STYLE 保持一致

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/**
 * ⚠️ **所有替换都必须用函数式，不能传字符串。**
 *
 *    `String.prototype.replace` 的**字符串**替换串里，`$` 是有含义的：
 *        `$&`  → 匹配到的子串
 *        `` $` `` → 匹配**之前**的全部内容
 *        `$'`  → 匹配**之后**的全部内容     ← 踩的就是这个
 *        `$$`  → 一个字面 `$`
 *
 *    而我们要内联的代码里**天然就有 `$'`** ——
 *    `pet.js` 里一句 `.startsWith('$')` 正好构成这个序列。
 *    结果 `html.replace(..., 源码)` 把**匹配点之后的整份 HTML**
 *    又插了一遍，脚本块当场错位：
 *        产物里 pet.js 被劈成两半，控制台报
 *        `SyntaxError: Invalid or unexpected token`，而且报的行号毫无线索。
 *    实测查了很久才定位到。
 *
 *    传函数就完全绕开这个机制 —— 返回值原样插入，不做任何解释。
 */
const put = (haystack, needle, replacement) => haystack.replace(needle, () => replacement)

let html = read('src/renderer/preview.html')
const petJs = read('src/renderer/pet.js')
const labelsJs = read('src/state-labels.js')

// ── ① 有哪些形象 ──
//
// 扫 assets/ 下所有带 manifest.json 的目录 —— 和右键菜单同一套判断，
// 新加一套宠物不用改这个脚本。
const assetsRoot = path.join(ROOT, 'assets')
const STYLES = fs.readdirSync(assetsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(assetsRoot, d.name, 'manifest.json')))
  .map((d) => {
    const m = JSON.parse(fs.readFileSync(path.join(assetsRoot, d.name, 'manifest.json'), 'utf8'))
    return { id: d.name, name: m.name || d.name, clips: m.clips && typeof m.clips === 'object' ? m.clips : {} }
  })
if (!STYLES.length) {
  console.error('❌ assets/ 下没有带 manifest.json 的形象')
  process.exit(1)
}

// ── ② 图片 → base64（按形象分组）──
const assets = {}
const clips = {}
let total = 0
for (const st of STYLES) {
  const dir = path.join(assetsRoot, st.id)
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.webp')).sort()
  assets[st.id] = {}
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, f))
    total += buf.length
    assets[st.id][f.replace(/\.webp$/, '')] = `data:image/webp;base64,${buf.toString('base64')}`
  }
  clips[st.id] = st.clips
}

// ── ③ 话术：用**真的解析器**解析，把结果内联成 JSON ──
//
// ⚠️ 必须用 `src/dialogues.js` 那个解析器，不能在浏览器里现解析 ——
//    那个文件是 CommonJS（`require('node:fs')` 等），浏览器跑不了。
//    构建时解析好、内联成纯数据，演示页只负责随机抽一句。
//
// ⚠️⚠️ **必须走 `load()`，不能直接 `parse(read('dialogues/zh.md'))`。**
//    话术有**两层**：
//        1. `<userData>/dialogues/zh.md`  ← 用户自己改的那份
//        2. `<App>/dialogues/zh.md`       ← 内置默认
//    真 App 走的是 `dialogues.load(lang, app.getPath('userData'))`，用户那份优先。
//    演示页原来直接读**内置**那份 —— 于是"我明明改过台词，演示页还是默认的"。
//    `load()` 内部就是"用户优先、内置兜底"，直接复用同一套逻辑最稳。
const { createRequire } = await import('node:module')
const require2 = createRequire(import.meta.url)
const dialoguesMod = require2(path.join(ROOT, 'src', 'dialogues.js'))

/** 和 Electron 的 `app.getPath('userData')` 同一个位置（按平台推）。 */
function userDataDir () {
  const APP = '胖头鱼'
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP)
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP)
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP)
}

const table = dialoguesMod.load('zh', userDataDir())
if (!table || Object.keys(table).length === 0) {
  throw new Error('话术一个状态都没解析出来，检查 dialogues/zh.md')
}

// 片段名 → 状态名。演示页点的是**片段**，台词是按**状态**组织的。
const CLIP_TO_STATE = {
  working: 'working', needInput: 'needsInput', blocked: 'blocked', ready: 'ready',
  sleep: 'sleep', wave: 'wave', startle: 'startle',
  patHappy: 'pat', angry: 'patAngry',
  // 待机那一堆都属于 idle（`drowsy` 是入睡过程，也算 idle 的话术）
  idle: 'idle', awake: 'idle', blink: 'idle', slowBlink: 'idle',
  blinkTwice: 'idle', eat: 'idle', stretch: 'idle', drowsy: 'idle',
}
// 只带演示页用得上的字段（台词 + 升级档），把 note / fixed 这些丢掉
const slim = {}
for (const [state, v] of Object.entries(table)) {
  slim[state] = {
    lines: v.lines,
    escalate: (v.escalate ?? []).map((e) => ({
      afterMs: e.afterMs, repeat: Boolean(e.repeat), lines: e.lines,
    })),
  }
}

// ── ④ 形象切换 ──
//
// 一个 <select>，选中就改 query 重载。
// ⚠️ 用 `location.search` 而不是 hash —— `pet.js` 读的就是 `location.search`。
const current = new URLSearchParams(html.match(/ACTIVE_STYLE[^\n]*/)?.[0] ?? '').get('style')
void current
const switcher = `
  <div id="styleSwitch" style="margin:0 0 22px;display:flex;gap:10px;align-items:center;
       background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px">
    <span style="color:var(--dim);font-size:13px">形象</span>
    <select id="styleSelect" style="background:var(--bg);color:var(--text);border:1px solid var(--line);
       border-radius:7px;padding:5px 10px;font-size:13px;font-family:inherit;cursor:pointer">
      ${STYLES.map((s) => `<option value="${s.id}">${s.name}</option>`).join('')}
    </select>
    <span style="color:var(--dim);font-size:12px">换形象会重新加载这一页（图片和动画都跟着换）</span>
  </div>
  <script>
    (function () {
      var cur = new URLSearchParams(location.search).get('style') || ${JSON.stringify(DEFAULT_STYLE)};
      var sel = document.getElementById('styleSelect');
      sel.value = cur;
      if (!sel.value) sel.value = ${JSON.stringify(DEFAULT_STYLE)};
      sel.addEventListener('change', function () {
        location.search = '?style=' + encodeURIComponent(sel.value);
      });
    })();
  </script>
`

const styleScript = `<script>window.__DEMO_ASSETS = ${JSON.stringify(assets)};`
  + `window.__DEMO_CLIPS = ${JSON.stringify(clips)};`
  + `window.__DEMO_STYLES = ${JSON.stringify(STYLES.map((s) => ({ id: s.id, name: s.name })))};</script>`
  + `\n  <script>window.__DEMO_DIALOGUES = ${JSON.stringify(slim)};`
  + `window.__DEMO_CLIP_TO_STATE = ${JSON.stringify(CLIP_TO_STATE)};</script>`

// ── ⑤ 内联 ──
html = put(html, '<script src="../state-labels.js"></script>',
  `${styleScript}\n  <script>\n${labelsJs}\n  </script>`)
// ⚠️ **内联前必须检查有没有 script 标签。**
//
//    HTML 解析器在脚本块里遇到那个词就会**把脚本从中间截断** ——
//    产物里 pet.js 被劈成两半，控制台报两个没头没脑的
//    `SyntaxError: Invalid or unexpected token`，很难查。
//    实测就是 `pet.js` 里一句注释写了它。
// ⚠️ 顺带提醒：内联的源码里**含有 `$'`**（`.startsWith('$')`）——
//    这正是上面必须用 `put()` 而不能直接 `replace(needle, 源码)` 的原因。
//    下面这道检查只查 script 标签；`$` 转义由 `put()` 从机制上避免。
const scriptTagRe = /<\/?script/i
for (const [what, src] of [['pet.js', petJs], ['state-labels.js', labelsJs]]) {
  const m = scriptTagRe.exec(src)
  if (m) {
    const line = src.slice(0, m.index).split('\n').length
    console.error(`❌ ${what} 第 ${line} 行出现了脚本标签 —— 内联后会把脚本截断：`)
    console.error(`   ${src.slice(Math.max(0, m.index - 60), m.index + 40).split('\n').pop()}`)
    console.error('   改成「script 标签」这种不带尖括号的写法。')
    process.exit(1)
  }
}

html = put(html, '<script src="pet.js"></script>', `<script>\n${petJs}\n  </script>`)

// 顶部加一句"这是打包版" + 形象切换（插在 <h1> 之后）
html = put(html, '<h1>🐳 胖头鱼 · 逐帧动画预览</h1>',
  '<h1>🐳 胖头鱼 · 逐帧动画预览</h1>\n'
  + '  <p class="sub" style="opacity:.65;margin-bottom:14px">'
  + '这是<b>自包含的单文件版</b>（图片已内联，不依赖仓库目录）</p>'
  + switcher)

// ⚠️ **先剥掉 `<script>` 块再找外部引用。**
//    直接在整份 HTML 上搜会误报 —— 源码注释里就写着
//    `<script src="state-labels.js">`（讲这个文件怎么被加载的），
//    那不是真的引用。第一版就因为这个假警报直接退出了。
const outsideScripts = html.replace(/<script[\s\S]*?<\/script>/g, '')
const leftover = outsideScripts.match(/<script[^>]*src=|<link[^>]+href=/g)
if (leftover) {
  console.error('❌ 还有没内联的外部引用，产物会打不开:', leftover.slice(0, 3).join(' '))
  process.exit(1)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })   // 目录不存在就建（用户指定的正式位置）
fs.writeFileSync(OUT, html)

// 第二份（可选）：目录存在才写 —— 目录是用户建的，脚本不替他创建
const extras = []
for (const e of EXTRA_OUTS) {
  if (!fs.existsSync(path.dirname(e))) continue
  try {
    fs.writeFileSync(e, html)
    extras.push(e)
  } catch (err) {
    console.warn(`⚠️ 第二份写失败（${e}）: ${err.message}`)
  }
}

const kb = (n) => `${Math.round(n / 1024)} KB`
console.log(`✅ 打包完成: ${OUT}`)
if (extras.length) {
  for (const e of extras) console.log(`   ↳ 同时更新: ${e}`)
} else if (EXTRA_OUTS.length) {
  console.log('   ℹ️  没有第二份要更新（目录不存在就跳过）')
}
console.log(`   形象 ${STYLES.length} 个: ` +
  STYLES.map((s) => `${s.name}(${Object.keys(assets[s.id]).length} 张` +
    `${Object.keys(s.clips).length ? `、${Object.keys(s.clips).length} 段动画` : ''})`).join('  '))
console.log(`   内联 ${Object.keys(slim).length} 个状态的台词、${total === 0 ? 0 : Object.values(assets).reduce((a, x) => a + Object.keys(x).length, 0)} 张图` +
  `（原图 ${kb(total)} → base64 后约 ${kb(total / 3 * 4)}）`)
console.log(`   产物总大小 ${kb(Buffer.byteLength(html))}`)
console.log('   双击就能看，顶部的下拉可以换形象')
