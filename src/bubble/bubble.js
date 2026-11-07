/**
 * bubble.js — 气泡窗口的渲染
 *
 * 职责很窄：收到要显示的文字就显示，到点就淡出。
 * 挑哪句话、什么时候升级、窗口摆哪儿，全在主进程决定。
 *
 * 这样切分的原因：气泡窗口是"哑"的，它不知道桌宠状态、也不知道话术文件。
 * 想改文案只需要动 dialogues/*.md，不必碰这里。
 */

'use strict'

const wrap = document.getElementById('wrap')
const textEl = document.getElementById('text')
const noteEl = document.getElementById('note')

let hideTimer = null

/**
 * 显示气泡。
 * @param {{ text: string, note?: string, durationMs: number, tone?: string }} payload
 */
function show ({ text, note = '', durationMs, tone = 'normal' }) {
  clearTimeout(hideTimer)

  noteEl.textContent = note
  textEl.textContent = text
  wrap.classList.remove('attention', 'error')
  if (tone === 'attention') wrap.classList.add('attention')
  if (tone === 'error') wrap.classList.add('error')

  // 先移除 show 再强制 reflow，保证连续两条气泡都能播入场动画
  wrap.classList.remove('show')
  void wrap.offsetWidth
  wrap.classList.add('show')

  // 量一下实际渲染宽度并打进日志。
  // 气泡塌缩成一字一行这类问题，光看代码看不出来，而没有这条日志就只能靠用户截图。
  requestAnimationFrame(() => {
    const r = document.getElementById('bubble').getBoundingClientRect()
    const w = Math.round(r.width)
    const h = Math.round(r.height)
    console.log(`[bubble] 渲染 ${w}x${h}${w < 40 ? '  ⚠️ 宽度异常（可能又塌缩了）' : ''}`)
  })

  // durationMs <= 0 表示"一直显示，直到下一条"
  if (durationMs > 0) {
    hideTimer = setTimeout(hide, durationMs)
  }
}

function hide () {
  clearTimeout(hideTimer)
  wrap.classList.remove('show')
}

// ── 接主进程 ──

window.bubbleBridge?.onShow(show)
window.bubbleBridge?.onHide(hide)

// 注意：这里**不**上报内容尺寸。
// 主进程曾用它来改窗口大小，结果形成正反馈把气泡压成一字一行。
// 气泡在窗口里底部对齐，定位只需要窗口尺寸，内容多大都无所谓。

window.bubble = { show, hide }
