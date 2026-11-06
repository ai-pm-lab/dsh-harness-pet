/**
 * sounds.js — 提示音
 *
 * **纯代码合成，不带音频文件。** 理由：
 *   - 不用管素材授权（我们整个项目都在意这个）
 *   - 不用管文件路径（打包后路径会变）
 *   - 想调音色就改数字，比重新导出音频快得多
 * 这个做法参考了 nzl153/dsh-pet-whale 的 sounds.ts（190 行，6 种音效）。
 *
 * ⚠️ 浏览器自动播放策略：AudioContext 在用户没交互过之前是 suspended 的。
 * 桌宠这个场景**正好能绕开** —— 声音是在收到 DSH 状态时才响的，
 * 那时用户早就在用电脑了。但首次仍可能被挂起，所以挂一个全局 pointerdown 解锁。
 */

'use strict'

/** 目前只做一种音，就是「需要确认」。见 README 的取舍说明。 */
const SOUNDS = {
  /**
   * 需要确认：两声快速上行。
   *
   * 为什么用上行而不是单音：上行听起来是"有事找你"，下行听起来是"结束了"。
   * 两个音而不是一个，是为了和系统通知音区分开 —— 单音太容易被忽略。
   */
  needInput: {
    notes: [
      { freq: 660, at: 0, dur: 0.09, type: 'sine', gain: 0.16 },
      { freq: 990, at: 0.10, dur: 0.14, type: 'sine', gain: 0.18 },
    ],
  },
}

let ctx = null
let master = null
let unlocked = false
let enabled = true

function acquire () {
  if (ctx) return ctx
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
    master = ctx.createGain()
    master.gain.value = 0.6
    master.connect(ctx.destination)
    return ctx
  } catch {
    return null
  }
}

/** 首次用户交互时解锁。挂一次就摘掉。 */
function armUnlock () {
  if (unlocked) return
  const unlock = () => {
    const c = acquire()
    if (c && c.state === 'suspended') c.resume().catch(() => {})
    unlocked = true
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
}

/**
 * 播一个音效。
 * @param {'needInput'} name
 */
function play (name) {
  if (!enabled) return
  const spec = SOUNDS[name]
  if (!spec) return

  const c = acquire()
  if (!c) return
  // 被自动播放策略挂着就先试着恢复，这一次可能听不到，但下次就好了
  if (c.state === 'suspended') c.resume().catch(() => {})

  const now = c.currentTime
  for (const note of spec.notes) {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = note.type
    osc.frequency.setValueAtTime(note.freq, now + note.at)

    // 快速淡入 + 指数淡出。
    // 直接用 gain=0 → 1 会有"咔"的爆音，所以起手给一个极小的值再爬。
    const t0 = now + note.at
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(note.gain, t0 + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.dur)

    osc.connect(gain)
    gain.connect(master)
    osc.start(t0)
    osc.stop(t0 + note.dur + 0.02)
  }
}

function setEnabled (next) {
  enabled = Boolean(next)
}

// 渲染层是普通 <script>（不是 ES module），所以挂到全局而不是 module.exports。
// CSP 里 script-src 'self' 允许同目录脚本。
window.petSounds = { play, setEnabled, armUnlock, SOUNDS }
