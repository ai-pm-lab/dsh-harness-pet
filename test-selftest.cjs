// 在真实的 index.html 里跑 pet.js 的启动自检，把结果打出来。
//
// ⚠️ 为什么不能用 preview.html 代替：
//    预览页的 DOM 和真实窗口不一样（没有 #badge，#pet 定位也不同），
//    在那里跑会报一堆假失败 —— 我一开始就被骗过一次，以为摸头坏了。
//    要验行为，必须用真实的 index.html。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const ROOT = __dirname
app.commandLine.appendSwitch('no-sandbox')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 300, height: 340, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'test-selftest-stub.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  })
  const logs = []
  win.webContents.on('console-message', (_e, _lvl, msg) => logs.push(msg))
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'))
  await new Promise(r => setTimeout(r, 5300))   // 等四个自检跑完 + debounce 观察窗
  const found = logs.filter(l => l.includes('[pet]') && l.includes('自检'))
  found.forEach(l => console.log('  ' + l.replace('[pet] ', '')))
  // 自检**不能有用户可见的副作用**。
  // 踩过的 bug：selfTestPat 模拟蹭 8 下 → 走到 onReward → 冒爱心 + 说「嘿嘿～」，
  // 每次启动 app 都来一次。用户抓到的。
  const moments = await win.webContents.executeJavaScript('window.__moments.get()')
  const badMoments = moments.filter((m) => m.kind === 'pat' || m.kind === 'patAngry')
  console.log(`  自检期间报出的"时刻": ${badMoments.length} 个`
    + `  ${badMoments.length === 0 ? '✅ 没有副作用' : '❌ ' + JSON.stringify(badMoments)}`)

  const heart = await win.webContents.executeJavaScript(`
    (() => { const h = document.getElementById('heart')
      return { probe: h.classList.contains('probe'), show: h.classList.contains('show') } })()`)
  console.log(`  自检后爱心残留: probe=${heart.probe} show=${heart.show}`
    + `  ${!heart.probe && !heart.show ? '✅ 撤干净了' : '❌ 没撤干净'}`)

  const bad = found.filter(l => l.includes('❌'))
  const errs = logs.filter(l => l.includes('Uncaught') || l.includes('TypeError'))
  if (!found.length) {
    console.log('  ❌ 一条自检都没跑出来')
    logs.slice(0, 10).forEach(l => console.log('    ' + l.slice(0, 140)))
  } else if (bad.length) {
    console.log(`\n  ❌ ${bad.length} 条自检报红`)
  } else {
    console.log(`\n  ✅ ${found.length} 条自检全部通过`)
  }
  if (errs.length) {
    console.log('  ⚠️ 页面异常:')
    errs.slice(0, 4).forEach(l => console.log('    ' + l.slice(0, 140)))
  }
  process.exit(bad.length || errs.length || !found.length || badMoments.length
    || heart.probe || heart.show ? 1 : 0)
})
