/**
 * settings-preload.js — 设置弹窗与主进程之间的通道
 *
 * 只暴露三个动作。注意 `test` 和 `save` 都是 invoke（要等结果），
 * 因为界面要据此显示"测试中…"和测试结果。
 */

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('settings', {
  /** 读当前配置（含明文 key，供 type=password 输入框回显） */
  load: () => ipcRenderer.invoke('settings:load'),

  /** 测连通性，等结果 */
  test: (values) => ipcRenderer.invoke('settings:test', values),

  /** 保存并切到大模型 */
  save: (values) => ipcRenderer.invoke('settings:save', values),

  /** 把内容实际高度报给主进程，让它调整窗口大小 */
  resize: (height) => ipcRenderer.send('settings:resize', height),

  /** 关闭，不保存 */
  cancel: () => ipcRenderer.send('settings:cancel'),
})
