#!/usr/bin/env python3
"""把一张新帧接进形象目录：拷 webp + 写 manifest 条目。

为什么单独写这个，而不是改 `pet-art/tools/build_assets.py`：

  `build_assets.py` 是**整套重建**的脚本 —— 它按固定的名字列表
  （IDLE_PILLOW_NAMES / WORKING_NAMES / READY_NAMES）遍历，
  从 `pet-art/character/*.png` 读源图、做背景移除、再全部重新导出。
  而 AI 生成的新帧**不是从那套源图来的**，也不该走背景移除
  （我们已经在 `gen-frames.py` 里抠过图了）。
  强行塞进去会重建全部 22 张，有改动现有资产的风险。

  所以新帧走这条独立的路：**它只动 manifest 里属于自己的一条**，
  其它条目一个字节都不碰。

用法：
    # 先看会改什么
    python3 tools/add-frame.py --from .cache/gen/pat/processed/xxx.png --name idle_pillow_pat --dry-run

    # 真接进去
    python3 tools/add-frame.py --from .cache/gen/pat/processed/xxx.png --name idle_pillow_pat

    # 接完验收
    python3 tools/verify_assets.py

    # 想撤掉
    python3 tools/add-frame.py --name idle_pillow_pat --remove
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
# 新帧的源 PNG 存这里，和上游那套的源图放同一层，将来真做整套重建时找得到
SOURCE_DIR = ROOT.parent / "pet-art" / "character"

# 和 assets.config.json 保持一致 —— 待机那组用的是 idlePillowWebpQuality
WEBP_QUALITY = 82
CANVAS = 512


def die(msg: str) -> None:
    print(f"❌ {msg}")
    sys.exit(1)


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def bounds_of(im: Image.Image) -> dict:
    """算内容的包围盒。运行时的 characterHeadOffset() 靠它定位头顶。"""
    a = np.array(im.convert("RGBA"))[:, :, 3]
    ys, xs = np.where(a > 24)          # 和 assets.config.json 的 alphaThreshold 一致
    if len(ys) == 0:
        die("这张图全是透明的")
    left, right = int(xs.min()), int(xs.max())
    top, bottom = int(ys.min()), int(ys.max())
    return {
        "left": left, "top": top, "right": right, "bottom": bottom,
        "width": right - left + 1, "height": bottom - top + 1,
        "centerX": (left + right) / 2,
    }


def check_against_existing(im: Image.Image, style_dir: Path) -> list[str]:
    """和同目录现有帧比构图 —— 差太多说明归一化没做对。"""
    import statistics
    rows = []
    for f in sorted(style_dir.glob("*.webp")):
        try:
            o = Image.open(f).convert("RGBA")
        except Exception:
            continue
        a = np.array(o)[:, :, 3]
        ys, xs = np.where(a > 24)
        if len(ys) == 0:
            continue
        rows.append(((xs.max() - xs.min() + 1) / o.width, (ys.max() - ys.min() + 1) / o.height))
    if not rows:
        return []
    mw = statistics.median(r[0] for r in rows)
    mh = statistics.median(r[1] for r in rows)
    b = bounds_of(im)
    w, h = b["width"] / im.width, b["height"] / im.height
    out = []
    if abs(w - mw) > 0.12:
        out.append(f"占宽 {w*100:.1f}% 和现有帧中位数 {mw*100:.1f}% 差得有点多")
    if abs(h - mh) > 0.12:
        out.append(f"占高 {h*100:.1f}% 和现有帧中位数 {mh*100:.1f}% 差得有点多")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="把一张新帧接进形象目录")
    ap.add_argument("--from", dest="src", help="处理好的 512×512 PNG")
    ap.add_argument("--name", required=True, help="帧名（不含扩展名，如 idle_pillow_pat）")
    ap.add_argument("--style", default="whale-girl", help="形象目录名（默认 whale-girl）")
    ap.add_argument("--remove", action="store_true", help="撤掉这个帧（webp + manifest 条目）")
    ap.add_argument("--dry-run", action="store_true", help="只打印会改什么")
    args = ap.parse_args()

    style_dir = ASSETS / args.style
    manifest_path = style_dir / "manifest.json"
    if not manifest_path.exists():
        die(f"找不到 {manifest_path.relative_to(ROOT)}")

    manifest = json.loads(manifest_path.read_text())
    webp_path = style_dir / f"{args.name}.webp"

    # ── 撤掉 ──
    if args.remove:
        if args.name not in manifest["assets"]:
            die(f"manifest 里没有 {args.name}")
        if args.dry_run:
            print(f"会删除 {webp_path.relative_to(ROOT)} 和 manifest 里的条目")
            return
        webp_path.unlink(missing_ok=True)
        del manifest["assets"][args.name]
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        print(f"✅ 已撤掉 {args.name}")
        print("   ⚠️ 别忘了跑 python3 tools/verify_assets.py --update-baseline 刷新基线")
        return

    if not args.src:
        die("要么给 --from，要么加 --remove")
    src = Path(args.src).resolve()
    if not src.exists():
        die(f"找不到 {src}")
    if args.name in manifest["assets"]:
        die(f"manifest 里已经有 {args.name} 了 —— 换个名字，或先 --remove")

    im = Image.open(src).convert("RGBA")
    if im.size != (CANVAS, CANVAS):
        die(f"尺寸是 {im.size[0]}×{im.size[1]}，必须是 {CANVAS}×{CANVAS}"
            "（gen-frames.py --process 会归一化到 512×512）")

    warns = check_against_existing(im, style_dir)
    b = bounds_of(im)

    # ── 生成 webp ──
    import io
    buf = io.BytesIO()
    im.save(buf, format="WEBP", quality=WEBP_QUALITY, method=6)
    data = buf.getvalue()
    src_bytes = src.read_bytes()

    print(f"  帧名      : {args.name}")
    print(f"  形象目录  : {args.style}")
    print(f"  源图      : {src.relative_to(ROOT) if ROOT in src.parents else src}")
    print(f"  webp      : {webp_path.relative_to(ROOT)}  （{len(data)//1024} KB, quality {WEBP_QUALITY}）")
    print(f"  包围盒    : {b['width']}×{b['height']}  占宽 {b['width']/CANVAS*100:.1f}%  "
          f"占高 {b['height']/CANVAS*100:.1f}%  水平中心 {b['centerX']:.1f}")
    if warns:
        print()
        for w in warns:
            print(f"  ⚠️  {w}")
        print("     （不阻止接入，但请对着现有帧目视确认一遍）")

    if args.dry_run:
        print("\n  --dry-run，什么都没改")
        return

    # ── 落盘 ──
    webp_path.write_bytes(data)
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    src_dest = SOURCE_DIR / f"{args.name}.png"
    if not src_dest.exists():
        shutil.copy2(src, src_dest)
        print(f"\n  ✅ 源图另存: {src_dest.relative_to(ROOT.parent)}")

    # 条目字段对齐上游那套的格式；对不上的填 null 并注明原因
    manifest["assets"][args.name] = {
        "source": f"../{args.name}.png",
        "sourceSha256": sha256(src_bytes),
        "outputSha256": sha256(data),
        "bytes": len(data),
        "quality": WEBP_QUALITY,
        # 下面这几个是上游"背景移除"管线专有的。我们的帧是 AI 生成后
        # 用 tools/cutout 抠的，没有"背景色"和"移除像素数"的概念。
        "backgroundRgb": None,
        "removedPixels": None,
        "pipeline": "gen-frames.py（AI 生成 → cutout 抠图 → despill → 归一化）",
        "offset": {"x": 0, "y": 0},
        "scale": None,
        "bounds": b,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"  ✅ manifest 已加条目（共 {len(manifest['assets'])} 项）")
    print()
    print("下一步：")
    print("    python3 tools/verify_assets.py               # 验收")
    print("    python3 tools/verify_assets.py --update-baseline   # 确认无误后刷新基线")
    print("    然后在 src/renderer/pet.js 里写片段引用它")


if __name__ == "__main__":
    main()
