/**
 * bridge — App 侧的本地 WebSocket 服务
 *
 * 职责：让 DSH 里的插件把「agent 现在在干什么」推给桌宠。
 *
 * 设计要点：
 *   - 只监听 127.0.0.1，不对外暴露
 *   - 随机端口 + 一次性 token，token 写在 bridge.json 里由插件读取
 *     （本机其他程序可能扫端口，加 token 防止乱推状态）
 *   - 插件是客户端、App 是服务端：App 通常先启动，插件后加载
 *
 * 协议（JSON 文本帧）：
 *   插件 → App   {"type":"hello","token":"...","version":1}   必须最先发
 *   App → 插件   {"type":"welcome","ok":true}
 *   插件 → App   {"type":"state","state":"working","detail":{...}}
 *   插件 → App   {"type":"ping"}   /   App → 插件  {"type":"pong"}
 */

'use strict'

const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { WebSocketServer } = require('ws')

const PROTOCOL_VERSION = 1

/** 当前连接（正常只会有一个 DSH 在推） */
let socket = null
let server = null
let info = null

/**
 * 启动桥接服务。
 *
 * @param {object} opts
 * @param {string} opts.stateDir  写 bridge.json 的目录
 * @param {(payload: object) => void} opts.onState  收到状态时的回调
 * @param {(connected: boolean) => void} opts.onConnectionChange
 * @returns {Promise<{port:number, token:string}>}
 */
function start ({ stateDir, onState, onInfo, onConnectionChange }) {
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(24).toString('hex')

    server = http.createServer((req, res) => {
      // 只用作 WebSocket 的载体，普通 HTTP 请求一律拒绝
      res.writeHead(426, { 'content-type': 'text/plain' })
      res.end('WebSocket only\n')
    })

    const wss = new WebSocketServer({ server, path: '/pet' })

    wss.on('connection', (ws, req) => {
      let authed = false

      // 超时未认证就断开，避免半开连接堆积
      const authTimer = setTimeout(() => {
        if (!authed) ws.close(4001, 'auth timeout')
      }, 5000)

      ws.on('message', (raw) => {
        let msg
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }

        if (!authed) {
          const ok = msg.type === 'hello'
            && msg.token === token
            && msg.version === PROTOCOL_VERSION
          if (!ok) {
            ws.close(4003, 'bad token or version')
            return
          }
          authed = true
          clearTimeout(authTimer)
          // 同一时刻只保留最新的一条连接
          if (socket && socket !== ws && socket.readyState === socket.OPEN) {
            socket.close(4000, 'replaced')
          }
          socket = ws
          ws.send(JSON.stringify({ type: 'welcome', ok: true }))
          onConnectionChange?.(true)
          return
        }

        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
          return
        }
        if (msg.type === 'state') {
          // 记下每一次状态变化。
          // 没有这条日志时，"她怎么没反应" 完全无从查起 ——
          // 分不清是插件没发、桥接没收到、还是渲染层没演。
          console.log(
            `[bridge] 状态 ← ${msg.state}` +
            (msg.detail?.reason ? `  (${msg.detail.reason})` : ''),
          )
          onState?.(msg)
        }

        // 余额 / 本轮花费。插件那边拉好算好才推过来 ——
        // **API Key 全程留在 DSH 进程里，不进这个通道。**
        if (msg.type === 'info') {
          console.log(`[bridge] 信息 ← ${msg.kind}`)
          onInfo?.(msg)
        }
      })

      ws.on('close', () => {
        clearTimeout(authTimer)
        if (socket === ws) {
          socket = null
          onConnectionChange?.(false)
        }
      })

      ws.on('error', () => { /* close 会跟着来，这里不重复处理 */ })
    })

    server.on('error', reject)

    // 端口 0 = 让系统分配一个空闲端口
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      info = { port, token, pid: process.pid, protocol: PROTOCOL_VERSION }

      // 写 bridge.json 供插件发现。失败不致命（插件支持手动配置端口）。
      try {
        fs.mkdirSync(stateDir, { recursive: true })
        fs.writeFileSync(
          path.join(stateDir, 'bridge.json'),
          JSON.stringify(info, null, 2),
          { mode: 0o600 },
        )
      } catch (error) {
        console.warn('[bridge] 写 bridge.json 失败:', error.message)
      }

      // 开发用副本：正常运行时 userData 在 ~/Library 下，沙盒化的工具读不到。
      // 设了 PET_BRIDGE_DEV_COPY 就额外写一份到项目目录，方便本地调试
      // （用脚本扮演插件去驱动桌宠）。生产启动不会设这个变量。
      const devCopy = process.env.PET_BRIDGE_DEV_COPY
      if (devCopy) {
        try {
          fs.mkdirSync(path.dirname(devCopy), { recursive: true })
          fs.writeFileSync(devCopy, JSON.stringify(info, null, 2), { mode: 0o600 })
          console.log(`[bridge] 开发副本: ${devCopy}`)
        } catch (error) {
          console.warn('[bridge] 写开发副本失败:', error.message)
        }
      }

      console.log(`[bridge] 监听 127.0.0.1:${port}`)
      resolve(info)
    })
  })
}

function stop () {
  try {
    socket?.close()
    server?.close()
  } catch { /* 退出路径，忽略 */ }
}

/**
 * 主动给插件发一条消息。
 *
 * 桥接一直是单向的（插件推、App 收），但 WebSocket 本来就是双向的 ——
 * 加这一条是为了让"用户点了她"能立刻拿到最新余额，
 * 而不是干等下一次定时推送（刚重启那段空窗期里点她只能看到"还没拿到"）。
 *
 * @returns {boolean} 是否发出去了。没连接时返回 false，调用方据此降级。
 */
function request (payload) {
  if (!socket || socket.readyState !== socket.OPEN) return false
  try {
    socket.send(JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

/** 当前是否有插件连着 */
function isConnected () {
  return Boolean(socket && socket.readyState === socket.OPEN)
}

module.exports = { start, stop, request, isConnected, PROTOCOL_VERSION }
