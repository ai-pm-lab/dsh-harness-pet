/**
 * settings.js — 设置弹窗的界面逻辑
 *
 * 只做三件事：回显、测试、保存。所有实际动作都通过 preload 交给主进程。
 *
 * 关键点：**apiKey 不做任何本地处理**。
 * 它就是个 type="password" 的输入框 —— 值真实存在（所以可编辑、可回显），
 * 但屏幕上只显示圆点。不额外做掩码字符串，因为那会把"真值"和"显示值"
 * 变成两个东西，编辑时必然出错。
 */

'use strict'

const $ = (id) => document.getElementById(id)

const baseUrlEl = $('baseUrl')
const apiKeyEl = $('apiKey')
const modelEl = $('model')
const statusEl = $('status')
const testBtn = $('test')
const saveBtn = $('save')
const cancelBtn = $('cancel')

let testing = false

function setStatus (text, kind = '') {
  statusEl.textContent = text
  statusEl.className = `status${kind ? ' ' + kind : ''}`
}

function currentValues () {
  return {
    baseUrl: baseUrlEl.value.trim(),
    apiKey: apiKeyEl.value.trim(),
    model: modelEl.value.trim(),
  }
}

// ── 回显 ──

async function init () {
  const config = await window.settings.load()
  baseUrlEl.value = config.llm.baseUrl
  // 直接赋真值。type="password" 负责把它显示成圆点。
  apiKeyEl.value = config.llm.apiKey
  modelEl.value = config.llm.model

  if (!config.llm.apiKey) {
    setStatus('还没有填写 API Key')
  } else {
    setStatus('已保存，可测试或直接修改')
  }
}

// ── 测试 ──

async function runTest () {
  if (testing) return

  const values = currentValues()
  if (!values.baseUrl) return setStatus('请先填写 API 地址', 'fail')
  if (!values.apiKey) return setStatus('请先填写 API Key', 'fail')
  if (!values.model) return setStatus('请先填写模型名', 'fail')

  testing = true
  testBtn.disabled = true
  saveBtn.disabled = true
  setStatus('测试中…')

  try {
    const result = await window.settings.test(values)
    if (result.ok) {
      setStatus(`连通正常（${result.ms} ms）`, 'ok')
    } else {
      // 把具体原因带上 —— 只说"失败"用户没法排查（401？地址错？模型名错？）
      const detail = result.error ? `：${result.error}` : ''
      setStatus(`测试失败，请检查网络或API${detail}`, 'fail')
    }
  } catch (error) {
    setStatus(`测试失败，请检查网络或API：${error.message}`, 'fail')
  } finally {
    testing = false
    testBtn.disabled = false
    saveBtn.disabled = false
  }
}

// ── 保存 ──

async function save () {
  const values = currentValues()
  if (!values.baseUrl) return setStatus('请先填写 API 地址', 'fail')
  if (!values.apiKey) return setStatus('请先填写 API Key', 'fail')
  if (!values.model) return setStatus('请先填写模型名', 'fail')

  saveBtn.disabled = true
  // 保存后主进程会把翻译切到大模型并关掉这个窗口
  await window.settings.save(values)
}

// ── 事件 ──

testBtn.addEventListener('click', runTest)
saveBtn.addEventListener('click', save)
cancelBtn.addEventListener('click', () => window.settings.cancel())

// 回车 = 保存；Esc = 取消。对话框该有的键盘行为。
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !testing) save()
  if (event.key === 'Escape') window.settings.cancel()
})

// 改动任一字段就清掉上一次的测试结果 ——
// 否则会出现"显示连通正常，但测的是改之前的配置"这种误导。
for (const el of [baseUrlEl, apiKeyEl, modelEl]) {
  el.addEventListener('input', () => {
    if (!testing) setStatus('')
  })
}

/**
 * 把内容实际高度报给主进程，让它调整窗口。
 *
 * 为什么要自动量：窗口高度写死的话，改一次界面文案就可能把底部按钮挤出可视区
 * （踩过：348 的窗口减掉标题栏只剩 320，而内容需要 350，保存/取消被切掉一半）。
 * 自动量之后，以后加字段、改文案都不会再出这个问题。
 */
function reportHeight () {
  // 用 body 的滚动高度，它包含 padding
  const height = Math.ceil(document.body.scrollHeight)
  window.settings.resize(height)
}

init().then(() => {
  reportHeight()
  // 字体加载完高度可能还会变一点点，再量一次
  document.fonts?.ready?.then(reportHeight)
})
