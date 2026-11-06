/**
 * draw.mjs — 「月薪喵」的程序化绘制
 *
 * 为什么给这套宠物写代码画、而不是 AI 生成：
 * 形象**极简** —— 大耳朵 + 圆头 + 小身体 + 蓝眼睛 + ω 嘴 + 条纹尾巴，
 * 全是纯色、没有渐变没有阴影。这种图形**代码画比 AI 准**：
 *   · 100% 一致（26 帧不会"越画越走样"）
 *   · 零成本，改颜色/粗细几秒钟
 *   · 能做出 AI 做不到的**真变形**（身体拉长、耳朵翻转、整体缩放）
 *
 * ── 结构（按参考图逐行量出来的比例）──
 *
 *        ╱▔▔╲          ← 头顶有个小呆毛凹口
 *      ╱        ╲
 *     │   ●  ●   │       ← 蓝色竖椭圆眼，**靠中间**（不是靠两侧）
 *     │    ω     │       ← ω 嘴在两眼之间偏下
 *    ▟▛          ▜▙      ← 耳朵：**两块巨大的米棕区域**，从头顶两侧垂到中部
 *     │          │
 *     │   身体    │       ← 身体比头窄，在下方
 *     ╲__________╱
 *    ▁▁                   ← 尾巴在左下，粗、带条纹、向上弯
 *
 * ⚠️ 第一版把耳朵画成"两个小三角"、头身连成一个铃铛 —— **整个理解错了**。
 *    放大参考图量逐行宽度才发现：最宽处在 y=35%（那是**耳朵**），
 *    而 y=5% 就已经有 351px 宽（也是耳朵）。耳朵才是这个形象的主体。
 *
 * 坐标系统一用 **viewBox 0 0 100 100**，最后缩放到 512×512 导出。
 */

// ── 配色（从参考图取样）──
export const COLOR = {
  line: '#5a3a20',      // 深棕描边
  fur: '#ffffff',       // 白色头身
  ear: '#cbb094',       // 米棕（耳朵、尾巴）
  eye: '#37509c',       // 蓝色眼睛
  mouth: '#7a4526',     // 嘴巴
  extra: '#e8b84b',     // 问号
}

/** 描边粗细（相对 100 的坐标系）—— 参考图里线条很粗，是风格的一部分。 */
const LW = 3.0

/**
 * 耳朵：**一大块**，不是小三角。
 *
 * 从头顶靠中间的位置起笔，向外下方展开，尖端在左上/右上，
 * 内缘贴着头的侧面往下垂到中部。
 */
function earPath (side) {
  const m = (x) => (side === 'left' ? x : 100 - x)   // 镜像
  // 参考图里是**一个尖三角**：尖端朝上外、基部贴着头、外缘带一点弧度。
  // ⚠️ 前两版都画错了：第一版是"小三角"（太小，被头挡住），
  //    第二版是"大窗帘"（太大太方，底部没收尖）。放大参考图量了才定下来。
  return [
    `M ${m(45)} 20`,          // 基部上（贴着头顶）
    `Q ${m(30)} 12 ${m(17)} 8`,
    `Q ${m(9)} 6 ${m(8)} 14`, // 尖端（圆角）
    `Q ${m(7)} 22 ${m(12)} 32`,
    `Q ${m(18)} 45 ${m(24)} 53`,  // 外缘斜向下收
    `Q ${m(28)} 58 ${m(32)} 54`,
    `Z`,                      // 直着回到基部
  ].join(' ')
}

/**
 * 头 + 身体：一个连着的白色形状。
 *
 * 头是**大圆**（占上面约 60%），中间略收，身体在下方、比头窄一点。
 * 顶上有个小凹口（呆毛）。
 */
function bodyPath () {
  return [
    'M 50 6',                  // 呆毛尖端
    'Q 52 12 56 13',
    'C 66 14 73 24 73 36',     // 头的右半边（**收窄**：到 x=73 为止）
    'C 73 46 69 53 65 57',     // 收到脖子
    'C 70 61 72 68 72 77',     // 身体右侧（比头略窄）
    'C 72 88 66 94 57 94',     // 右下圆角
    'L 43 94',                 // 底边
    'C 34 94 28 88 28 77',     // 左下圆角
    'C 28 68 30 61 35 57',     // 身体左侧
    'C 31 53 27 46 27 36',     // 脖子的左边
    'C 27 24 34 14 44 13',     // 头的左半边
    'Q 48 12 50 6',            // 回到呆毛
    'Z',
  ].join(' ')
}

/**
 * 尾巴：粗、带条纹、从身体左下伸出去往左上弯。
 * 参考图里它挺大，不能被身体挡住太多。
 */
const TAIL_D = 'M 29 82 C 17 85 7 90 4 95 C 1 100 8 101 15 98 C 22 95 26 90 30 85'

/**
 * 眼睛。参考图里是**两个竖着的蓝色椭圆**，没有高光没有瞳孔。
 * `open` 0=闭 1=正常 >1=睁大（受惊/需要确认时用）
 */
function eyes (open = 1, dy = 0) {
  const cy = 36 + dy
  if (open <= 0.05) {
    return `
      <path d="M 29 ${cy} Q 36 ${cy + 5} 43 ${cy}" fill="none"
        stroke="${COLOR.line}" stroke-width="${LW}" stroke-linecap="round"/>
      <path d="M 57 ${cy} Q 64 ${cy + 5} 71 ${cy}" fill="none"
        stroke="${COLOR.line}" stroke-width="${LW}" stroke-linecap="round"/>`
  }
  const rx = 5.0 * (open > 1 ? 1.12 : 1)
  const ry = 9.5 * open
  return `
    <ellipse cx="36" cy="${cy}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="${COLOR.eye}"/>
    <ellipse cx="64" cy="${cy}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="${COLOR.eye}"/>`
}

/** 嘴：ω。`open` 改成小圆、`flat` 改成一条横线。 */
function mouth (shape = 'omega', dy = 0) {
  const cy = 51 + dy
  if (shape === 'open') {
    return `<ellipse cx="50" cy="${cy}" rx="5" ry="4" fill="${COLOR.mouth}"/>`
  }
  if (shape === 'flat') {
    return `<path d="M 45 ${cy} L 55 ${cy}" stroke="${COLOR.line}"
      stroke-width="${LW * 0.8}" stroke-linecap="round"/>`
  }
  return `<path d="M 45 ${cy - 1} Q 47.5 ${cy + 3} 50 ${cy - 1} Q 52.5 ${cy + 3} 55 ${cy - 1}"
    fill="none" stroke="${COLOR.mouth}" stroke-width="${LW * 0.8}" stroke-linecap="round"/>`
}

/** 头顶的问号（需要确认用）。 */
function questionMark () {
  return `<g transform="translate(50 2)">
    <path d="M -5 -8 Q -5 -14 0 -14 Q 5 -14 5 -8 Q 5 -4 0 -2 L 0 1"
      fill="none" stroke="${COLOR.extra}" stroke-width="3.2" stroke-linecap="round"/>
    <circle cx="0" cy="5" r="1.8" fill="${COLOR.extra}"/>
  </g>`
}

/** 睡觉的 z 字。 */
function zzz (scale = 1) {
  return `<g transform="translate(84 16) scale(${scale})" fill="${COLOR.line}" opacity="0.5"
    font-family="sans-serif" font-weight="600">
    <text x="0" y="0" font-size="11">z</text>
    <text x="7" y="-8" font-size="8">z</text>
    <text x="12" y="-14" font-size="6">z</text>
  </g>`
}

/**
 * 画一帧。
 *
 * @param {object} o
 * @param {number} [o.eyeOpen=1]    眼睛张开程度（0=闭）
 * @param {string} [o.mouthShape]   'omega' | 'open' | 'flat'
 * @param {number} [o.squash=1]     纵向缩放（<1 压扁、>1 拉长）
 * @param {number} [o.dy=0]         整体上下位移
 * @param {number} [o.earTilt=0]    耳朵张合角度（正=向外张、负=耷拉）
 * @param {boolean} [o.question]    头顶问号
 * @param {boolean} [o.zzz]         睡觉的 z
 */
export function frameSvg (o = {}) {
  const {
    eyeOpen = 1, mouthShape = 'omega', squash = 1, dy = 0,
    earTilt = 0, question = false, zzz: showZ = false,
  } = o

  // 以**脚底**为锚点缩放：压扁时脚不动、头往下，符合直觉
  const baseY = 95
  const t = `translate(0 ${(baseY * (1 - squash) + dy).toFixed(2)}) scale(1 ${squash.toFixed(3)})`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512">
  <g transform="${t}">
    <!-- 尾巴在最后面 -->
    <path d="${TAIL_D}" fill="none" stroke="${COLOR.line}"
      stroke-width="${LW * 2.7}" stroke-linecap="round"/>
    <path d="${TAIL_D}" fill="none" stroke="${COLOR.ear}"
      stroke-width="${LW * 1.55}" stroke-linecap="round" stroke-dasharray="4.5 4.5"/>

    <!-- 耳朵：两**大块**，在头后面 -->
    <g transform="rotate(${(-earTilt).toFixed(1)} 43 30)">
      <path d="${earPath('left')}" fill="${COLOR.ear}" stroke="${COLOR.line}"
        stroke-width="${LW}" stroke-linejoin="round"/>
    </g>
    <g transform="rotate(${earTilt.toFixed(1)} 57 30)">
      <path d="${earPath('right')}" fill="${COLOR.ear}" stroke="${COLOR.line}"
        stroke-width="${LW}" stroke-linejoin="round"/>
    </g>

    <!-- 头 + 身体 -->
    <path d="${bodyPath()}" fill="${COLOR.fur}" stroke="${COLOR.line}"
      stroke-width="${LW}" stroke-linejoin="round"/>

    ${eyes(eyeOpen)}
    ${mouth(mouthShape)}
  </g>
  ${question ? questionMark() : ''}
  ${showZ ? zzz() : ''}
</svg>`
}

/**
 * 帧名 → 参数。
 *
 * ⚠️ 这套宠物**没有四肢**，所以鲸鱼娘那套里依赖手的动作要重新设计：
 *    挥手 → 耳朵左右张合 · 敲键盘 → 身体上下弹 ·
 *    举手要确认 → 头顶问号 · 挡头 → 缩成一团 · 捧鱼干 → 张嘴
 */
export const FRAMES = {
  awake: {},
  blink: { eyeOpen: 0 },
  slowBlink: { eyeOpen: 0.25 },
  blinkTwice: { eyeOpen: 0.1 },

  // 吃东西：没手，改成张嘴 + 微微一缩
  eat: { mouthShape: 'open', squash: 0.985 },
  // 伸懒腰：没手，改成身体**拉长**
  stretch: { squash: 1.09, eyeOpen: 0.2, mouthShape: 'flat' },

  drowsy: { eyeOpen: 0.45, dy: 1 },
  sleep: { eyeOpen: 0, squash: 0.95, zzz: true, dy: 2 },
  startle: { eyeOpen: 1.35, squash: 1.05, earTilt: 10, dy: -2 },

  // 挥手 → 耳朵左右张合（没手）
  wave1: { earTilt: 12, eyeOpen: 0.8 },
  wave2: { earTilt: -12, eyeOpen: 0.8 },

  // 摸头 → 眯眼 + 耳朵耷拉
  patHappy: { eyeOpen: 0.1, earTilt: -16, squash: 0.97 },
  // 生气 → 竖耳 + 平嘴
  angry: { eyeOpen: 0.85, mouthShape: 'flat', earTilt: 6 },
  // 挡头 → 没手，改成**缩成一团 + 闭眼**
  angryBlock: { eyeOpen: 0, mouthShape: 'flat', squash: 0.88, earTilt: -22 },

  // 敲键盘：没手，改成身体上下弹
  work0: { eyeOpen: 1, squash: 1.0 },
  work1: { eyeOpen: 1, squash: 0.985 },

  // 需要确认：没手 → 头顶问号 + 眼睛睁大
  needInput: { eyeOpen: 1.25, question: true },

  // 出错：垂耳 + 半闭眼 + 平嘴
  blocked: { eyeOpen: 0.55, mouthShape: 'flat', earTilt: -18, dy: 1 },

  // 跳跃
  ready0: { squash: 1.02 },
  ready1: { squash: 0.93, earTilt: 6 },
  ready2: { squash: 1.09, earTilt: -4 },
  ready3: { squash: 0.96 },
  ready4: { squash: 1.02 },
}
