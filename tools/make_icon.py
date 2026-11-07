#!/usr/bin/env python3
"""
make_icon.py — 生成 macOS 的 App 图标（AppIcon.icns）

⚠️⚠️ **图标必须「撑满画布」—— 这是 macOS 26 之后的硬要求，别改回去。**

    macOS 26（Tahoe）起，Apple 只接受「超级圆（squircle）」形状的 App 图标。
    **不合规的图标会被系统自动缩小、再放到一块浅灰底板上** ——
    社区里叫它「图标监狱」（Icon-Gefängnis）。
    实测表现：搜索结果 / 安装包窗口里，图标变成「灰板里嵌一个明显更小的蓝块」，
    而 Dock 里因为走的是运行时 `app.dock.setIcon()`，看起来又是另一个样子。

    我们的图原来 `MARGIN = 76`（Big Sur 老规范"给系统边框留位置"），
    内容只占画布的 85% —— **形状"不顶格"，正好被判不合规**。
    改成 0（内容撑满 1024×1024）之后，系统那层超级圆蒙版直接套上去就是完整形状，
    图标立刻正常（用户已实测：Dock / 搜索 / dmg 窗口三处都好了）。

    相关：https://t3n.de/news/macos-tahoe-icons-1711049/
    （Apple 官方：用 Icon Composer 生成图标 ——
     https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer）

为什么需要单独生成，不能直接拿 launcher.webp 转：

    launcher 画布 512×512，角色包围盒只有 181×224（占 35% × 44%），
    四周全是透明留白。直接转成 icns 的话，Dock 里就是一个小人站在
    一大片空白中间 —— 这正是之前的问题。

macOS 图标的几何（Big Sur 之后的设计规范）：

    1024×1024 画布
    ├─ 100px 外边距
    └─ 824×824 圆角矩形（圆角半径约 185，即边长的 22.5%）
       角色再往里收一些，占圆角矩形的 ~78%

用法：
    python3 tools/make_icon.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "launcher.webp"

# 两个去处，用途不同：
#   build/          → 给 electron-builder 打包用（正式发布）
#   *.app/Contents/ → 开发时双击运行的那个 .app 壳（不是发布方式）
BUILD = ROOT / "build"
# ⚠️ 开发用的壳 2026-10-06 改名并移进了 .dev/ —— 见 README「日常启动」。
#    它现在**藏在点开头的目录里**，Spotlight 不会索引它，所以不会再出现
#    「搜索里两个同名图标」的问题。
#
#    ⚠️ **别把这里改回仓库根目录的 `胖头鱼.app`** —— 那样跑一次这个脚本
#       就会重新建出一个同名 bundle，搜索里又会多一个图标（实测被用户抓到过）。
SHELL_ICNS = ROOT / ".dev" / "胖头鱼（开发版）.app" / "Contents" / "Resources" / "AppIcon.icns"
ICNS = BUILD / "icon.icns"

# 下面这组数字是从系统自带 App 的图标里**量出来的**，不是查文档猜的：
#
#     Base64 /System/Applications/Calculator.app/.../AppIcon.icns
#       → 画布 256px，不透明区 218px，外边距 19px，圆角半径 48px
#
# 换算到 1024 画布就是：外边距 76px、底板 872px、圆角 192px。
#
# ⚠️ 一开始用的是 100px 外边距（苹果规范的常见说法），结果程序坞里
# **图标外面多出一圈灰白底板** —— 因为图标比规范小了一圈，
# macOS 就自己补了一个底。所以这里严格对齐实测值。
CANVAS = 1024
# ⚠️⚠️ **必须是 0 —— 不要改回 76。**
#
# 原来这里是 76（"给系统边框留位置"，Big Sur 时代的老规范），
# 底板因此只有 872×872 = 画布的 85%。
#
# 但 **macOS 27 会给每个 app 的图标外面再套一层系统自己的圆角板**
# （实测：VSCode / DeepSeek Harness / 计算器外面都有一圈浅灰边，
#  只是它们的图**撑满了**画布，所以看不出来）。
#
# 我们的图只占 85% → 系统再套一层 → 就变成「**板中板**」：
# 一个灰色圆角板里嵌着一个明显更小的蓝色方块，看起来像"图标没做好"。
# （用户在搜索结果和安装包窗口里看到的就是这个，实测排查了很久。）
#
# 改成 0 之后，我们的图撑满画布，系统那层板只剩一圈几乎看不见的细边。
MARGIN = 0
PLATE = CANVAS - MARGIN * 2      # 1024
RADIUS = int(PLATE * 0.22)       # 实测：48/218 ≈ 22%
ART_FILL = 0.78                  # 角色占底板的比例

# 背景渐变：取角色的发色到深藏青，比纯白底更像"一个 App"而不是"一张图"
TOP = (90, 160, 240)
BOTTOM = (26, 58, 122)


def load_art() -> Image.Image:
    """载入角色并裁到不透明包围盒 —— 不留原始画布的空白。"""
    im = Image.open(SRC).convert("RGBA")
    alpha = np.array(im)[:, :, 3]
    ys, xs = np.where(alpha > 24)
    if xs.size == 0:
        raise SystemExit(f"{SRC} 里没有不透明像素")
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    print(f"  角色包围盒 {box[2]-box[0]}×{box[3]-box[1]}（原画布 {im.width}×{im.height}）")
    return im.crop(box)


def gradient_plate() -> Image.Image:
    """画 macOS 风格的圆角底板，带垂直渐变。"""
    plate = Image.new("RGBA", (PLATE, PLATE), (0, 0, 0, 0))

    # 先做渐变，再用圆角矩形当遮罩裁出来
    grad = Image.new("RGB", (1, PLATE))
    for y in range(PLATE):
        t = y / (PLATE - 1)
        grad.putpixel((0, y), tuple(
            round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)
        ))
    grad = grad.resize((PLATE, PLATE), Image.BILINEAR).convert("RGBA")

    mask = Image.new("L", (PLATE, PLATE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, PLATE - 1, PLATE - 1],
                                           radius=RADIUS, fill=255)
    plate.paste(grad, (0, 0), mask)
    return plate


def build_master() -> Image.Image:
    art = load_art()
    plate = gradient_plate()

    # 角色按最大边缩放到占底板的 ART_FILL
    target = int(PLATE * ART_FILL)
    scale = min(target / art.width, target / art.height)
    size = (max(1, round(art.width * scale)), max(1, round(art.height * scale)))
    art = art.resize(size, Image.LANCZOS)
    print(f"  缩放后 {size[0]}×{size[1]}（占底板 {size[0]/PLATE*100:.0f}% × {size[1]/PLATE*100:.0f}%）")

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(plate, (MARGIN, MARGIN), plate)

    # 角色放在底板里略微偏下 —— 视觉重心比几何中心低一点更稳
    px = MARGIN + (PLATE - size[0]) // 2
    py = MARGIN + (PLATE - size[1]) // 2 + int(PLATE * 0.03)
    canvas.paste(art, (px, py), art)
    return canvas


def main() -> int:
    if not SRC.exists():
        print(f"❌ 找不到 {SRC}")
        return 1

    print("生成 App 图标")
    master = build_master()

    # iconset 需要这一组尺寸，少一个 iconutil 就会报错
    specs = [
        (16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2),
        (256, 1), (256, 2), (512, 1), (512, 2),
    ]

    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "AppIcon.iconset"
        iconset.mkdir()
        for base, scale in specs:
            px = base * scale
            suffix = "" if scale == 1 else "@2x"
            master.resize((px, px), Image.LANCZOS).save(iconset / f"icon_{base}x{base}{suffix}.png")

        ICNS.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(ICNS)],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            print("❌ iconutil 失败:", result.stderr.strip())
            return 1

    size_kb = ICNS.stat().st_size / 1024
    print(f"✅ {ICNS.relative_to(ROOT)}  ({size_kb:.0f} KB)")

    # ── 打包用的一套（electron-builder 各平台要的东西）──
    #
    # .ico 用 Pillow 直接生成，**不需要 iconutil** —— iconutil 是 macOS 专有的，
    # 而我们在 macOS 上就得把 Windows 的图标一起产出，不然做 Windows 版时
    # 还得回头补。
    BUILD.mkdir(exist_ok=True)
    # ⚠️ **显式刷新时间戳。** iconutil 写出来的文件如果内容没变，
    #    某些情况下 mtime 也可能不变 —— 而图标缓存按 (路径, mtime) 做 key，
    #    不刷新就等于"新图标没生效"（实测踩到）。
    os.utime(ICNS, None)
    print(f"   {str(ICNS.relative_to(ROOT))}（macOS 打包用）")
    # 开发用的壳也同步一份 —— 它在 .dev/ 里，可能不存在（比如没 checkout 全）
    if SHELL_ICNS.parent.is_dir():
        # ⚠️ **用 copyfile 不用 copy2。**
        # copy2 会连 mtime 一起复制，于是"重新生成图标"之后
        # build/icon.icns 的时间戳还是旧的 —— 而 macOS 的图标缓存
        # **正是按 (路径, mtime) 做 key 的**，时间戳不变 = 系统继续用缓存的旧图。
        # 实测：重新打包、重新安装之后，Finder 里显示的仍然是旧图标。
        shutil.copyfile(ICNS, SHELL_ICNS)
        os.utime(SHELL_ICNS, None)
        print(f"   {str(SHELL_ICNS.relative_to(ROOT))}（开发壳用）")
    else:
        print(f"   （跳过开发壳：{SHELL_ICNS.parent.relative_to(ROOT)} 不存在）")

    master.resize((512, 512), Image.LANCZOS).save(BUILD / "icon.png")
    print(f"   {str((BUILD / 'icon.png').relative_to(ROOT))}（Linux 打包用）")

    # .ico 里塞多个尺寸 —— Windows 在不同位置（任务栏 16、桌面 48、资源管理器 256）
    # 会取不同大小，只放一张会糊。
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master.save(BUILD / "icon.ico", sizes=ico_sizes)
    ico_kb = (BUILD / "icon.ico").stat().st_size / 1024
    print(f"   {str((BUILD / 'icon.ico').relative_to(ROOT))}"
          f"（Windows 打包用，{len(ico_sizes)} 个尺寸，{ico_kb:.0f} KB）")

    # 导出一张 PNG：Electron 的 app.dock.setIcon() 不认 .icns，只认位图。
    # 我们的 .app 只是个壳、真正跑的是 Electron.app，所以程序坞图标
    # 必须在运行时显式覆盖，否则显示的是 Electron 自己的图标。
    dock_png = ROOT / "assets" / "icon-512.png"
    master.resize((512, 512), Image.LANCZOS).save(dock_png)
    print(f"   {dock_png.relative_to(ROOT)}（给 app.dock.setIcon 用）")

    # 顺带导出一张预览图，方便肉眼确认
    preview = ROOT / ".verify" / "icon-preview.png"
    preview.parent.mkdir(exist_ok=True)
    # 每个尺寸一个格子，格子边长按最大尺寸固定，小图标居中放
    CELL, GAP = 256, 20
    scales = [256, 128, 64, 32]
    width = GAP + len(scales) * (CELL + GAP)
    strip = Image.new("RGB", (width, CELL + GAP * 2), (245, 246, 248))
    x = GAP
    for px in scales:
        cell = Image.new("RGB", (CELL, CELL), (245, 246, 248))
        scaled = master.resize((px, px), Image.LANCZOS)
        cell.paste(scaled, ((CELL - px) // 2, (CELL - px) // 2), scaled)
        strip.paste(cell, (x, GAP))
        x += CELL + GAP
    strip.save(preview)
    print(f"   预览图 {preview.relative_to(ROOT)}（256 / 128 / 64 / 32 px 下的样子）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
