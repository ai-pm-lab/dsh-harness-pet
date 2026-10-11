/**
 * bubble-preload.js — 气泡窗口的 preload
 *
 * 只暴露两个接收通道。气泡从不主动发消息（它不接受任何交互），
 * 所以这里没有 invoke/send，只有 on。
 */

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bubbleBridge', {
  onShow: (handler) => {
    ipcRenderer.on('bubble:show', (_event, payload) => handler(payload))
  },
  onHide: (handler) => {
    ipcRenderer.on('bubble:hide', () => handler())
  },
  // 刻意不提供"上报内容尺寸"的通道：
  // 主进程曾据此 resize 窗口，形成正反馈把气泡压成一字一行。
  // 气泡在窗口里底部对齐，定位只需要窗口尺寸。
})
