// 在 index.html 的脚本跑之前就把 window.pet 铺好（真 preload 时机）。
// 用 contextBridge 而不是直接在页面里赋值 —— 那样来不及，
// pet.js 会在 stub 生效前就调 window.pet.onState 并抛错。
const { contextBridge } = require('electron')
const noop = () => {}
const unsub = () => noop

// 记录 reportMoment —— 自检**不该**产生任何"时刻"。
// 踩过的 bug：selfTestPat 模拟蹭 8 下走到了 onReward，于是每次启动 app
// 都冒一颗爱心 + 说一句「嘿嘿～」（pat 时刻的台词）。用户抓到的。
const moments = []
contextBridge.exposeInMainWorld('__moments', {
  get: () => moments.slice(),
  clear: () => { moments.length = 0 },
})

contextBridge.exposeInMainWorld('pet', {
  bridgeStatus: async () => ({ connected: false }),
  drag: noop, dragEnd: noop,
  // 缩放相关的三个 API —— 少一个，pet.js 的启动自检就会报「IPC=❌」。
  // ⚠️ 这个 stub 是**手写**的：preload 里加了新方法就得同步补，
  //    不然自检会变红（实测踩过：加缩放功能时漏了这三个）。
  resize: noop, resizeEnd: noop,
  getScale: async () => 1,
  isFirstRun: async () => false,
  markWelcomed: noop,
  sayExternal: noop,
  acknowledge: noop,
  getBounds: async () => ({ x: 0, y: 0, width: 220, height: 240 }),
  reportMoment: (k) => moments.push({ t: Math.round(performance.now()), kind: k }),
  reportState: noop,
  setHovering: noop, showBalance: noop, showMenu: noop,
  onBalanceMood: unsub, onBridge: unsub, onFrameBounds: unsub,
  onInfo: unsub, onSessions: unsub, onSound: unsub, onState: unsub,
})
