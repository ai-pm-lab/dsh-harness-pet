#!/usr/bin/env python3
"""
make_variant.py — 从现有形象派生一个新形象（改配色）

⚠️ **这是用来验证"形象切换"机制的，不是一套真正的新素材。**

作者要的三种形象是「Q版鲸鱼娘 / 精致版鲸鱼娘 / 像素鲸鱼」，
那需要真的画三套。在素材到位之前，这个脚本用**调色**造一个衍生版本，
好让切换功能可以被实际点一下验证，而不是只能看代码。

⚠️ **现状：派生出来的 `assets/whale-girl-night/` 已经删掉了。**
它只是用来验证"多形象切换"机制能用，不是真素材 ——
需求 3（Q版 / 精致版 / 像素鲸鱼）需要另外两套**真实素材**，调色代替不了。

这个脚本留着：将来有了新素材，可以用它快速试配色。
素材到位后要删掉派生目录时跑：

    rm -rf assets/whale-girl-night

用法：
    python3 tools/make_variant.py
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "whale-girl"
DST = ROOT / "assets" / "whale-girl-night"

# 夜间版：整体压暗、往靛蓝偏一点。
# 只动 RGB，**不碰 alpha** —— alpha 一旦被动，命中测试和视觉验收的基线全得重做。
GAIN = (0.72, 0.76, 0.98)
LIFT = (6, 4, 22)


def transform(rgba: np.ndarray) -> np.ndarray:
    out = rgba.astype(np.float32)
    rgb = out[:, :, :3]
    for i in range(3):
        rgb[:, :, i] = np.clip(rgb[:, :, i] * GAIN[i] + LIFT[i], 0, 255)
    out[:, :, :3] = rgb
    return out.astype(np.uint8)


def main() -> int:
    if not SRC.exists():
        print(f"❌ 找不到源形象 {SRC}")
        return 1
    if DST.exists():
        shutil.rmtree(DST)
    DST.mkdir(parents=True)

    files = sorted(SRC.glob("*.webp"))
    for path in files:
        im = Image.open(path).convert("RGBA")
        out = Image.fromarray(transform(np.array(im)), "RGBA")
        out.save(DST / path.name, format="WEBP", quality=82, exact=True, method=6)

    manifest = json.loads((SRC / "manifest.json").read_text())
    manifest["name"] = "鲸鱼娘 · 夜"
    manifest["description"] = (
        "由 tools/make_variant.py 派生的配色变体，用来验证形象切换机制。"
        "不是一套独立素材。"
    )
    (DST / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")

    total = sum(p.stat().st_size for p in DST.glob("*.webp"))
    print(f"✅ {DST.relative_to(ROOT)}：{len(files)} 个文件，{total / 1024:.0f} KB")
    print("   （只是配色变体，用来验证切换；真素材到位后删掉即可）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
