#!/usr/bin/env node
/**
 * preview.mjs — 把「月薪喵」的所有帧画成一张对比图
 *
 * 用法: node tools/miao/preview.mjs [输出路径]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { frameSvg, FRAMES } from './draw.mjs'

const OUT = process.argv[2] || '/tmp/miao-sheet.html'
const COLS = 7
const names = Object.keys(FRAMES)

const cells = names.map((n) => `
  <figure>
    <div class="box">${frameSvg(FRAMES[n])}</div>
    <figcaption>${n}</figcaption>
  </figure>`).join('')

fs.writeFileSync(OUT, `<!doctype html><meta charset="utf-8">
<style>
  body { background:#f4f5f7; font:13px/1.4 -apple-system,sans-serif; padding:20px; margin:0 }
  h1 { font-size:16px; margin:0 0 4px }
  p.sub { color:#667; margin:0 0 18px; font-size:12px }
  .grid { display:grid; grid-template-columns:repeat(${COLS},1fr); gap:14px }
  figure { margin:0; background:#fff; border-radius:10px; padding:10px; text-align:center;
           box-shadow:0 1px 3px rgba(0,0,0,.08) }
  .box svg { width:100%; height:auto; display:block }
  figcaption { margin-top:6px; color:#556; font-size:11px; font-family:ui-monospace,monospace }
</style>
<h1>月薪喵 · 程序化绘制（${names.length} 帧）</h1>
<p class="sub">全部由 <code>tools/miao/draw.mjs</code> 用 SVG 代码画出，零素材成本，100% 一致</p>
<div class="grid">${cells}</div>
`)
console.log(`✅ ${names.length} 帧 → ${OUT}`)
