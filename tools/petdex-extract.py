#!/usr/bin/env python3
"""
petdex-extract.py — 把 Petdex #2981「月薪喵」的 sprite sheet 拆成可用的帧

**为什么要这么做**（用户指出的方向）：
    AI 生成一直在"风格漂移" —— 每张都要重新描述角色长什么样，
    而文字描述永远不如**原图本身**准。
    这套 sprite sheet 里有 57 张现成的帧，覆盖站立/侧身/趴睡/压扁/手举到脸边……
    **直接拿来用，形象 100% 一致。**

**怎么用**：
    ① 拆帧 + 放大到目标尺寸
    ② 量每帧的特征（耳朵张开度、眼睛状态、有没有手）
    ③ 生成索引表，供"选帧 → 装配动作"用

⚠️ **放大用 LANCZOS，不做调色板吸附** ——
   试过吸附到 8 色主调色板，结果**把蓝色眼睛吸成了棕色**
   （蓝只占很小面积，挤不进前 8 名）。LANCZOS 直接放大就很干净。

⚠️ 版权：Petdex 页面注明 "Pets are user-submitted fan art.
   Petdex does not claim rights to any underlying IP."
   月薪喵这个角色本身是别人的 IP，这里当**参考/素材基础**使用。

用法：
    python3 tools/petdex-extract.py                      # 拆全部
    python3 tools/petdex-extract.py --report             # 只看索引表
"""
import json
import sys
from pathlib import Path

try:
    from PIL import Image
    import numpy as np
except ImportError:
    print("需要 Pillow 和 numpy")
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent
SHEET = ROOT / "pet-art" / "yuexin-miao" / "_reference-petdex.webp"
OUT = ROOT / "pet-art" / "yuexin-miao" / "petdex-frames"
COLS, ROWS = 8, 9
CANVAS = 512
CONTENT_H = 0.85


def features(im: Image.Image) -> dict:
    """量一帧的特征，用来判断它适合哪个动作。"""
    a = np.array(im)[:, :, 3] > 40
    ys, xs = np.where(a)
    if len(ys) == 0:
        return {}
    top, bottom = int(ys.min()), int(ys.max())
    H = bottom - top + 1

    def width_at(frac):
        y = min(bottom, top + int(H * frac))
        row = np.where(a[y])[0]
        return float(row.max() - row.min() + 1) / H if len(row) else 0.0

    rgb = np.array(im.convert("RGB")).astype(int)
    # 蓝色眼睛的像素
    blue = (rgb[:, :, 2] > 110) & (rgb[:, :, 2] - rgb[:, :, 0] > 40) & (rgb[:, :, 1] < 140)
    # 米棕色（耳朵/尾巴/手）
    tan = (rgb[:, :, 0] > 170) & (rgb[:, :, 0] < 240) & (rgb[:, :, 1] > 140) & \
          (rgb[:, :, 1] < 210) & (rgb[:, :, 2] < 190) & (rgb[:, :, 0] - rgb[:, :, 2] > 30)
    total = max(1, int(a.sum()))
    return {
        "earSpread": round(width_at(0.18), 3),
        "maxWidth": round(max(width_at(f) for f in np.arange(0.1, 0.95, 0.05)), 3),
        "aspect": round((xs.max() - xs.min() + 1) / H, 3),
        "bluePct": round(float(blue.sum()) / total, 4),      # 眼睛（睁着才有）
        "tanPct": round(float(tan.sum()) / total, 4),
        "h": H,
    }


def main() -> int:
    sheet = Image.open(SHEET).convert("RGBA")
    CW, CH = sheet.width // COLS, sheet.height // ROWS
    report_only = "--report" in sys.argv

    catalog = []
    if not report_only:
        OUT.mkdir(parents=True, exist_ok=True)

    for r in range(ROWS):
        for c in range(COLS):
            cell = sheet.crop((c * CW, r * CH, (c + 1) * CW, (r + 1) * CH))
            a = np.array(cell)[:, :, 3] > 40
            ys, xs = np.where(a)
            if len(ys) < 50:
                continue                       # 空格子
            content = cell.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
            feat = features(content)
            name = f"r{r}c{c}"
            catalog.append({"name": name, "row": r, "col": c, **feat})

            if not report_only:
                # LANCZOS 放大到内容高 = 画布 85%，居中
                scale = (CANVAS * CONTENT_H) / content.height
                big = content.resize((max(1, round(content.width * scale)),
                                      round(CANVAS * CONTENT_H)), Image.LANCZOS)
                canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
                canvas.alpha_composite(big, ((CANVAS - big.width) // 2,
                                             (CANVAS - big.height) // 2))
                canvas.save(OUT / f"{name}.png")

    if not report_only:
        (OUT / "catalog.json").write_text(
            json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"  ✅ 拆出 {len(catalog)} 帧 → {OUT.relative_to(ROOT)}/")
        print(f"     每帧 {CANVAS}×{CANVAS}（内容高 {int(CANVAS*CONTENT_H)}px）")

    # ── 索引表 ──
    print()
    print("  行  帧名        耳朵张开  最宽   蓝眼占比  米棕占比   能用来做什么")
    print("  " + "─" * 78)
    HINT = {
        0: "站立呼吸（手在身侧）",
        1: "手在身前 / 侧身",
        2: "手在身前 / 走动",
        3: "站立、手略张",
        4: "手明确露在两侧",
        5: "趴着睡 → 翻身",
        6: "压扁（像煎饼）",
        7: "站立、手在两侧",
        8: "手举到脸边 / 放肚子上",
    }
    last_row = -1
    for f in catalog:
        if f["row"] != last_row:
            print(f"  ── 行{f['row']}：{HINT.get(f['row'], '')} ──")
            last_row = f["row"]
        eye = "睁" if f["bluePct"] > 0.004 else "闭/无"
        print(f"      {f['name']:8}  {f['earSpread']*100:6.1f}%  {f['maxWidth']*100:5.1f}%"
              f"   {f['bluePct']*100:5.2f}%   {f['tanPct']*100:5.1f}%    {eye}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
