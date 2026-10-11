/**
 * preload — renderer 与主进程之间的唯一通道。
 * 开了 contextIsolation，所以 renderer 拿不到 Node，只能通过这里暴露的几个方法。
 */

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  /** 指针是否压在宠物身上（决定窗口是否接管鼠标） */
  setHovering: (hovering) => ipcRenderer.send('pet:hover', hovering),

  /** 拖动窗口：传本次移动的增量 */
  drag: (dx, dy) => ipcRenderer.send('pet:drag', { dx, dy }),

  /** 拖动结束 */
  dragEnd: () => ipcRenderer.send('pet:drag-end'),

  /**
   * 缩放：传一个**倍率**（1 = 基准）。
   *
   * ⚠️ 只传倍率、不传像素 —— 像素由主进程按基准尺寸算。
   *    渲染层不知道也不该知道窗口该多大（它连自己多宽都只能靠 clientWidth 问）。
   */
  resize: (scale) => ipcRenderer.send('pet:resize', { scale }),

  /** 缩放结束（主进程据此写盘） */
  resizeEnd: () => ipcRenderer.send('pet:resize-end'),

  /** 问当前倍率（启动时同步一次，用来算手柄该在哪） */
  getScale: () => ipcRenderer.invoke('pet:get-scale'),

  /** 问一句"是不是第一次启动"（用来决定要不要说引导台词） */
  isFirstRun: () => ipcRenderer.invoke('pet:is-first-run'),

  /** 告诉主进程"引导已经展示过了" —— 下次启动不再说 */
  markWelcomed: () => ipcRenderer.send('pet:welcomed'),

  /**
   * 用户点了她 = 「我看到了」→ 停止常驻气泡和升级催促。
   * ⚠️ 和 `hideExternal` 不是一回事：那个撤的是翻译气泡，这个撤的是状态气泡。
   */
  acknowledge: () => ipcRenderer.send('pet:acknowledge'),

  /**
   * 让气泡说一句话。
   * ⚠️ 气泡是**另一个窗口**，渲染层碰不到它的 DOM —— 所有台词都得走这里。
   */
  sayExternal: (payload) => ipcRenderer.send('pet:say', payload),

  /** 读窗口位置（调试用） */
  getBounds: () => ipcRenderer.invoke('pet:get-bounds'),

  /** 问一下 DSH 插件是否连着 */
  bridgeStatus: () => ipcRenderer.invoke('pet:bridge-status'),

  /**
   * 把当前状态回报给主进程（气泡据此挑话）。
   *
   * ⚠️ 用独立通道，不要复用 'pet:state' ——
   * 那个名字已经被"主进程 → 渲染层"占用了，同一个名字双向收发
   * 在 Electron 里能跑，但读代码的人分不清方向。
   */
  /**
   * 报状态。`opts.restart` 表示"**重新进入**这个状态"——
   * 气泡那边收到相同状态默认会直接 return（避免重复推送刷屏），
   * 但睡着 / 醒来这种事必须重置它的升级计时器，
   * 否则会出现「她早就被摸醒了，2 分钟后还在说梦话」。
   */
  reportState: (clip, opts) => ipcRenderer.send('pet:state-changed', clip, opts),

  /** 单击宠物 → 主进程弹余额气泡 */
  showBalance: () => ipcRenderer.send('pet:show-balance'),

  /** 余额 / 本轮花费的数据（由 DSH 插件推过来，主进程转发） */
  onInfo: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('pet:info', listener)
    return () => ipcRenderer.removeListener('pet:info', listener)
  },

  /** 右键宠物 → 让主进程弹出设置菜单 */
  showMenu: () => ipcRenderer.send('pet:menu'),

  /**
   * 报告一个「时刻」：打招呼、被吵醒。
   * 和 reportState 分开 —— 时刻不参与状态计时，也不该打断升级催促。
   */
  reportMoment: (kind) => ipcRenderer.send('pet:moment', kind),

  /** DSH 插件推来的状态变化（主进程 → 渲染层） */
  onState: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('pet:state', listener)
    return () => ipcRenderer.removeListener('pet:state', listener)
  },

  /** 这套宠物的多帧动画（主进程从 manifest 读出来 → 渲染层覆盖 CLIPS） */
  onClips: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('pet:clips', listener)
    return () => ipcRenderer.removeListener('pet:clips', listener)
  },

  /** 各帧的包围盒（摸头判头顶用） */
  onFrameBounds: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('pet:frame-bounds', listener)
    return () => ipcRenderer.removeListener('pet:frame-bounds', listener)
  },

  /** 在跑的会话数 → 头顶角标 */
  onSessions: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('pet:sessions', listener)
    return () => ipcRenderer.removeListener('pet:sessions', listener)
  },

  /** 余额分档 → 让她做个对应的表情 */
  onBalanceMood: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('pet:balance-mood', listener)
    return () => ipcRenderer.removeListener('pet:balance-mood', listener)
  },

  /** 音效开关变化 */
  onSound: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('pet:sound', listener)
    return () => ipcRenderer.removeListener('pet:sound', listener)
  },

  /** 桥接连接的建立/断开 */
  onBridge: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('pet:bridge', listener)
    return () => ipcRenderer.removeListener('pet:bridge', listener)
  },
})

// 演示模式：`npm run start -- --demo` 时自动轮播各状态，用于肉眼验收素材
contextBridge.exposeInMainWorld('petDemo', process.argv.includes('--demo'))
