#!/usr/bin/env python3
"""
bottom_shape.py — 量一张图的**底边够不够平**

为什么要它：做新宠物时，参考图的底边是**一条平直的横线**，
但 AI 经常画成"中间凸起一个小尖"或"中间凹进去一块"。
那是**几何问题，不是风格问题** —— 能量出来，不该靠人一张张看。

踩过的坑：月薪喵第一批 4 张里就有 2 张底边歪了，
而我**自动挑了第一张**没逐张比，是用户对着参考图才发现的。

用法：
    python3 tools/bottom_shape.py              # 查当前启用的那套
    python3 tools/bottom_shape.py --style X    # 查指定的
    python3 tools/bottom_shape.py 图1.png 图2.webp   # 直接查几个文件

输出：每张图底边轮廓的**波动**（占内容高度的百分比）。
      参考图约 3~6%；戳出一个尖或凹进去会到 15% 以上。
"""
import sys
from pathlib import Path

try:
    from PIL import Image
    import numpy as np
except ImportError:
    print("需要 Pillow 和 numpy")
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent


def bottom_wave(path: Path):
    """底边轮廓的波动 ÷ 内容高度。0 = 完全平直。"""
    im = Image.open(path).convert("RGBA")
    a = np.array(im)[:, :, 3] > 40
    ys, xs = np.where(a)
    if len(ys) == 0:
        return None
    top, bottom = ys.min(), ys.max()
    left, right = xs.min(), xs.max()
    H = bottom - top + 1

    # 每一列的"最低不透明像素" = 底边轮廓
    profile = []
    for x in range(left, right + 1):
        col = np.where(a[:, x])[0]
        if len(col):
            profile.append(col.max())
    if len(profile) < 8:
        return None

    # 掐掉两端 10%（圆角本来就会低下去）
    lo = int(len(profile) * 0.10)
    hi = int(len(profile) * 0.90)
    core = np.array(profile[lo:hi])
    return {
        "wave": float(core.max() - core.min()) / H,
        "w": int(right - left + 1),
        "h": int(H),
    }


def main() -> int:
    argv = sys.argv[1:]
    style = "whale-girl"
    if "--style" in argv:
        i = argv.index("--style")
        style = argv[i + 1]
        # ⚠️ 要把 `--style` 和它的值一起摘掉，否则值会被当成文件名 ——
        #    第一版就是这样，报 `No such file or directory: 'yuexin-miao'`。
        argv = argv[:i] + argv[i + 2:]
    args = [a for a in argv if not a.startswith("--")]

    if args:
        files = [Path(a) for a in args]
    else:
        d = ROOT / "assets" / style
        files = sorted(d.glob("*.webp"))
        if not files:
            print(f"⏭️  assets/{style}/ 里没有素材")
            return 0
        print(f"底边检查 · assets/{style}/（{len(files)} 张）\n")

    results = []
    for f in files:
        r = bottom_wave(f)
        if not r:
            print(f"  ⚠️  {f.name}  读不了")
            continue
        results.append((f.name, r))

    if not results:
        return 0

    # 参考：鲸鱼娘那套的底边也不是横线（她是坐姿），所以阈值只用来**排序找异常**
    # ⚠️ **不能定一个绝对阈值。**
    #    第一版用"波动 > 18% 就算歪" —— 结果鲸鱼娘**整套 26 张全被判歪**
    #    （她是坐姿，两只脚本来就一高一低，波动天然 27%）。
    #
    #    改成**同一套内部比**：一套宠物的姿势基调是一致的，
    #    某一张明显比别人高，才是"这张画歪了"。
    vals = sorted(r["wave"] for _, r in results)
    med = vals[len(vals) // 2] if vals else 0

    print()
    for name, r in results:
        flag = ""
        # 比中位数高出一半以上 → 可疑
        if med > 0 and r["wave"] > med * 1.5 and r["wave"] > 0.12:
            flag = "  ⚠️ 比同套其它张明显不齐"
        print(f"  {name:34} 波动 {r['wave']*100:5.1f}%  {r['w']}×{r['h']}{flag}")

    print()
    print(f"  中位数 {med*100:.1f}%   最大 {vals[-1]*100:.1f}%（{max(results, key=lambda x: x[1]['wave'])[0]}）")
    print("  ℹ️  判据是「和同套其它张比」—— 不同宠物的姿势基调不同，")
    print("     定绝对值会把坐姿那套全判歪（实测踩到）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
