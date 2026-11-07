/**
 * pat.js — 摸头
 *
 * 参考 nzl153/dsh-pet-whale 的做法，但改了两处：
 *
 *   ① **头顶区域用 manifest 的实际包围盒**，不是固定比例。
 *      那家用 `fx ∈ [0.05, 0.6]` 硬编码 —— 因为它的鲸鱼总是侧身。
 *      我们的角色有坐姿、站姿、跳跃、举双手，**头顶位置逐帧都不同**，
 *      固定比例会判歪（她蹲下时你会"摸到空气"）。
 *
 *   ② **按窗口实际位置算**，不按图片比例。我们的窗口是 220×240，
 *      图片只占 220 高且底部对齐，上方有 20px 空白。
 *
 * 关键设计（都是那家调出来的数字，直接沿用）：
 *   - 判定"来回蹭"要**方向反转 + 位移够**，不是简单数 mousemove
 *   - 第二下才响应，免得鼠标只是路过头顶
 *   - 乱蹭（短时间内太多下）会生气 —— 有脾气才像活的
 */

'use strict'

;(function () {
  /** 两次掉头之间至少要走这么远，手抖不算 */
  const MIN_TRAVEL = 8
  /** 停手这么久就算摸完了 */
  const IDLE_MS = 650
  /** 每蹭这么多下冒一颗爱心 */
  // 原来是 5 —— 太稀疏了，用户蹭半天看不到反馈。改成 2。
  const HEART_EVERY = 2
  /**
   * 这么多下蹭在 TOO_FAST_MS 以内就是乱蹭：生气。
   *
   * 阈值定在"人做得到、但需要刻意快"：
   *   8 下 / 1000ms ≈ 每秒 8 次来回 —— 使劲搓能到，慢慢摸到不了。
   *
   * ⚠️ 别调太高。曾经改成 14 下 / 800ms（每秒 17 次），
   * **鼠标根本做不到**，等于把这个功能删了。
   * 真正要修的是"触发之后的冷却"（见 GRUMPY_MS），不是门槛。
   */
  const TOO_FAST_STROKES = 8
  const TOO_FAST_MS = 1000
  /** 生气后这段时间里再蹭也不理。5 秒太长了，2.5 秒够表达脾气又不烦人。 */
  const GRUMPY_MS = 2500

  function create (deps) {
    const { el, headBounds, onStroke, onReward, onTooFast } = deps

    let strokes = 0
    let strokeTimes = []
    let lastY = null
    let dir = 0
    let endTimer = 0
    let blockedUntil = 0
    let active = false

    function reset () {
      clearTimeout(endTimer)
      endTimer = 0
      strokes = 0
      strokeTimes = []
      lastY = null
      dir = 0
      if (active) {
        active = false
        el.classList.remove('patting')
        el.classList.remove('pat-press')
      }
    }

    /** 把屏幕坐标换算成相对图片的 0~1，再和当前帧的头顶框比 */
    function inHeadZone (clientX, clientY) {
      const box = headBounds?.()
      if (!box) return false
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return false
      const fx = (clientX - rect.left) / rect.width
      const fy = (clientY - rect.top) / rect.height
      return fx >= box.left && fx <= box.right && fy >= box.top && fy <= box.bottom
    }

    /** 每下把头顶按下去。重加 class + 强制 reflow 才会重播动画。 */
    function press () {
      el.classList.remove('pat-press')
      void el.offsetWidth
      el.classList.add('pat-press')
    }

    function onOneStroke () {
      const now = performance.now()

      // 滑动窗口判乱蹭：只留最近 TOO_FAST_STROKES 个时间戳，
      // 看它们是否挤在 TOO_FAST_MS 之内
      strokeTimes.push(now)
      if (strokeTimes.length > TOO_FAST_STROKES) strokeTimes.shift()
      if (strokeTimes.length === TOO_FAST_STROKES
          && now - strokeTimes[0] < TOO_FAST_MS) {
        console.log('[pet] 摸太快了，她会生气 5 秒（这期间怎么蹭都没反应）')
        reset()
        blockedUntil = now + GRUMPY_MS
        onTooFast?.(GRUMPY_MS)
        return
      }

      strokes += 1
      // 第二下才开始响应 —— 鼠标只是从头顶经过也会触发一次"掉头"
      if (strokes >= 2 && !active) {
        active = true
        el.classList.add('patting')
      }
      if (active) {
        press()
        onStroke?.(strokes)
        if (strokes % HEART_EVERY === 0) onReward?.(strokes)
      }

      clearTimeout(endTimer)
      endTimer = setTimeout(() => {
        const total = strokes
        reset()
        if (total >= 2) onReward?.(total)
      }, IDLE_MS)
    }

    /**
     * 鼠标移动。**只负责判"是不是一次掉头"**，不直接数移动次数。
     * @returns {boolean} 是否压在头顶区域（调用方据此决定要不要变光标）
     */
    function onMove (clientX, clientY) {
      if (performance.now() < blockedUntil) return false
      if (!inHeadZone(clientX, clientY)) {
        // 离开头顶就当作这一轮结束，免得在别处晃动被算成蹭
        lastY = null
        dir = 0
        return false
      }

      if (lastY !== null) {
        const dy = clientY - lastY
        if (Math.abs(dy) >= MIN_TRAVEL) {
          const nextDir = Math.sign(dy)
          if (dir !== 0 && nextDir !== dir) onOneStroke()
          dir = nextDir
          lastY = clientY
        }
      } else {
        lastY = clientY
      }
      return true
    }

    /**
     * 光标离开了头顶区域。
     *
     * ⚠️ **这里绝对不能用 reset() 清零。**
     *
     * 头顶区域里有零星的透明像素（头发缝隙、呆毛四周、脸和头发之间），
     * 鼠标划过时 `onHead` 会闪一下 false。每闪一次就清零的话，
     * **永远攒不到第二下** —— 表现就是"蹭了半天没反应"。
     * （这个 bug 靠合成事件才测出来：直接调 onMove 是测不到的，
     *   因为直接调绕过了 isOpaqueAt 那层命中测试。）
     *
     * 正确的收尾交给 IDLE_MS 的定时器：**手停下来 650ms 才算摸完**。
     * 这里只丢掉方向状态，让下一次进入头顶时重新起算"掉头"。
     */
    function leave () {
      lastY = null
      dir = 0
    }

    return {
      onMove,
      leave,
      reset,
      isGrumpy: () => performance.now() < blockedUntil,
      isPatting: () => active,
      getStrokes: () => strokes,
    }
  }

  window.petPat = { create }
})()
