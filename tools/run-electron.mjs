#!/usr/bin/env node
/**
 * run-electron.mjs — 用 Electron 跑一个脚本（跨平台）
 *
 * ── 为什么需要这个 ──
 *
 * `test-selftest.cjs` 里第一行是 `require('electron')` 拿 `app` / `BrowserWindow`。
 * 但 **`require('electron')` 在纯 Node 下返回的是「二进制路径字符串」，不是 API 对象** ——
 * 所以直接 `node test-selftest.cjs` 会崩：
 *
 *     TypeError: Cannot read properties of undefined (reading 'commandLine')
 *
 * ⚠️ **`package.json` 的 `test` 脚本原来就是这么写的**（`... && node test-selftest.cjs`），
 *    一直是坏的。没人发现是因为大家（包括我）都手动跑那 7 个 `.mjs` 单测，
 *    很少真的敲 `npm test`。**写完 CI 之后它才暴露** —— CI 会照着脚本跑。
 *
 * ── 为什么不能直接把路径写死 ──
 *
 * 三个平台的二进制位置都不一样：
 *     macOS    node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
 *     Windows  node_modules/electron/dist/electron.exe
 *     Linux    node_modules/electron/dist/electron
 *
 * 而 `require('electron')` **在纯 Node 下返回的正好就是这个路径** ——
 * 所以拿它当"跨平台找二进制"的办法最省事，也不用判断 `process.platform`。
 *
 * ── 用法 ──
 *
 *     node tools/run-electron.mjs test-selftest.cjs
 *     node tools/run-electron.mjs --no-sandbox test-selftest.cjs
 *
 * 退出码照搬子进程的 —— CI 靠它判断成败。
 */

'use strict'

import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 找到 Electron 二进制。找不到就返回 null（下面会给出可操作的提示） */
function electronBinary () {
  // ① 首选：`require('electron')` 在纯 Node 下返回二进制路径
  try {
    const p = require('electron')
    if (typeof p === 'string' && fs.existsSync(p)) return p
  } catch { /* 没装 electron */ }

  // ② 兜底：按平台猜常见位置（有些打包/裁剪过的 node_modules 走不通 ①）
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist')
  const candidates = process.platform === 'win32'
    ? ['electron.exe']
    : process.platform === 'darwin'
      ? ['Electron.app/Contents/MacOS/Electron']
      : ['electron']
  for (const rel of candidates) {
    const p = path.join(dist, rel)
    if (fs.existsSync(p)) return p
  }
  return null
}

const bin = electronBinary()
if (!bin) {
  console.error('❌ 找不到 Electron —— 先跑 `npm install`（或 pnpm install）')
  process.exit(2)
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('用法: node tools/run-electron.mjs [electron 参数...] <脚本>')
  process.exit(2)
}

// ⚠️ **必须清掉 `ELECTRON_RUN_AS_NODE`。**
//    这台开发机的 shell 环境里有它（值为 1）。
//    留着的话 Electron 会当成纯 Node 跑：**不起窗口、不报错、退出码 0**，
//    表现是"测试什么都没做就说通过了"。CI 上本来没有，显式清掉更保险。
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const r = spawnSync(bin, args, { stdio: 'inherit', env, cwd: ROOT })

// spawnSync 在信号终止时 status 是 null —— 转成非 0，别让 CI 以为成功
if (r.error) {
  console.error(`❌ 起不来: ${r.error.message}`)
  process.exit(2)
}
process.exit(r.status === null ? 3 : r.status)
