#!/usr/bin/env python3
"""
silhouette.py — 量一张图的**轮廓比例**，用来对参考图

为什么要它：AI 生成时**比例**最容易跑偏，而且靠眼睛看容易漏 ——
月薪喵第一批就踩了两次：
  · 底边画歪（中间凸起/凹进）—— 用户对着参考图指出来
  · **耳朵画成大翅膀**（头顶宽度占内容高 93%，参考图只有 65%）
    —— 而且我"只看底边"就把对的候选换成了错的

比例是**几何量**，能量出来。所以对参考图量几个关键比例，
生成后逐张比 —— 比"我看了一眼觉得还行"可靠。

用法：
    python3 tools/silhouette.py --ref pet-art/yuexin-miao/_reference.png
    python3 tools/silhouette.py --style yuexin-miao
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


def profile(path: Path):
    """量一张图的轮廓比例。"""
    im = Image.open(path).convert("RGBA")
    a = np.array(im)[:, :, 3] > 40
    ys, xs = np.where(a)
    if len(ys) == 0:
        return None
    top, bottom = int(ys.min()), int(ys.max())
    H = bottom - top + 1

    def width_at(frac: float) -> float:
        y = min(bottom, top + int(H * frac))
        row = np.where(a[y])[0]
        return (row.max() - row.min() + 1) / H if len(row) else 0.0

    return {
        # 头顶 18% 处 = 耳朵张开程度。参考图 ≈ 0.65
        "earSpread": width_at(0.18),
        # 最宽处 / 高（整体胖瘦）
        "maxWidth": max(
            (np.where(a[y])[0].max() - np.where(a[y])[0].min() + 1) / H
            for y in range(top, bottom + 1) if a[y].any()
        ),
        "h": H,
    }


def main() -> int:
    argv = sys.argv[1:]
    ref = None
    if "--ref" in argv:
        i = argv.index("--ref")
        ref = Path(argv[i + 1])
        argv = argv[:i] + argv[i + 2:]
    style = None
    if "--style" in argv:
        i = argv.index("--style")
        style = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]

    files = [Path(a) for a in argv if not a.startswith("--")]
    if not files and style:
        files = sorted((ROOT / "assets" / style).glob("*.webp"))

    baseline = profile(ref) if ref and ref.exists() else None
    if baseline:
        print(f"参考图 {ref.name}:  耳朵张开 {baseline['earSpread']*100:.0f}%   "
              f"最宽 {baseline['maxWidth']*100:.0f}%   高 {baseline['h']}px\n")

    if not files:
        print("⚠️  没有要检查的图。用法见文件头注释。")
        return 0

    bad = []
    for f in files:
        r = profile(f)
        if not r:
            print(f"  ⚠️  {f.name} 读不了")
            continue
        flag = ""
        if baseline:
            # 耳朵张开度差 15 个百分点以上就算跑偏
            d = abs(r["earSpread"] - baseline["earSpread"])
            if d > 0.15:
                flag = f"  ⚠️ 耳朵张开度差 {d*100:.0f} 个点"
                bad.append(f.name)
        print(f"  {f.name:34} 耳朵张开 {r['earSpread']*100:5.1f}%  "
              f"最宽 {r['maxWidth']*100:5.1f}%   高 {r['h']}{flag}")

    # ⚠️ **有些动作本来就会改变轮廓** —— 不能一刀切。
    #    实测踩到：`sleep`（侧躺）和 `startle`（手举起来）被这个检查判成"偏离"，
    #    但它们**是对的** —— 姿势变了，轮廓当然跟着变。
    #    所以给一份"允许偏离"的白名单；只有**姿态应该和站立一致**的那些才严格比。
    EXEMPT = {
        'sleep', 'drowsy', 'stretch', 'startle', 'angryBlock', 'blocked',
        'ready1', 'ready2', 'ready3', 'wave1', 'wave2', 'eat',
    }
    real = [n for n in bad if not any(n.startswith(e) or e in n for e in EXEMPT)]
    if bad and real:
        print(f"\n  ❌ {len(real)} 张的轮廓比例明显偏离参考图：{', '.join(real)}")
        print("     提示词里已有「耳朵（强制）…约 65%」的量化约束，重新生成这几张。")
        return 1
    if bad:
        print(f"\n  ℹ️  {len(bad)} 张偏离参考图（{', '.join(bad)}）—— 但它们是**改变姿势的动作**"
              f"（侧躺/举手/拉长），轮廓本来就该变，**不算问题**。")
    print("\n  ✅ 轮廓比例都对得上")
    return 0


if __name__ == "__main__":
    sys.exit(main())
