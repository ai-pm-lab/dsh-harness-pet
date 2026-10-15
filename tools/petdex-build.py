#!/usr/bin/env python3
"""
petdex-build.py — 用 Petdex 原图**装配**出一套桌宠素材

**为什么要走这条路**（用户定的方向）：
    AI 逐张生成会**风格漂移** —— 每张都要重新用文字描述角色长什么样，
    而文字永远不如**原图本身**准。结果就是"都不怎么行"。
    Petdex #2981 那套有 **57 张现成的帧**，覆盖站立/闭眼/眯眼/躺下/手张开/缩成一团……
    **直接拿来用，形象 100% 一致。**

**流程**：
    ① `petdex-extract.py` 把 sprite sheet 拆成 57 张 512×512
    ② 本脚本按 `petdex-map.json` 把状态映射到帧
    ③ 少数几个状态需要**改造部件**（加问号 / 改嘴），在这里做
    ④ 输出到 `assets/<style>/`

用法：
    python3 tools/petdex-build.py --style yuexin-miao
    python3 tools/petdex-build.py --style yuexin-miao --dry
"""
import json
import shutil
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
    import numpy as np
except ImportError:
    print("需要 Pillow 和 numpy")
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent


# ── 部件改造 ───────────────────────────────────────────────────────────────

def find_part(im: Image.Image, pred) -> tuple:
    """按颜色找一块区域，返回它的包围盒。pred(r,g,b) -> bool"""
    a = np.array(im.convert("RGB")).astype(int)
    mask = pred(a[:, :, 0], a[:, :, 1], a[:, :, 2]) & (np.array(im)[:, :, 3] > 200)
    ys, xs = np.where(mask)
    if len(ys) == 0:
        return None, 0
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1), int(mask.sum())


def is_eye(r, g, b):
    """蓝色的眼睛。"""
    return (b > 110) & (b - r > 40) & (g < 140)


def mouth_box(im: Image.Image):
    """找 ω 形嘴巴的包围盒。

    ⚠️ **不能只按颜色找** —— 嘴巴的棕色（`#7a4526`）和描边的棕色（`#503020`）
       很接近，第一版按颜色一找就把**整条描边**圈进去了，
       然后把一大片涂白再画横线，整张图就毁了（实测踩到）。

    正确做法：**先用蓝眼睛定位**，嘴巴一定在**两眼之间、同一水平带**上，
    只在这个窗口里找。
    """
    a = np.array(im.convert("RGB")).astype(int)
    alpha = np.array(im)[:, :, 3] > 200
    eye = is_eye(a[:, :, 0], a[:, :, 1], a[:, :, 2]) & alpha
    ys, xs = np.where(eye)
    if len(ys) < 20:
        return None
    # 左眼 / 右眼
    xmid = (xs.min() + xs.max()) / 2
    lx = xs[xs < xmid]
    rx = xs[xs >= xmid]
    if len(lx) == 0 or len(rx) == 0:
        return None
    x0, x1 = int(lx.max()) + 2, int(rx.min()) - 2      # 两眼之间
    y0, y1 = int(ys.min()) - 4, int(ys.max()) + 10     # 眼睛那条水平带
    if x1 - x0 < 8:
        return None

    # 只在这个窗口里找"比描边浅的中棕"
    win = a[y0:y1, x0:x1]
    m = (win[:, :, 0] > 95) & (win[:, :, 0] < 175) & \
        (win[:, :, 1] > 50) & (win[:, :, 1] < 120) & \
        (win[:, :, 2] > 25) & (win[:, :, 2] < 95)
    wys, wxs = np.where(m)
    if len(wys) < 25:
        return None
    return (x0 + int(wxs.min()), y0 + int(wys.min()),
            x0 + int(wxs.max()) + 1, y0 + int(wys.max()) + 1)


def edit_flat_mouth(im: Image.Image) -> Image.Image:
    """把 ω 形的嘴改成一条平线（生气）。"""
    box = mouth_box(im)
    if not box:
        print("        ⚠️ 没定位到嘴巴，保持原样")
        return im
    x0, y0, x1, y1 = box
    d = ImageDraw.Draw(im)
    # **只涂掉嘴巴本身**（不再往外扩 pad —— 那条会蹭到描边）
    d.rectangle([x0, y0, x1, y1], fill=(255, 255, 255, 255))
    cy = (y0 + y1) // 2
    thick = max(4, (y1 - y0) // 3)
    d.line([x0, cy, x1, cy], fill=(122, 69, 38, 255), width=thick)
    return im


def edit_question_mark(im: Image.Image) -> Image.Image:
    """在头顶右上方加一个黄色的问号（需要确认）。"""
    # 头顶位置：不透明内容的最上面
    a = np.array(im)[:, :, 3] > 40
    ys, xs = np.where(a)
    top = int(ys.min())
    cx = int((xs.min() + xs.max()) / 2)
    # 找一个够大的字体
    font = None
    for p in ["/System/Library/Fonts/Supplemental/Arial Bold.ttf",
              "/System/Library/Fonts/Helvetica.ttc",
              "/System/Library/Fonts/SFNS.ttf"]:
        if Path(p).exists():
            try:
                font = ImageFont.truetype(p, 132)
                break
            except Exception:
                pass
    d = ImageDraw.Draw(im)
    x = cx + 60
    y = max(6, top - 118)
    if font:
        d.text((x, y), "?", font=font, fill=(232, 184, 75, 255),
               stroke_width=7, stroke_fill=(90, 58, 32, 255))
    else:
        # 没有字体就手画一个
        d.ellipse([x + 16, y + 10, x + 68, y + 62], outline=(232, 184, 75, 255), width=12)
        d.line([x + 42, y + 62, x + 42, y + 92], fill=(232, 184, 75, 255), width=12)
        d.ellipse([x + 36, y + 104, x + 50, y + 118], fill=(232, 184, 75, 255))
    return im


def edit_close_eyes(im: Image.Image) -> Image.Image:
    """把**睁着的竖直蓝眼睛**改成**闭眼的短横条**。

    为什么需要：这套原图里没有"趴着睡"的帧 ——
    `r5` 行是坐着逐渐低头，`r6` 行是**趴着**（正是要的睡姿）但**眼睛睁着**。

    ⚠️ **原图的"闭眼"长什么样，是量出来的，不是猜的**（都以内容高的百分比表示）：

        睁眼（r0c0 / r6c0）   4.6~5.1% 宽 × 15~16% 高   ← 竖直长条
        眯眼（r5c2）          9.7%     × 5.1%           ← 横向短条
        眯眼笑（r8c1）        9.7%     × 3.7%
        **闭眼（r0c1）**      **6.4% × 2.8%**           ← 最扁最小的横条 ★

    所以闭眼 = **短横条**，不是"把竖条压扁"，也不是"蓝色消失只留棕线"
    （第一版按"蓝色消失"画成棕色弧线，和原图风格不一致）。

    ⚠️ 填充眼睛原来占的位置时，**不能用单色** ——
       这两只眼睛正好压在**米棕头发与白色身体的分界**上，
       盖成白色会留下两个白方块（第一版就是这么翻车的）。
       正确做法：**逐行水平插值** —— 每行用眼睛左右两侧的实际颜色过渡过去。
    """
    rgb = np.array(im.convert("RGB")).astype(int)
    alpha = np.array(im)[:, :, 3] > 200
    eye = is_eye(rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]) & alpha
    ys, xs = np.where(eye)
    if len(ys) < 20:
        print("        ⚠️ 没找到蓝眼睛，保持原样")
        return im

    content = np.where(alpha)
    H = content[0].max() - content[0].min() + 1
    BAR_W = 0.064 * H          # 闭眼横条的宽（照 r0c1 量的）
    BAR_H = 0.028 * H          # 闭眼横条的高

    xmid = (xs.min() + xs.max()) / 2
    d = ImageDraw.Draw(im)
    for sel in (xs < xmid, xs >= xmid):
        ex, ey = xs[sel], ys[sel]
        if len(ex) < 5:
            continue
        x0, x1 = int(ex.min()), int(ex.max())
        y0, y1 = int(ey.min()), int(ey.max())
        pad = 2

        # ① 把眼睛原来占的地方补回去。
        #
        # ⚠️ **这一帧的脸部边界是斜的，必须逐行算，不能用固定的左右分界。**
        #
        #    实测（r6c0 左眼，x 185..206，y 149..219）：
        #      「米棕头发 → 白色脸」的边界是一条**斜线**，dx/dy ≈ -0.65：
        #        y=141 → x=222（眼睛上方，看得见）
        #        y=221 → x=171（眼睛下方，看得见）
        #      中间那段**正好被眼睛盖住** —— 眼睛本身把边界吃掉了。
        #
        #    所以做法是：**在眼睛上下量出边界，线性拟合，再拿拟合线
        #    逐行决定这一行哪儿是米棕、哪儿是白。**
        #
        #    前几版为什么不对：
        #      · 固定 `mid=(lx+rx)/2` 分左右 → 把斜边填成**竖直边**（用户指出）
        #      · 插值                          → 斜边糊成渐变
        #      · 单色填                        → 白块 / 米棕块
        pad = 2
        lx, rx = x0 - pad - 1, x1 + pad + 1
        if lx < 0 or rx >= im.width:
            continue

        # ── 量边界：在眼睛上下各找几行，记录"米棕→白"的跳变位置 ──
        def boundary_at(yy):
            if yy < 0 or yy >= im.height:
                return None
            prev = None
            for xx in range(max(0, lx - 30), min(im.width, rx + 31)):
                c = rgb[yy, xx]
                cur = (c[0] > 170) and (c[0] < 240) and (c[0] - c[2] > 25)
                if prev is not None and prev != cur:
                    return xx
                prev = cur
            return None

        samples = []
        for yy in list(range(max(0, y0 - 50), y0 - 3)) + \
                  list(range(y1 + 4, min(im.height, y1 + 51))):
            bx = boundary_at(yy)
            if bx is not None:
                samples.append((yy, bx))

        # ⚠️ **不要用直线拟合。**
        #    第一版拟合出一条直线（斜率能对上，-0.65），但**实际边界是略弯的** ——
        #    直线在眼睛那一段会偏出去几个像素，成品上就是"斜边凸出一块"
        #    （用户看出来了）。
        #    改成**分段线性插值**：在眼睛上下的实测样本之间按 y 插值，
        #    局部怎么弯就怎么补。
        samples.sort()
        a = b = None

        def boundary_x(yy):
            if not samples:
                return (lx + rx) / 2
            if yy <= samples[0][0]:
                return samples[0][1]
            if yy >= samples[-1][0]:
                return samples[-1][1]
            for k in range(1, len(samples)):
                y1_, x1_ = samples[k - 1]
                y2_, x2_ = samples[k]
                if y1_ <= yy <= y2_:
                    if y2_ == y1_:
                        return x1_
                    t = (yy - y1_) / (y2_ - y1_)
                    return x1_ + (x2_ - x1_) * t
            return samples[-1][1]

        if len(samples) >= 4:
            print(f"        ℹ️ 脸部边界: 用 {len(samples)} 个实测点分段插值"
                  f"（y {samples[0][0]}..{samples[-1][0]}）")

        # ── 要填的范围：**只填真正是蓝色的像素**，外扩 2px 吃掉抗锯齿 ──
        #
        # ⚠️ 前几版填的是**整个 bbox 矩形** —— 但矩形四角本来就不是眼睛，
        #    是原图的画面，涂上去就出现**淡色方块**（用户看出来的）。
        #    改成先做一次"眼睛掩码 + 外扩 2px"，只涂这些像素。
        emask = np.zeros(im.height * im.width, dtype=bool)
        emask[ey * im.width + ex] = True
        emask = emask.reshape(im.height, im.width)
        for _ in range(3):                       # 4 邻域膨胀 3 次（吃掉抗锯齿）
            m2 = emask.copy()
            m2[1:, :] |= emask[:-1, :]
            m2[:-1, :] |= emask[1:, :]
            m2[:, 1:] |= emask[:, :-1]
            m2[:, :-1] |= emask[:, 1:]
            emask = m2

        # ── 逐行填：拟合线左边是米棕、右边是白 ──
        for yy in range(max(0, y0 - 4), min(im.height, y1 + 5)):
            bx = boundary_x(yy)
            for xx in range(lx + 1, rx):
                if not emask[yy, xx]:
                    continue                     # 不是眼睛（也不是它边上），原样保留
                # 米棕取本行最左、白取本行最右。
                #
                # ⚠️ **不能取紧贴眼睛的那一格**（`lx` / `rx`）——
                #    那是眼睛的**抗锯齿边缘**，颜色已经被蓝色污染、偏亮。
                #    实测：取 `lx` 填出来是 `#e0c4a2`，而周围真正的米棕是
                #    `#d6bd9e` —— 差 10 个色阶，肉眼就是一块**淡色方块**。
                #    往两边多退 12px 才是干净的原色。
                OFFSET = 12
                if xx < bx:
                    src_x = max(0, x0 - OFFSET)
                else:
                    src_x = min(im.width - 1, x1 + OFFSET)
                col = tuple(rgb[yy, src_x])
                d.point((xx, yy), fill=col + (255,))

        # ② 画闭眼的短横条（蓝色，圆角）
        cx = (x0 + x1) / 2
        cy = (y0 + y1) / 2
        d.rounded_rectangle(
            [cx - BAR_W / 2, cy - BAR_H / 2, cx + BAR_W / 2, cy + BAR_H / 2],
            radius=BAR_H / 2, fill=(55, 80, 156, 255))
    return im


def edit_add_laptop(im: Image.Image) -> Image.Image:
    """在身前加一台小笔记本电脑（**背面朝我们 + 苹果 logo**）。

    ## 视角（用户草图定的）
    能看到 logo → 我们看到的是**屏幕盖的背面** → 视角在笔记本**后面**。
    对应到桌宠：**猫坐在笔记本后面看屏幕，我们在猫身后**。

    ## 形状（用户第二版草图明确要求）
      · **盖子是平行四边形** —— 不是梯形。上下两条边平行、左右两条边也平行，
        整体**向右上倾斜**（像从后方偏左看过去的样子）。
        第一版画成"上窄下宽"的梯形（透视近大远小），用户说不对，改掉了。
      · **键盘只露"右下方的一个角"** —— 一小块四边形贴在盖子右下角，
        不是一整条。草图里就是那么一小角。
      · **logo 用苹果** —— 用户明确要求（第一版我换成了爪印，说是不想用别人商标，
        但这是用户自己的桌宠、用户要求，照做）。

    ## 风格
      · 平涂，没有渐变没有阴影
      · 粗深棕描边（和身体同宽，约 7px）
      · 颜色只用这套已有的：米棕 #d6bd9e / 描边 #503020
    """
    a = np.array(im)[:, :, 3] > 40
    ys, xs = np.where(a)
    top, bottom = int(ys.min()), int(ys.max())
    H = bottom - top + 1

    # ⚠️ **中心要按"下半身"算，不能按整个内容包围盒。**
    #    这一帧左边拖着尾巴，用包围盒算出来的中心会**整体偏左**（实测踩到）。
    lo = top + int(H * 0.62)
    band = a[lo:bottom + 1]
    bx = np.where(band.any(axis=0))[0]
    body_cx = float(np.median(bx)) if len(bx) else (xs.min() + xs.max()) / 2

    # ⚠️ 用户要求：**电脑放在身体的左侧**（不是压在身前）。
    #
    #    实测（019，电脑那个高度带 0.57~0.87H）：
    #        · 身体最靠左 x = 97
    #        · 身体中位中心 x = 270
    #        · 画布左边距只有 97px，而"整身宽"的电脑有 174px
    #    —— **塞不进左侧空白**，所以两件事一起做：
    #        ① 电脑**缩小**（宽 0.40H → 0.34H）
    #        ② 让它的**右缘贴住身体左缘**再往右压一点点，
    #           读起来是"她左手边一台电脑、身体挡在后面"
    band_lo = top + int(H * 0.57)
    band_hi = top + int(H * 0.87)
    lefts = []
    for yy in range(band_lo, min(band_hi, im.height)):
        row = np.where(a[yy])[0]
        if len(row):
            lefts.append(int(row.min()))
    body_left = min(lefts) if lefts else int(xs.min())
    cx = body_left + H * 0.10           # 电脑中心：从身体左缘往右挪一点点

    OUTLINE = (80, 48, 32, 255)
    TAN = (214, 189, 158, 255)
    LW = max(6, int(H * 0.016))

    # ── 几何 ──
    w = H * 0.45                        # 盖子下沿的宽（对着用户的草图量的）
    h = H * 0.32                        # 盖子的高
    y1 = top + H * 0.800                # 盖子下沿的 y —— 停在 0.80，她的脚要露出来
    dx = H * 0.075                      # 上边相对下边右移多少（平行四边形的斜度）
    dy = H * 0.020                      # 上边相对下边再抬高一点（整体倾斜感）

    x0, x1 = cx - w / 2, cx + w / 2
    # 平行四边形：上下两边平行且等长，左右两边也平行且等长
    bl = (x0, y1)
    br = (x1, y1)
    tr = (x1 + dx, y1 - h - dy)
    tl = (x0 + dx, y1 - h)

    d = ImageDraw.Draw(im)
    # ① 键盘：贴在盖子**右下方的一个角**（先画，会被盖子压住一部分）
    kw = H * 0.115                      # 往右伸出
    kd = H * 0.045                      # 往下伸出
    deck = [
        (x1 - w * 0.62, y1 - h * 0.02),  # 贴盖子下沿靠左
        (x1, y1 - h * 0.02),             # 盖子右下角
        (x1 + kw, y1 + kd * 0.55),       # 往右下伸出
        (x1 - w * 0.50 + kw * 0.72, y1 + kd),
    ]
    d.polygon(deck, fill=TAN, outline=OUTLINE, width=LW)

    # ② 盖子背面（平行四边形）
    d.polygon([bl, br, tr, tl], fill=TAN, outline=OUTLINE, width=LW)

    # ③ 苹果 logo —— **直接用用户给的图**，不再手画。
    #
    #    手画了三次都不够像（"一个圆挖个洞"会变成 C；
    #    咬口和底部凹口挨太近会变成 G）。用户直接给了图，用它最省事也最准。
    logo_path = ROOT / "pet-art" / "yuexin-miao" / "apple-logo.webp"
    if logo_path.exists():
        lg = Image.open(logo_path).convert("RGBA")
        lh = max(12, int(H * 0.145))
        lg = lg.resize((max(1, round(lg.width * lh / lg.height)), lh), Image.LANCZOS)
        # ⚠️ **logo 要放在盖子的偏上位置，不能放在正中。**
        #    打字的"手臂"补丁落在盖子下段 —— 放正中会被补丁切掉半个
        #    （实测踩到：logo 被一条横线劈成两半）。
        #    真实笔记本的 logo 本来也偏上，放这儿更自然。
        lcx = (bl[0] + br[0] + tr[0] + tl[0]) / 4
        lid_top = tl[1]
        lid_bot = bl[1]
        lcy = lid_top + (lid_bot - lid_top) * 0.34
        im.alpha_composite(lg, (int(lcx - lg.width / 2), int(lcy - lg.height / 2)))
    else:
        print("        ⚠️ 找不到 pet-art/yuexin-miao/apple-logo.webp，盖子上留空")

    return im



def edit_typing_arm(im: Image.Image, arg=None) -> Image.Image:
    """把手臂换成 **019 那只"C"形的手**，并**按 dy 上下移动** —— 表示打字。

    为什么要这么做（用户的要求）：
      「宠物的手臂改成用 19 的手臂，并且做成上下摆动，表示打字的动作」

    ## 为什么能干净地做出来（量过的）
    019 里那只手臂是**完全独立在白色肚子上的一个深色 C 形**，
    **不碰身体轮廓**（实测 x≈149..210、y≈290..350，四周全是白）：

        y=296  166..201
        y=308  151..164
        y=320  149..158
        y=332  153..169
        y=344  172..202

    所以三步就够了，**不需要复杂的抠图**：
      ① 从 019 把 C 连同一圈边距剪下来
      ② 在当前这张的同一位置**用白色补平**（那里本来就是白肚子）
      ③ 把 C 按 dy 贴回去 —— 上下摆动就是不同的 dy

    ⚠️ 补的时候要连**原图自己的手臂**一起补掉 —— 否则 022 那只垂在身侧的
      手臂会和贴上去的 C 同时出现。

    ## 参数
    `arg` 是 `{"dy": 上下偏移, "dx": 横向偏移}`。
    ⚠️ **横向也要能挪**：电脑放到她左边、还放大了之后，
      手臂原来的位置**被电脑盖住**了 —— 贴上去像"手糊在屏幕上"。
      往右挪一段，手就落在电脑右边她的肚子上，和用户草图一致。
    """
    if isinstance(arg, dict):
        dy = int(arg.get("dy", 0)); dx = int(arg.get("dx", 0))
    else:
        dy = int(arg or 0); dx = 0
    art = ROOT / "pet-art" / "yuexin-miao"
    src019 = art / "frames" / "019.png"
    if not src019.exists():
        print("        ⚠️ 找不到 frames/019.png，跳过手臂改造")
        return im

    a = np.array(im)[:, :, 3] > 40
    ys, xs = np.where(a)
    top, bottom = int(ys.min()), int(ys.max())
    H = bottom - top + 1

    # 手臂的取景框（对着 019 量的，按内容高归一化）
    #
    # ⚠️ **x 要用 `xs.min()` 当基准，不能拿 `top` 去算。**
    #    第一版四个值全用 `top + H*比例` —— 而 top 是个 **y** 值，
    #    于是抠的是 x 288..358 / y 351..406，**完全不是手臂所在的位置**，
    #    贴上去什么也看不见（实测踩到）。
    #    手臂实测在 x 149..210、y 290..350，而内容 x 从 67 起、y 从 38 起：
    #        x: 67 + H*0.19 = 149   ~  67 + H*0.33 = 210
    #        y: 38 + H*0.58 = 290   ~  38 + H*0.72 = 351
    # ⚠️ 取景框要**往下挪**：手臂原来的位置在盖子的中上部，
    #    贴上去像"挂在屏幕盖上"；挪到盖子的下段/键盘那一带，
    #    才像"爪子搭在键盘上打字"。
    x_left = int(xs.min())
    ax0 = x_left + int(H * 0.19); ax1 = x_left + int(H * 0.33)
    #    位置就用 019 里手臂原来的地方 —— 电脑挪到左边之后，
    #    手臂落在**她自己的身体上**（不再压着电脑），补色也就是白肚子、
    #    补完完全看不见。
    ay0 = top + int(H * 0.58);    ay1 = top + int(H * 0.72)

    src = Image.open(src019).convert("RGBA")
    patch = src.crop((ax0, ay0, ax1, ay1))
    pa = np.array(patch)
    arm = (pa[:, :, 3] > 40) & (pa[:, :, 0] < 140) & (pa[:, :, 1] < 100) & (pa[:, :, 2] < 80)
    for _ in range(2):                       # 膨胀两次，保住抗锯齿边缘
        e = arm.copy()
        e[1:, :] |= arm[:-1, :]
        e[:-1, :] |= arm[1:, :]
        e[:, 1:] |= arm[:, :-1]
        e[:, :-1] |= arm[:, 1:]
        arm = e

    # ② 把原来的手臂抹掉。
    #
    # ⚠️ **只抹手臂自己的像素，不能抹整个矩形。**
    #    前两版都是 `d.rectangle(...)` 涂一整块 ——
    #    电脑挪到左边之后，那块矩形压住了盖子的右上角和 logo，
    #    成品上一眼就能看见一个方块（实测踩到）。
    #    按掩码逐像素抹才对：手臂多宽就抹多宽，一个像素都不多。
    #
    #    抹的颜色取**手臂四周一圈的中位数** ——
    #    位置在她自己身上就是白肚子、压到电脑就是米棕，两种情况都对。
    #    （⚠️ 别用量化后取众数：会偏一档色，补出来是一块淡斑。）
    arr = np.array(im)
    ring = []
    for yy in range(max(0, ay0 - 10), min(im.height, ay1 + 10)):
        for xx in range(max(0, ax0 - 10), min(im.width, ax1 + 10)):
            if ax0 - 3 <= xx <= ax1 + 3 and ay0 - 3 <= yy <= ay1 + 3:
                continue
            px = arr[yy, xx]
            if px[3] > 200 and not (px[0] < 140 and px[1] < 100 and px[2] < 80):
                ring.append((int(px[0]), int(px[1]), int(px[2])))
    if ring:
        ring.sort(key=lambda c: c[0] + c[1] + c[2])
        fill = ring[len(ring) // 2]
    else:
        fill = (255, 255, 255)

    # ⚠️ **用 numpy 掩码直接赋值，不要 `ImageDraw.point` 逐点画。**
    #    逐点画出来仍然残留一层淡影（实测：放大 4 倍能看到原手臂的轮廓）——
    #    掩码里的点并没有全部落到图上。整块切片赋值是精确的、一个不漏。
    arr2 = np.array(im)
    region = arr2[ay0:ay1, ax0:ax1]
    region[arm] = np.array(fill + (255,), dtype=np.uint8)
    arr2[ay0:ay1, ax0:ax1] = region
    im = Image.fromarray(arr2, "RGBA")

    # 手臂本身（透明底上只有深色轮廓）
    keep = np.dstack([arm] * 4)
    clean = np.where(keep, pa, np.zeros_like(pa)).astype(np.uint8)

    # ③ 按 dy 贴回去
    im.alpha_composite(Image.fromarray(clean, "RGBA"), (ax0 + dx, ay0 + dy))
    return im


def edit_typing_self(im: Image.Image, arg=None) -> Image.Image:
    """**从这张图自己**里抠出手臂，按 dy 贴回去 —— 只让手臂动。

    为什么加这个：用户后来直接给了一张**画好的成品图**
    （猫 + 左边一台笔记本 + 苹果 logo，全都摆好了），说
    「能否直接用我发的图片，只是需要动手臂」。

    那就别再用"程序化拼电脑"那套了 —— 直接把他的图当底，
    抠出手臂、上下挪一挪，就是打字动画。

    ## 为什么能干净地做出来（量过的）
    那只手臂是**完全独立在白色肚子上的一个深色 C 形**，不碰身体轮廓、
    也不压到电脑：归一化到内容高之后是
        x 0.478..0.609   y 0.533..0.674
    四周全是白的 → 抹掉它就用白色补，补完一个像素都看不出来。

    `arg` 是上下偏移（像素）；也可以是 `{"dy":…, "dx":…}`。
    """
    if isinstance(arg, dict):
        dy = int(arg.get("dy", 0)); dx = int(arg.get("dx", 0))
    else:
        dy = int(arg or 0); dx = 0

    a = np.array(im)
    op = a[:, :, 3] > 40
    ys, xs = np.where(op)
    top, H, x_left = int(ys.min()), int(ys.max() - ys.min() + 1), int(xs.min())

    # 手臂的取景框（对着用户那张图量的，留了点边距）
    ax0 = x_left + int(H * 0.455); ax1 = x_left + int(H * 0.635)
    ay0 = top + int(H * 0.510);    ay1 = top + int(H * 0.700)

    patch = im.crop((ax0, ay0, ax1, ay1))
    pa = np.array(patch)
    # ⚠️ **判据是"不是白色"，不是"是深色"。**
    #    用 `r<150 & g<110 & b<95` 只抓得到手臂的深色核心 ——
    #    抗锯齿那一圈浅边（偏米色）漏在外面，手臂挪走之后
    #    **原地留下一圈鬼影**（实测踩到：三帧里都能看到淡淡的轮廓）。
    #    这块取景框里除了手臂就是白肚子，所以"非白即手臂"最稳。
    #    ⚠️ "白"的门槛不能定太低：定 205 的时候，手臂**抗锯齿的边缘像素
    #       大约 230**，被判成"白" → 没进掩码 → 没被补掉 ——
    #       手臂挪走之后原地留一层**很淡的棕色晕**（放大 4 倍一眼可见）。
    #       肚子本身接近纯白（250+），所以门槛提到 240 完全不会误伤。
    arm = (pa[:, :, 3] > 40) & ~((pa[:, :, 0] > 240) & (pa[:, :, 1] > 240) & (pa[:, :, 2] > 240))
    for _ in range(3):                       # 再膨胀三次，把过渡像素全带走
        e = arm.copy()
        e[1:, :] |= arm[:-1, :]; e[:-1, :] |= arm[1:, :]
        e[:, 1:] |= arm[:, :-1]; e[:, :-1] |= arm[:, 1:]
        arm = e

    # 抹掉原手臂：颜色取四周一圈的中位数（这里就是白肚子）
    ring = []
    for yy in range(max(0, ay0 - 10), min(im.height, ay1 + 10)):
        for xx in range(max(0, ax0 - 10), min(im.width, ax1 + 10)):
            if ax0 - 3 <= xx <= ax1 + 3 and ay0 - 3 <= yy <= ay1 + 3:
                continue
            px = a[yy, xx]
            if px[3] > 200 and px[0] > 240 and px[1] > 240 and px[2] > 240:
                ring.append((int(px[0]), int(px[1]), int(px[2])))
    if ring:
        ring.sort(key=lambda c: c[0] + c[1] + c[2])
        fill = ring[len(ring) // 2]
    else:
        fill = (255, 255, 255)

    d = ImageDraw.Draw(im)
    ys2, xs2 = np.where(arm)
    for yy, xx in zip(ys2, xs2):
        d.point((ax0 + int(xx), ay0 + int(yy)), fill=fill + (255,))

    keep = np.dstack([arm] * 4)
    clean = np.where(keep, pa, np.zeros_like(pa)).astype(np.uint8)
    im.alpha_composite(Image.fromarray(clean, "RGBA"), (ax0 + dx, ay0 + dy))
    return im


def edit_arm_layer(im: Image.Image, arg=None) -> Image.Image:
    """把**用户单独给的手臂图**叠到**用户给的无手臂底图**上，按 dy 上下挪。

    为什么换成这个做法：之前是"从成品图里抠出手臂、再补原位"——
    用户反馈"还是有错位"。后来他直接给了**两张干净的图**：
    一张没有手臂的底图、一张单独的手臂图，那就不用抠也不用补了。

    ## 位置是**做差**量出来的（不是估的）
    两张原图都是 848×736，逐像素做差：
        差异区域 x 348..491  y 381..489  = **144×109**
    —— 和用户给的手臂图内容尺寸**完全一致**，说明两张图严格对齐。
    换算到归一化后的 512 帧（内容高 435）：
        x 223..314  y 267..336   (91×69)
    再除以内容高就是下面的比例。

    `arg` 是上下偏移（像素）；也可以是 `{"dy":…, "dx":…}`。
    """
    if isinstance(arg, dict):
        dy = int(arg.get("dy", 0)); dx = int(arg.get("dx", 0))
    else:
        dy = int(arg or 0); dx = 0

    arm_path = ROOT / "pet-art" / "yuexin-miao" / "working-arm.png"
    if not arm_path.exists():
        print("        ⚠️ 找不到 working-arm.png，跳过手臂")
        return im

    a = np.array(im)
    ys, xs = np.where(a[:, :, 3] > 40)
    top, H, x_left = int(ys.min()), int(ys.max() - ys.min() + 1), int(xs.min())

    aw = max(1, round(H * 0.2092)); ah = max(1, round(H * 0.1586))
    arm = Image.open(arm_path).convert("RGBA").resize((aw, ah), Image.LANCZOS)
    px = x_left + round(H * 0.4184) + dx
    py = top + round(H * 0.5264) + dy
    im.alpha_composite(arm, (px, py))
    return im


# 闭眼 / 眯眼 的两种样式（都是"竖椭圆 → 同色横杠"，只是比例和位置不同）。
# 数值全部对着参考帧量的，归一化到内容高：
#   · 眨眼：参考原图 002  → 宽 1.45 倍眼宽、高 0.0276H、比眼中心低 0.025H
#   · 眯眼：参考"摸头眯眼"帧 → 宽 1.68 倍眼宽、高 0.0368H、比眼中心低 0.056H
#     （眯眼比眨眼**更宽**，位置也**更低**，看起来是"舒服地眯起来"而不是"闭上"）
EYE_STYLES = {
    "blink":  {"w": 1.45, "h": 0.0276, "dy": 0.025},
    #   ⚠️ 眯眼的下移量按用户要求**分两次上移过**：
    #      参考帧量到的是 0.056
    #        → 上移 4px：  0.056 - 4/435  = 0.0468
    #        → 再上移 10px：0.0468 - 10/435 = 0.0238
    #      （435 是归一化时用的内容高）
    #      原来的高度横杠压在鼻子附近，看着像"困"；现在抬到眼睛原来的高度，
    #      才是"舒服地眯起来"。
    "squint": {"w": 1.68, "h": 0.0368, "dy": 0.0238},
}


def edit_blink_eyes(im: Image.Image, arg=None) -> Image.Image:
    """把眼睛换成一条同色的横杠 —— **闭眼**或**眯眼**。

    给「工作中」加眨眼、「伸懒腰」加眯眼用。

    `arg` 是样式名：`"blink"`（默认）或 `"squint"`。

    ## 怎么找眼睛
    眼睛是**深蓝色的竖圆角矩形**，判据是"蓝明显大于红"：
        b - r > 40 且 b > 90 且 r < 130
    在这张底图上量到：
        左眼 x 164..182 (19宽)  y 148..217 (70高)   中心 (173,182)
        右眼 x 264..285 (22宽)  y 140..214 (75高)   中心 (274,177)
        颜色 #2755a4
    按 x 的中间一分为二就是左右两只眼。

    ## 怎么画闭眼
    先把原来那只眼睛**抹掉**（用四周的中位色补，这里是白脸），
    再在眼睛的**垂直中心**画一条**同色的横杠** ——
    宽度取眼睛宽的 1.5 倍、高度取宽的 0.55 倍，两端留圆角。

    ⚠️ 横杠**要短、要细**。画长画粗就不是闭眼，是"眯成一条缝的怒眼"了。
    """
    style = EYE_STYLES.get(arg if isinstance(arg, str) else "blink", EYE_STYLES["blink"])

    a = np.array(im)
    op = a[:, :, 3] > 40
    ys, xs = np.where(op)
    top, H, x_left = int(ys.min()), int(ys.max() - ys.min() + 1), int(xs.min())

    blue = op & ((a[:, :, 2].astype(int) - a[:, :, 0].astype(int)) > 40) \
        & (a[:, :, 2] > 90) & (a[:, :, 0] < 130)
    by, bx = np.where(blue)
    if len(by) == 0:
        print("        ⚠️ 没找到蓝色眼睛，跳过眨眼")
        return im

    eye_rgb = tuple(int(v) for v in a[blue][:, :3].mean(axis=0))
    mid = (int(bx.min()) + int(bx.max())) // 2

    for is_left in (True, False):
        sel = (bx <= mid) if is_left else (bx > mid)
        ex, ey = bx[sel], by[sel]
        if len(ex) == 0:
            continue
        x0, x1, y0, y1 = int(ex.min()), int(ex.max()), int(ey.min()), int(ey.max())
        w = x1 - x0 + 1
        cy = (y0 + y1) // 2

        # ① 抹掉原来那只眼睛 —— **逐行取色**。
        #
        #    ⚠️ 试过两种"取一个颜色补整只眼"的做法，都不行：
        #       · 取"四周一圈"的中位色 → 圈里混进头发（米棕），补出米棕竖条
        #       · 取"紧贴左右两列"的中位色 → 眼睛上下跨越了不同的底色
        #         （上面是白脸、下面靠近头发），一个颜色补不平，仍有色差
        #    眼睛是**竖长条**，每一行两侧的底色可能都不一样，
        #    所以只能**一行一行地取**：第 y 行就用第 y 行眼睛外侧的颜色。
        # ② 把眼睛抹掉 —— **按列做垂直插值**。
        #
        #    ⚠️ **为什么不能"取一个颜色补整只眼"（试了五种才明白）：**
        #       量过这只眼睛在底图上的处境 ——
        #         左眼 cy 那一行：左侧 12px 是 #d4be9f（**头发**），右侧是 #f9faf7（脸）
        #         右眼 cy 那一行：左侧是 #fafafa（脸），右侧 12px 是 #dbc2a2（**头发**）
        #       **眼睛的左缘紧贴头发、右缘在脸上** —— 它正好骑在"脸/头发"的
        #       分界线上。补白会把头发涂白（用户看到的两块亮斑），
        #       补米棕又会把脸涂脏。**一个颜色不可能对。**
        #
        #    ✅ 正确做法：**按列垂直插值** —— 每一列取眼睛上边缘"之上"和
        #       下边缘"之下"的颜色，中间线性过渡。
        #       脸的那几列上下都是白 → 补出白；蹭到头发的那几列上下都是米棕
        #       → 补出米棕；边界那几列自然过渡。**边界就续上了。**
        # ② 把眼睛抹掉 —— **重建"脸/头发"那条分界线**。
        #
        #    ⚠️ 为什么前面五种做法全失败（都是量出来的）：
        #       眼睛**骑在脸和头发的分界线上** ——
        #         左眼 cy 那行：左边 12px 是 #d4be9f（头发），右边是 #f9faf7（脸）
        #         右眼 cy 那行：左边是 #fafafa（脸），右边 12px 是 #dbc2a2（头发）
        #       · 补一个固定的白 → 把头发涂白，留下两块亮斑
        #       · 补一个固定的米棕 → 把脸涂脏
        #       · 取"四周一圈/左右两列"的中位色 → 两种底色混在一起，都不对
        #       · 逐列垂直插值 → 分界线是**斜**的，插出来是一条灰色渐变
        #         （竖直插值只能造出竖直渐变，造不出斜的分界）
        #
        #    ✅ 正确做法：分界线**基本上是一条直线**，所以
        #       ① 先在眼睛**左右两侧**（没被眼睛挡住的地方）逐列量出分界线的高度
        #       ② 横向插值，把分界线**穿过眼睛**补全
        #       ③ 眼睛的像素按分界线重涂：线以上用头发色、线以下用脸色
        #       这样斜的分界就自然续上了。
        arr = np.array(im)
        pad = 9
        gx0, gx1 = max(0, x0 - pad), min(im.width, x1 + pad + 1)
        gy0, gy1 = max(0, y0 - pad), min(im.height, y1 + pad + 1)
        region = arr[gy0:gy1, gx0:gx1]
        m = blue[gy0:gy1, gx0:gx1].copy()
        for _ in range(3):
            e = m.copy()
            e[1:, :] |= m[:-1, :]; e[:-1, :] |= m[1:, :]
            e[:, 1:] |= m[:, :-1]; e[:, :-1] |= m[:, 1:]
            m = e
        # ⚠️ **这里不要再加"只填偏蓝像素"的过滤。**
        #    加过 —— 结果眼睛最外圈混了头发（蓝混米棕），`b - r` 掉到 8 以下
        #    被剔掉，眼睛四周留了一整圈 1px 的细线（放大看非常明显）。
        #    现在既然是"按分界线重涂"（线以上补头发色、线以下补脸色），
        #    多涂到头发或脸都是对的，**没有任何需要排除的东西**。

        def is_face(px):
            return px[3] > 200 and px[0] > 225 and px[1] > 225 and px[2] > 225

        # ① 逐列量分界线（自上而下第一个"脸"像素的 y）
        def boundary_of(cx):
            for yy in range(m.shape[0]):
                if not m[yy, cx] and is_face(region[yy, cx]):
                    return yy
            return None

        known = {}
        for cx in range(m.shape[1]):
            if m[:, cx].any():
                continue                       # 这一列被眼睛挡住，量不到
            b = boundary_of(cx)
            if b is not None:
                known[cx] = b

        # ② 横向插值，补出被挡住那几列的分界线
        line = {}
        for cx in range(m.shape[1]):
            if cx in known:
                line[cx] = known[cx]
                continue
            lefts = [k for k in known if k < cx]
            rights = [k for k in known if k > cx]
            if lefts and rights:
                l, r = max(lefts), min(rights)
                t = (cx - l) / (r - l)
                line[cx] = known[l] * (1 - t) + known[r] * t
            elif lefts:
                line[cx] = known[max(lefts)]
            elif rights:
                line[cx] = known[min(rights)]

        # ③ 按分界线重涂
        for cx in range(m.shape[1]):
            if not m[:, cx].any() or cx not in line:
                continue
            by_ = line[cx]
            # 头发色：取这一列最上面那个实心像素；脸色：取分界线之下第一个实心像素
            hair_px = face_px = None
            for yy in range(m.shape[0]):
                if region[yy, cx][3] > 200 and not is_face(region[yy, cx]):
                    hair_px = region[yy, cx]; break
            for yy in range(int(by_) + 1, m.shape[0]):
                if not m[yy, cx] and is_face(region[yy, cx]):
                    face_px = region[yy, cx]; break
            for yy in range(m.shape[0]):
                if not m[yy, cx]:
                    continue
                if yy < by_ and hair_px is not None:
                    region[yy, cx] = hair_px
                elif face_px is not None:
                    region[yy, cx] = face_px
        arr[gy0:gy1, gx0:gx1] = region
        im = Image.fromarray(arr, "RGBA")

        # ② 画闭眼的那条横杠（同色、两端圆角）
        # 对照参考帧 002 量的（归一化到内容高）：
        #     睁眼 宽 0.0460 高 0.1517 中心 y 0.2632
        #     闭眼 宽 0.0667 高 0.0276 中心 y 0.2885
        #   → 闭眼杠 = 睁眼宽的 1.45 倍、高的 1/5.5，而且**比眼睛中心低 0.025H**
        bw = max(6, int(w * style["w"]))
        bh = max(4, int(H * style["h"]))
        cx = (x0 + x1) // 2
        cy = cy + int(H * style["dy"])
        ImageDraw.Draw(im).rounded_rectangle(
            [cx - bw // 2, cy - bh // 2, cx + bw // 2, cy + bh // 2],
            radius=bh // 2, fill=eye_rgb + (255,))
    return im


def edit_move_mouth(im: Image.Image, arg=None) -> Image.Image:
    """把嘴巴（那个 "ω" 形）整体**上下平移**若干像素。

    为什么要这个：用户调完眯眼之后要求"嘴巴向下移 10px" ——
    眼睛和嘴巴是一组，眼睛抬上去了，嘴巴就得跟着让位。

    ## 怎么找到嘴巴（不靠写死坐标）
    嘴巴是**夹在两只眼睛中间**的那块深棕色：
        · x 在 左眼的右缘 和 右眼的左缘 之间
        · y 落在两只眼睛的上下范围里
    按这个找出来的就是那个 "ω"，**不会误伤胳膊和轮廓**
    （一开始用"眼睛下方的深色像素"找，把两条举起来的胳膊也算进去了）。

    ## 为什么能干净地做出来
    嘴巴**完全长在白脸上**（四周取样都是 #fefefe 级别的白），
    所以剪下来、原位补白、再贴回去 —— 不会有任何残留。

    `arg` 是垂直位移（像素，正数=向下），也可以传 `{"dy": …}`。
    """
    if isinstance(arg, dict):
        dy = int(arg.get("dy", 0))
    else:
        dy = int(arg or 0)
    if dy == 0:
        return im

    a = np.array(im)
    op = a[:, :, 3] > 40
    ys, xs = np.where(op)
    top, H = int(ys.min()), int(ys.max() - ys.min() + 1)

    blue = op & ((a[:, :, 2].astype(int) - a[:, :, 0].astype(int)) > 40) \
        & (a[:, :, 2] > 90) & (a[:, :, 0] < 130)
    by, bx = np.where(blue)
    if len(by) == 0:
        print("        ⚠️ 没找到蓝色眼睛，跳过嘴巴位移")
        return im
    mid = (int(bx.min()) + int(bx.max())) // 2
    left_max = int(bx[bx <= mid].max())
    right_min = int(bx[bx > mid].min())
    eye_top, eye_bot = int(by.min()), int(by.max())

    dark = op & (a[:, :, 0] < 150) & (a[:, :, 1] < 110) & (a[:, :, 2] < 90)
    mouth = np.zeros_like(dark)
    mouth[eye_top:eye_bot + 1, left_max + 1:right_min] = \
        dark[eye_top:eye_bot + 1, left_max + 1:right_min]
    my, mx = np.where(mouth)
    if len(my) == 0:
        print("        ⚠️ 没找到嘴巴，跳过")
        return im

    x0, x1, y0, y1 = int(mx.min()), int(mx.max()), int(my.min()), int(my.max())
    # ⚠️ 换算成"这个帧自己的尺度" —— 用户说的是 512 帧里的像素，
    #    而所有帧归一到内容高 435，所以按比例换算才稳。
    shift = round(dy * H / 435)

    patch = im.crop((x0 - 3, y0 - 3, x1 + 4, y1 + 4))
    # 原位补白：嘴巴四周取样取中位数（这里就是脸白）
    ring = []
    for yy in range(max(0, y0 - 8), min(im.height, y1 + 9)):
        for xx in range(max(0, x0 - 8), min(im.width, x1 + 9)):
            if x0 - 3 <= xx <= x1 + 3 and y0 - 3 <= yy <= y1 + 3:
                continue
            px = a[yy, xx]
            if px[3] > 200 and px[0] > 225 and px[1] > 225 and px[2] > 225:
                ring.append((int(px[0]), int(px[1]), int(px[2])))
    ring.sort(key=lambda c: c[0] + c[1] + c[2])
    face = ring[len(ring) // 2] if ring else (254, 254, 254)

    arr = np.array(im)
    region = arr[y0 - 3:y1 + 4, x0 - 3:x1 + 4]
    m = mouth[y0 - 3:y1 + 4, x0 - 3:x1 + 4].copy()
    for _ in range(2):                    # 膨胀，把抗锯齿的边带走
        e = m.copy()
        e[1:, :] |= m[:-1, :]; e[:-1, :] |= m[1:, :]
        e[:, 1:] |= m[:, :-1]; e[:, :-1] |= m[:, 1:]
        m = e
    region[m] = np.array(face + (255,), dtype=np.uint8)
    arr[y0 - 3:y1 + 4, x0 - 3:x1 + 4] = region
    im = Image.fromarray(arr, "RGBA")

    # 把嘴贴到新位置（只保留"不是白脸"的像素，避免带一块白过去）
    pa = np.array(patch)
    keep = (pa[:, :, 3] > 40) & ~((pa[:, :, 0] > 235) & (pa[:, :, 1] > 235) & (pa[:, :, 2] > 235))
    for k in range(2):
        e = keep.copy()
        e[1:, :] |= keep[:-1, :]; e[:-1, :] |= keep[1:, :]
        e[:, 1:] |= keep[:, :-1]; e[:, :-1] |= keep[:, 1:]
        keep = e
    clean = np.where(np.dstack([keep] * 4), pa, np.zeros_like(pa)).astype(np.uint8)
    im.alpha_composite(Image.fromarray(clean, "RGBA"), (x0 - 3, y0 - 3 + shift))
    return im


EDITS = {"flatMouth": edit_flat_mouth, "questionMark": edit_question_mark,
         "closeEyes": edit_close_eyes, "addLaptop": edit_add_laptop,
         "typingArm": edit_typing_arm, "typingSelf": edit_typing_self,
         "armLayer": edit_arm_layer, "blinkEyes": edit_blink_eyes, "moveMouth": edit_move_mouth}


def main() -> int:
    argv = sys.argv[1:]
    style = "yuexin-miao"
    if "--style" in argv:
        i = argv.index("--style"); style = argv[i + 1]
    dry = "--dry" in argv

    art = ROOT / "pet-art" / style
    # ⚠️ 帧编号用**顺序号 001~057**（见 pet-art/<id>/frames/ 和 seq-map.json）。
    #    旧写法 r{行}c{列} 也认 —— 迁移期两套并存，免得改一半。
    seqmap = {}
    sm = art / "seq-map.json"
    if sm.exists():
        seqmap = json.loads(sm.read_text(encoding="utf-8")).get("map", {})

    def resolve_frame(raw):
        return seqmap.get(raw, raw)

    frames_dir = art / "frames"
    mapping = json.loads((art / "petdex-map.json").read_text(encoding="utf-8"))["map"]
    manifest = json.loads((ROOT / "assets" / style / "manifest.json").read_text(encoding="utf-8"))
    want = {f["logical"]: f["file"] for f in manifest["frames"]}

    dst = ROOT / "assets" / style
    ok, missing = [], []
    for logical, rule in mapping.items():
        if logical not in want:
            missing.append(f"{logical}（manifest 里没有）")
            continue
        src = frames_dir / f"{resolve_frame(rule['frame'])}.png"
        if not src.exists():
            missing.append(f"{logical} → {rule['frame']}（帧不存在）")
            continue
        out = dst / want[logical]
        edit = rule.get("edit")
        tag = f"  [{edit}]" if edit else ""
        print(f"  {logical:12} ← {rule['frame']}{tag:16} {rule.get('note','')}")
        if not dry:
            im = Image.open(src).convert("RGBA")
            # ⚠️ **一个状态可能需要多个改造叠加**（比如"加电脑 + 手臂摆动"）。
            #    原来只认单个 `edit` —— 结果 working 从 addLaptop 改成 typingArm 时
            #    **电脑直接没了**（实测踩到）。
            #    现在 `edits` 数组按顺序全部应用；老的单个 `edit` 仍然兼容。
            seq = rule.get("edits")
            if seq is None and edit:
                seq = [edit]
            for one in (seq or []):
                fn = EDITS.get(one)
                if not fn:
                    print(f"        ⚠️ 不认识的改造: {one}")
                    continue
                arg = (rule.get("editArgs") or {}).get(one, rule.get("editArg"))
                im = fn(im, arg) if arg is not None else fn(im)
            im.save(out)
        ok.append(logical)

    # manifest 里有、映射里没有的状态 → 用 awake 兜底
    for logical in want:
        if logical not in mapping:
            missing.append(f"{logical}（映射里没有，会缺图）")

    print()
    print(f"  ✅ 装配 {len(ok)} 张" + ("（--dry，没落盘）" if dry else ""))
    if missing:
        print(f"  ⚠️  {len(missing)} 个问题：")
        for m in missing:
            print(f"        {m}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
