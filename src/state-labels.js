/**
 * state-labels.js — 状态名 → 中文
 *
 * **唯一真源。** 三个地方要用同一份，之前各写各的：
 *   · 右键菜单（main.js 的 labelOf）
 *   · 预览页的帧读数（preview.html）
 *   · 日志（pet.js / bubble-controller.js）
 *
 * 分开写的后果实测过：菜单是中文，但**日志和预览页全是英文** ——
 * 用户看日志排查时得自己对照「sleep 是什么」，很别扭。
 *
 * ⚠️ **加新状态时要改这里，不要再往各处塞映射。**
 *
 * 这个文件要被两种环境加载：
 *   · 主进程 / 测试   → `require('./state-labels')`
 *   · 渲染进程        → 用 script 标签直接引入（普通脚本，不是 module）
 *
 * ⚠️ **注释里不要写带尖括号的 script 标签。**
 *    这个文件会被 tools/build-demo.mjs **整段内联**进演示页 ——
 *    HTML 解析器一看到那个词就会把脚本从中间截断。实测踩到过。
 * 所以下面用最小的双模式写法，不引任何依赖。
 */

;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) {
    // ⚠️ **别把整个 api 挂到 STATE_LABELS 上。**
    //    api 是 `{ STATE_LABELS, labelWithKey }`，而全局也叫 STATE_LABELS ——
    //    于是页面上得写 `STATE_LABELS.STATE_LABELS.working`，实际拿到的是
    //    `{STATE_LABELS, labelWithKey}` 这两个键，查 `working` 永远是 undefined。
    //    实测踩到：日志里状态名一直是英文，页面上却有表（2 个键）。
    root.STATE_LABELS = api.STATE_LABELS
    root.stateLabelOf = api.labelWithKey
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  /**
   * 状态名 → 中文。
   *
   * 键要和 `dialogues/*.md` 里的 `## 状态名` 一一对应 ——
   * 漏一个，界面上就会直接显示英文 key（用户看到 `patAngry` 完全不知道那是什么）。
   */
  const STATE_LABELS = {
    // ── 状态 ──
    idle: '空闲',
    working: '工作中',
    needsInput: '需要确认',
    ready: '任务完成',
    blocked: '出错',
    sleep: '睡着',

    // ── 时刻 ──
    wave: '打招呼',
    startle: '被吵醒',
    pat: '被摸头',
    patAngry: '被惹毛',
  }

  /** 状态名 → `工作中(working)` 这种「中文(英文)」写法，日志和读数用。 */
  function labelWithKey (state) {
    const zh = STATE_LABELS[state]
    return zh ? `${zh}(${state})` : String(state)
  }

  return { STATE_LABELS, labelWithKey }
})
