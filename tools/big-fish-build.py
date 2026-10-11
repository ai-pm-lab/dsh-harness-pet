#!/usr/bin/env python3
"""Q版大肥鱼 · 装配脚本

## 为什么单独写一个（不直接用 gen-frames.py --process）
因为这个形象的 `working` **不能每帧独立生成** —— 实测过：三帧独立生成时，
桌子、电脑的颜色和大小全不一样（帧间 51~57% 的像素不同），连起来像"换了三个场景"。
而且 `reference_strength` 调高也救不了：它不是真正的图生图，
拿 working_0 当底图改手，构图整个变了（差异 89%）。

所以 working 的做法是：**只生成一张基准帧**，其余帧**从它合成** ——
  · `work1`（打字第 2 帧）＝ 基准帧，把手在键盘上**抬 4px**
  · `work2`（打字第 3 帧）＝ 基准帧，**眼睛闭上**
这样电脑、桌子（没有桌子）、身体、袖子**逐像素完全一致**，只有手和眼睛在动。

其余动作（awake / blink / wave / ready）仍然是每帧独立生成，
它们本来就是不同的姿势，不存在"要一致"的问题。

## 用法
    python3 tools/big-fish-build.py            # 全部
    python3 tools/big-fish-build.py --only awake work0
"""
from __future__ import annotations

import argparse
import glob
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
GEN = ROOT / ".cache" / "gen"
DST = ROOT / "assets" / "big-fish"
CANVAS, CONTENT = 512, 435          # 和别的形象一致：512 画布，内容高 435

# 动作 → (逻辑名, 目标文件名)
MAP = {
    "bfAwake":    ("awake",  "idle_pillow_awake"),
    "bfBlink":    ("blink",  "idle_pillow_blink"),
    "bfWave1":    ("wave1",  "idle_pillow_wave_1"),
    "bfWave2":    ("wave2",  "idle_pillow_wave_2"),
    "bfWorking0": ("work0",  "working_0"),
    # ⚠️ **work1 / work2 故意不生成** —— 见下面 main() 里的说明
    "bfReady0":   ("ready0", "ready_0"),
    "bfReady1":   ("ready1", "ready_1"),
}


def log(m):
    print(m, flush=True)


def newest(action: str) -> Path | None:
    """这个动作**最新生成**的那张原图。

    ⚠️ **必须只匹配 `<action>_*.png>`。**
       一开始写的是"排除 processed 目录"，结果把 `_compare.png`（对比图）
       也当成生成结果选走了 —— 它是最后写盘的，mtime 最新。
       后果很隐蔽：working_0 变成了对比图（三格拼图），
       后面合成的两帧自然全错（帧间差异 58%）。
    """
    fs = glob.glob(str(GEN / action / f"{action}_*.png"))
    return Path(sorted(fs, key=os.path.getmtime)[-1]) if fs else None


def cut_green(im: Image.Image) -> Image.Image:
    """去绿幕。gen-frames 的 process() 也能做，但这里要自己控制归一化尺度。"""
    a = np.array(im.convert("RGBA"))
    g = ((a[:, :, 1].astype(int) > 150)
         & (a[:, :, 1].astype(int) - a[:, :, 0].astype(int) > 60)
         & (a[:, :, 1].astype(int) - a[:, :, 2].astype(int) > 60))
    a[g] = (0, 0, 0, 0)
    return Image.fromarray(a, "RGBA")


def normalize(im: Image.Image) -> Image.Image:
    """内容高统一到 435，居中放进 512 画布。"""
    a = np.array(im)
    ys, xs = np.where(a[:, :, 3] > 40)
    c = im.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
    sc = CONTENT / c.height
    sz = c.resize((max(1, round(c.width * sc)), CONTENT), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(sz, ((CANVAS - sz.width) // 2, (CANVAS - sz.height) // 2))
    return canvas


def save(im: Image.Image, fname: str):
    im.save(DST / f"{fname}.webp", "WEBP", quality=92, method=6)
    log(f"    → {fname}.webp")


# ─────────────────────────── working 的两帧合成 ───────────────────────────

def find_hands(im: Image.Image):
    """在归一化后的帧里找"搭在键盘上的两只手"。

    判据：**皮肤色**（R 明显大于 B、偏亮）并且落在**画面中下部**。
    ⚠️ 不能用"皮肤色"一把抓 —— 脸也是皮肤色。所以按内容高的比例卡一个纵向带：
       实测手在内容高的 42%~58% 一带（键盘那一行），脸在 15%~35%。
    """
    a = np.array(im)
    ys, xs = np.where(a[:, :, 3] > 40)
    top, H = int(ys.min()), int(ys.max() - ys.min() + 1)
    skin = ((a[:, :, 3] > 40)
            & ((a[:, :, 0].astype(int) - a[:, :, 2].astype(int)) > 25)
            & (a[:, :, 0] > 215) & (a[:, :, 1] > 170) & (a[:, :, 0] < 255))
    band = np.zeros_like(skin)
    band[top + int(H * 0.40):top + int(H * 0.60)] = True
    hand = skin & band
    if hand.sum() == 0:
        return None

    # ⚠️ **只保留"最下面那一块"（= 手）**，把下巴/脖子甩掉。
    #    纵向带是按内容高比例卡的（40%~60%），而下巴正好压在上沿 ——
    #    皮肤色分不开"手"和"下巴"，掩码会从下巴一路连到手，
    #    位移之后下巴就跟着动了（用户红框圈出来的就是这里）。
    #    间隙容忍放到 6 行：手内部的小空隙不会把它切成两半，而下巴离手有十几行、能分开。
    rows = np.where(hand.any(axis=1))[0]
    groups, cur = [], [rows[0]]
    for r in rows[1:]:
        if r - cur[-1] <= 6:
            cur.append(r)
        else:
            groups.append(cur); cur = [r]
    groups.append(cur)
    keep_rows = max(groups, key=len)
    keep = np.zeros_like(hand)
    keep[keep_rows[0]:keep_rows[-1] + 1] = True
    hand = hand & keep

    # ⚠️ 试过"按行的连续性切块、只保留最下面那块（=手）" —— 想甩掉误入掩码的下巴。
    #    结果反而在**下巴处留了一块白色缺口**（掩码被切掉后没补上）。
    #    现在退回"整块皮肤色都算手" + **水平就近取色**：
    #    下巴那几行会被邻近的肤色填回去，正常观看尺寸下看不出来。
    #    （正常尺寸 187px 显示时无感；只有放大到 3 倍以上才看得到一点点。）
    hy, hx = np.where(hand)
    if len(hy) == 0:
        return None
    return hand, (int(hx.min()), int(hy.min()), int(hx.max()), int(hy.max()))


def shift_hands(base: Image.Image, dy: int) -> Image.Image:
    """把手在键盘上抬高 dy 像素，其余**逐像素不动**。

    ## ⚠️ 补色必须**按行**（左右），不能按列（上下）
    第一版按列取上下邻居的中位色，结果在**手和袖口交界**的地方留下黑色涂鸦状的纹路
    （用户截图指出来了）—— 因为手的**上方是深蓝袖口**、下方是键盘，
    按列插值会把两种颜色硬拼在一起。
    手是**搭在键盘上**的，左右两边都是键盘/机身的浅灰，**按行取色一定干净**。
    """
    found = find_hands(base)
    if not found:
        log("      ⚠️ 没找到手，返回原图")
        return base
    hand, (x0, y0, x1, y1) = found
    pad = 3
    gx0, gy0 = max(0, x0 - pad), max(0, y0 - pad)
    gx1, gy1 = min(base.width, x1 + pad + 1), min(base.height, y1 + pad + 1)

    arr = np.array(base)
    m = hand[gy0:gy1, gx0:gx1].copy()
    for _ in range(2):                      # 膨胀，带走抗锯齿的边
        e = m.copy()
        e[1:, :] |= m[:-1, :]; e[:-1, :] |= m[1:, :]
        e[:, 1:] |= m[:, :-1]; e[:, :-1] |= m[:, 1:]
        m = e

    patch = arr[gy0:gy1, gx0:gx1].copy()
    region = arr[gy0:gy1, gx0:gx1]

    # ── 补色：**水平方向"就近取色"**（最近的非手像素）──
    # ⚠️ 试过四种，前三种都翻车：
    #   ① 按列取上下邻居 → 上方是深蓝袖口，硬拼成黑色涂鸦（用户报过"异常纹路"）
    #   ② 按行取左右中位色 → 手碰到袖子的那些行，把深色横着抹过去，留一条浅带
    #   ③ 取"正下方"的像素（想当然觉得下面是键盘）→ 掩码把**下巴**也圈进来了，
    #      往下一填成了一条白色竖柱（更糟）
    # ✅ 就近取色：每个被盖住的像素，取**同一行里左右最近的那个非手像素**。
    #    键盘那一段就填键盘色、袖口那一段就填袖口色，局部颜色不被抹平。
    for ry in range(m.shape[0]):
        row = np.where(m[ry])[0]
        if len(row) == 0:
            continue
        l, r = int(row.min()), int(row.max())
        for cx in range(l, r + 1):
            if not m[ry, cx]:
                continue
            src = None
            for d_ in range(1, region.shape[1]):      # 左右同时向外找
                a1 = cx - d_
                a2 = cx + d_
                if a1 >= 0 and region[ry, a1, 3] > 200 and not m[ry, a1]:
                    src = region[ry, a1]; break
                if a2 < region.shape[1] and region[ry, a2, 3] > 200 and not m[ry, a2]:
                    src = region[ry, a2]; break
            if src is not None:
                region[ry, cx] = src
    arr[gy0:gy1, gx0:gx1] = region
    base = Image.fromarray(arr, "RGBA")

    # 贴回去：**整块贴，连描边一起**。
    # ⚠️ 第一版只贴"皮肤色"的像素，手的**描边（线稿）没跟过去**，
    #    边缘全是锯齿（用户红框圈出来了）。
    #    整块贴的顾虑是"会带一块长方形背景过去" ——
    #    但手底下就是键盘，**和原位是同一台键盘**，贴过去看不出来。
    # ⚠️ `alpha_composite` 要求**源完全落在目标内**，越界会抛
    #    `TypeError: can only concatenate tuple (not "int") to tuple`（PIL 内部的怪报错）。
    #    手抬高之后贴回去的位置可能超出上边界，所以这里先裁一刀。
    # ⚠️ `patch` 上面是 **numpy 数组**（`arr[...]`），不是 PIL 图 ——
    #    直接用 `.size[0]` 会报 `'int' object is not subscriptable`（numpy 的 size 是元素个数）。
    #    这里转成 PIL 图再贴。
    patch_img = Image.fromarray(patch, "RGBA")
    px, py = gx0, gy0 - dy
    sx0 = max(0, -px); sy0 = max(0, -py)
    sx1 = patch_img.size[0] - max(0, px + patch_img.size[0] - base.size[0])
    sy1 = patch_img.size[1] - max(0, py + patch_img.size[1] - base.size[1])
    if sx1 > sx0 and sy1 > sy0:
        base.alpha_composite(patch_img.crop((sx0, sy0, sx1, sy1)), (px + sx0, py + sy0))
    return base


def face_box(im: Image.Image):
    """脸（皮肤色）的包围盒 —— 用来把两张图**对齐**。

    ⚠️ 不能用"整张图的包围盒"对齐：基准帧是站着打字、闭眼那张是手放下的，
       两者的整体轮廓差很多；**但脸一定在同一个相对位置**。
    """
    a = np.array(im)
    op = a[:, :, 3] > 40
    ys, xs = np.where(op)
    top, H = int(ys.min()), int(ys.max() - ys.min() + 1)
    skin = (op
            & ((a[:, :, 0].astype(int) - a[:, :, 2].astype(int)) > 30)
            & (a[:, :, 0] > 225) & (a[:, :, 1] > 190))
    skin[:top + int(H * 0.10)] = False          # 甩掉头发高光/蕾丝的干扰
    skin[top + int(H * 0.55):] = False          # 只要上半部分（脸在那里）
    sy, sx = np.where(skin)
    if len(sy) == 0:
        return None
    return int(sx.min()), int(sy.min()), int(sx.max()), int(sy.max())


def eye_box(im: Image.Image):
    """**左右两只眼睛各自的**包围盒。

    ## ⚠️ 为什么必须分成两个（一个盒子会同时犯两个错）
    一开始返回的是「两只眼睛合成一个大盒子」，贴片也就是**一个横跨整脸的大椭圆**：
      · **顶部不够高** → 右眼上方残留一点睁眼的睫毛/虹膜（用户红框圈出）
      · **底部太低**   → 这个 Q 版角色眼睛特别大、下缘几乎贴到下巴线，
                          椭圆底部把**下巴的轮廓线**也盖住 → 两条线重影（用户红框圈出）
    **一个椭圆同时满足「上方够高」和「下方不碰下巴」是做不到的** ——
    两只眼睛的高度本来就不一样（实测左眼 y 158..215、右眼 y 156..212）。
    分成两个盒子、各贴各的，两边都能贴紧自己的眼睛。
    """
    a = np.array(im)
    op = a[:, :, 3] > 40
    ys, xs = np.where(op)
    top, H = int(ys.min()), int(ys.max() - ys.min() + 1)
    band = np.zeros_like(op)
    band[top + int(H * 0.29):top + int(H * 0.41)] = True
    eye = (op & band & (a[:, :, 2] > 170)
           & ((a[:, :, 2].astype(int) - a[:, :, 0].astype(int)) > 60)
           & (a[:, :, 1] > 120))
    ey, ex = np.where(eye)
    if len(ey) == 0:
        return None
    mid = (int(ex.min()) + int(ex.max())) // 2
    boxes = []
    for is_left in (True, False):
        sel = (ex <= mid) if is_left else (ex > mid)
        if sel.sum() < 30:
            continue
        sx, sy = ex[sel], ey[sel]
        lo, hi = int(sx.min()), int(sx.max())
        hist = np.zeros(hi - lo + 1, dtype=int)
        for v in sx:
            hist[v - lo] += 1
        keep = np.where(hist >= max(3, hist.max() * 0.25))[0]
        a0, b0 = lo + int(keep.min()), lo + int(keep.max())
        m = (sx >= a0) & (sx <= b0)
        boxes.append((a0, int(sy[m].min()), b0, int(sy[m].max())))
    return boxes if len(boxes) == 2 else None




def close_eyes_from(base: Image.Image, donor: Image.Image) -> Image.Image:
    """把 `donor`（AI 生成的闭眼脸）里**眼睛那一小块**贴到 `base` 上。

    ## 为什么这么做（用户提的方案）
    自己画两条横杠（前两版）怎么看都假 —— 位置、弧度、和睫毛的衔接都不对。
    用户建议「**结合原始素材，通过生图模型重新生成闭眼的脸部**」。
    于是：让模型单独出一张**闭眼的脸**，再用**脸的位置**把两张图对齐，
    只把眼睛那一小块搬过来 —— 这样闭眼是**模型画的**（自然），
    身体/衣服/电脑又是**基准帧的**（逐像素一致）。

    对齐用**脸的包围盒**，不用整张图的包围盒：
    基准帧在打字、donor 的手是放下的，整体轮廓差很多，但脸的位置是对应的。
    """
    ebs = eye_box(base)
    fb, fd = face_box(base), face_box(donor)
    if ebs is None or fb is None or fd is None:
        log("      ⚠️ 对齐失败，返回原图")
        return base

    # 用脸的宽度把 donor 的坐标系缩放到 base 的
    fw_b, fw_d = fb[2] - fb[0] + 1, fd[2] - fd[0] + 1
    fh_b, fh_d = fb[3] - fb[1] + 1, fd[3] - fd[1] + 1
    sc = ((fw_b / fw_d) + (fh_b / fh_d)) / 2
    cb = ((fb[0] + fb[2]) / 2, (fb[1] + fb[3]) / 2)
    cd = ((fd[0] + fd[2]) / 2, (fd[1] + fd[3]) / 2)

    # ⚠️ **逐眼贴**（左眼、右眼各一次）。
    #    用一个横跨整脸的大椭圆会同时犯两个错：顶部不够高（残留睁眼）、
    #    底部太低（盖住下巴轮廓线 → 双线重影）。
    for eb in ebs:
        base = _paste_one_eye(base, donor, eb, sc, cb, cd)
    return base


def _paste_one_eye(base, donor, eb, sc, cb, cd):
    """贴**一只**眼睛。"""
    # ⚠️ 余量：**太小会漏出原来的眼睛**（用户报"闭眼显示出了睁眼的部分眼睛"），
    #    太大又会盖住刘海和脸颊（之前报"发丝不协调、下颌线没了"）。
    #    横向 4px、上 3px、下 1px —— 下面收窄是因为**眼睛下缘离下巴线很近**，
    #    多留一点就会把下巴的轮廓线一起盖掉（双线重影，用户圈出来过）。
    pad_x, pad_top, pad_bot = 4, 3, 1
    x0, y0 = max(0, eb[0] - pad_x), max(0, eb[1] - pad_top)
    x1, y1 = min(base.width, eb[2] + pad_x + 1), min(base.height, eb[3] + pad_bot + 1)
    cx_b, cy_b = cb
    cx_d, cy_d = cd
    dx0 = cx_d + (x0 - cx_b) * sc
    dy0 = cy_d + (y0 - cy_b) * sc
    dx1 = cx_d + (x1 - cx_b) * sc
    dy1 = cy_d + (y1 - cy_b) * sc

    # ⚠️ **裁框要放大一点，让贴进去的内容缩小。**
    #    用半透明叠加比对（用户的办法）量出来：donor 的闭眼弧线
    #    比原图的虹膜**宽 15%** —— 闭眼本来就画得比虹膜长，
    #    而 donor 又画在稍大的脸上。直接贴的话弧线两端会伸到虹膜外面。
    #    → 裁框放大 SHRINK 倍、再缩到目标尺寸，内容就等效缩小 ~15%；
    #      原虹膜的外缘由 donor 的**皮肤**盖住，弧线变小落在里面。
    SHRINK = 1.35
    kcx, kcy = (dx0 + dx1) / 2, (dy0 + dy1) / 2
    hw, hh = (dx1 - dx0) / 2 * SHRINK, (dy1 - dy0) / 2 * SHRINK
    cx0, cy0 = int(round(kcx - hw)), int(round(kcy - hh))
    patch = donor.crop((cx0, cy0,
                        cx0 + max(1, int(round(hw * 2))),
                        cy0 + max(1, int(round(hh * 2)))))
    patch = patch.resize((x1 - x0, y1 - y0), Image.LANCZOS)

    # ⚠️ 贴的时候**只取"眼睛那一块"** —— 用一个椭圆羽化边，
    #    不然会看到一块方形的接缝
    # ⚠️ 椭圆**往里缩**，不要贴着矩形四边。
    #    贴边时椭圆的四个角会伸进**刘海**和**脸颊**，
    #    把两侧发丝染成 donor 的浅色、下颌线也糊掉（用户看出来了）。
    #    内缩之后只覆盖"眼睛本身"，刘海、脸型、轮廓线一个像素都不动。
    mx = max(2, int(patch.size[0] * 0.04))
    my = max(1, int(patch.size[1] * 0.07))
    mask = Image.new("L", patch.size, 0)
    ImageDraw.Draw(mask).ellipse([mx, my, patch.size[0] - 1 - mx, patch.size[1] - 1 - my],
                                 fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(1.2))

    # ⚠️ **不要做"整块亮度对齐"。**
    #    试过：把贴片的平均色对齐到基准帧同区域的平均色。结果是**整块变暗** ——
    #    因为这个椭圆里**含深色头发**，均值被头发拉偏，补偿方向就错了。
    #    如果以后还要做，必须**只统计皮肤色像素**，不能整块平均。
    #    现阶段两张图光照本来就接近，直接贴已经看不出接缝。
    base.paste(patch, (x0, y0), mask)
    log(f"      眼睛块 {x1-x0}×{y1-y0} @({x0},{y0})  从闭眼图对齐后贴入（缩放 {sc:.3f}）")
    return base


# ─────────────────────────── 主流程 ───────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", help="只处理这些逻辑名（awake/work0/…）")
    a = ap.parse_args()
    DST.mkdir(parents=True, exist_ok=True)

    frame_cache = {}
    for action, (logical, fname) in MAP.items():
        if a.only and logical not in a.only:
            continue
        src = newest(action)
        if not src:
            log(f"  ❌ {action}: 没找到生成的图")
            continue
        log(f"  {action}  ← {src.name}")
        im = normalize(cut_green(Image.open(src)))
        frame_cache[logical] = im
        save(im, fname)

    # ── working 的其余两帧：从 work0 合成 ──
    if (not a.only or "work1" in a.only or "work2" in a.only) and "work0" in frame_cache:
        base = frame_cache["work0"]
        # ⚠️ **work1（手抬）和 work2（闭眼）都不生成了。**
        #    这两张都是"从 work0 局部替换"来的，而实测这个角色的
        #    **手压在键盘上、上面又盖着刘海和袖口、眼睛大得贴着下巴线** ——
        #    局部替换试过 7 种做法都会留下肉眼可见的痕（详见 git log）。
        #    pet.js 的 `workingCycle()` 在 `work2` 加载不到时，会自动用
        #    **单帧 work0 + offsetY [0,-3,0,-2,0,1]** 做"敲键盘"的小节奏 ——
        #    整帧一起浮动，**数学上不可能有接缝**。月薪喵走的就是这条路。
        if a.only and ("work1" in a.only or "work2" in a.only):
            log("  ⏭️  work1/work2 已停用（改用 workingCycle 的单帧 + offsetY 方案）")
        if False:  # 已停用，见上
            donor_src = newest("bfFaceClosed")
            if donor_src:
                log("  work2  ＝ work0 + 从「闭眼的脸」搬眼睛块（合成）")
                donor = normalize(cut_green(Image.open(donor_src)))
                save(close_eyes_from(base.copy(), donor), "working_1")
            else:
                log("  ⚠️ 没有 bfFaceClosed，跳过 work2")

    log("\n  ✅ 装配完成")


if __name__ == "__main__":
    main()
