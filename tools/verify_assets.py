#!/usr/bin/env python3
"""
verify_assets.py — 美术资产的自动验收

为什么需要它：`need_input` 的白外套被背景移除算法挖空过一次，
而那个 bug 在第一次构建时就存在、我却没看出来 —— 因为我只扫了一眼缩略图。
`need_input` 是需求 1 的核心画面，坏了两周才发现。

这个脚本把「肉眼该看出来的东西」变成会报警的检查：

  1. 格式      —— 512×512 RGBA
  2. **面积基线** —— 不透明像素数相对基线突变超过阈值就报警 ⭐ 能抓到"被挖空"
  3. **封闭空洞** —— 被不透明像素完全包住的透明区（正常抠图不该有）
  4. 边缘接触   —— 内容贴到画布边缘（说明裁剪或对齐出了问题）
  5. 视觉验收图 —— 深底 + 浅底合成图，供人眼快速扫一遍

用法：
    python3 verify_assets.py                  # 检查 + 生成验收图
    python3 verify_assets.py --update-baseline # 确认改动无误后，把当前状态存为新基线
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
OUT_DIR = ROOT / ".verify"

# 素材按形象分目录：assets/<形象名>/*.webp + manifest.json
# 每个形象有自己的基线 —— 不同形象的像素数没有可比性。

CANVAS = 512
ALPHA_MIN = 24

# 不透明面积相对基线的容许波动。边缘抗锯齿的微小变化在 1% 以内；
# 真正的破坏（比如外套被挖空）往往是 10% 以上。
AREA_TOLERANCE = 0.03

# 封闭空洞的统计下限（像素）。低于它的碎片忽略。
#
# ⚠️ 注意：**封闭空洞本身不等于 bug**。
# 角色手臂、腿和身体之间自然围出的空隙就是合法的封闭透明区
# （idle_pillow_startle 就有约 3.5k 像素的这种空隙）。
# 所以判定不靠绝对阈值，而是**和基线对比**：洞变多了、或明显变大，才报警。
HOLE_MIN_AREA = 400

# 洞面积相对基线的容许放大倍率
HOLE_GROWTH_TOLERANCE = 1.5

# 内容距画布边缘小于这个距离就警告
EDGE_MARGIN = 2


def load_rgba(path: Path) -> np.ndarray:
    im = Image.open(path).convert("RGBA")
    return np.array(im)


def opaque_count(alpha: np.ndarray) -> int:
    return int((alpha > ALPHA_MIN).sum())


def find_enclosed_holes(alpha: np.ndarray) -> list[int]:
    """找出「被不透明像素完全包住」的透明区，返回各自面积。

    做法：从画布四边对透明像素做 flood fill，标记为"外部透明"；
    剩下的透明像素如果成片，就是封闭空洞。
    """
    h, w = alpha.shape
    transparent = alpha <= ALPHA_MIN
    outside = np.zeros((h, w), dtype=bool)

    queue: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if transparent[y, x] and not outside[y, x]:
                outside[y, x] = True
                queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if transparent[y, x] and not outside[y, x]:
                outside[y, x] = True
                queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < w and 0 <= ny < h and transparent[ny, nx] and not outside[ny, nx]:
                outside[ny, nx] = True
                queue.append((nx, ny))

    holes_mask = transparent & ~outside

    # 连通域大小
    seen = np.zeros((h, w), dtype=bool)
    sizes: list[int] = []
    ys, xs = np.where(holes_mask)
    for sy, sx in zip(ys, xs):
        if seen[sy, sx]:
            continue
        size = 0
        q: deque[tuple[int, int]] = deque([(int(sx), int(sy))])
        seen[sy, sx] = True
        while q:
            x, y = q.popleft()
            size += 1
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h and holes_mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((nx, ny))
        sizes.append(size)
    return sorted(sizes, reverse=True)


def content_margin(alpha: np.ndarray) -> int:
    """内容距画布四边的最小距离。0 = 已经贴边。"""
    mask = alpha > ALPHA_MIN
    ys, xs = np.where(mask)
    if xs.size == 0:
        return -1
    return int(min(xs.min(), ys.min(), CANVAS - 1 - xs.max(), CANVAS - 1 - ys.max()))


def build_sheets(files: list[Path], style_name: str) -> list[Path]:
    """生成视觉验收图：深底 / 浅底 / alpha 各一张。"""
    OUT_DIR.mkdir(exist_ok=True)
    cell = 150
    cols = 6
    rows = (len(files) + cols - 1) // cols
    W, H = cols * cell, rows * cell

    backgrounds = {
        "dark": (28, 32, 40),      # 深底最容易看出"被挖空"
        "light": (245, 246, 248),
    }
    made: list[Path] = []

    for name, color in backgrounds.items():
        sheet = Image.new("RGB", (W, H), color)
        draw = ImageDraw.Draw(sheet)
        for i, path in enumerate(files):
            im = Image.open(path).convert("RGBA")
            im.thumbnail((cell - 14, cell - 14), Image.LANCZOS)
            bg = Image.new("RGBA", im.size, color + (255,))
            comp = Image.alpha_composite(bg, im).convert("RGB")
            r, c = divmod(i, cols)
            sheet.paste(comp, (c * cell + (cell - comp.width) // 2,
                               r * cell + (cell - comp.height) // 2))
            draw.text((c * cell + 4, r * cell + 4), path.stem, fill=(150, 150, 150))
        out = OUT_DIR / f"{style_name}-{name}.png"
        sheet.save(out)
        made.append(out)

    # alpha 通道（白色 = 不透明）
    sheet = Image.new("RGB", (W, H), (0, 0, 0))
    for i, path in enumerate(files):
        im = Image.open(path).convert("RGBA")
        a = Image.fromarray(np.array(im)[:, :, 3], mode="L").convert("RGB")
        a.thumbnail((cell - 14, cell - 14), Image.LANCZOS)
        r, c = divmod(i, cols)
        sheet.paste(a, (c * cell + (cell - a.width) // 2, r * cell + (cell - a.height) // 2))
    out = OUT_DIR / f"{style_name}-alpha.png"
    sheet.save(out)
    made.append(out)

    return made


def find_styles() -> list[Path]:
    """扫出所有形象目录（有 manifest.json 的就算一个）。"""
    return sorted(
        d for d in ASSETS.iterdir()
        if d.is_dir() and (d / "manifest.json").exists()
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--update-baseline", action="store_true",
                    help="把当前的不透明面积存为新基线")
    ap.add_argument("--style", help="只检查某个形象（默认全部）")
    args = ap.parse_args()

    styles = find_styles()
    if args.style:
        styles = [d for d in styles if d.name == args.style]
    if not styles:
        print(f"❌ {ASSETS} 下没有找到任何形象目录（需要有 manifest.json）")
        return 1

    failed = False
    for style_dir in styles:
        if verify_style(style_dir, args.update_baseline):
            failed = True
    return 1 if failed else 0


def verify_style(style_dir: Path, update_baseline: bool) -> bool:
    """检查一个形象。返回 True 表示有异常。"""
    baseline_file = style_dir / "baseline.json"
    files = sorted(style_dir.glob("*.webp"))
    if not files:
        # ⚠️ **空目录不算失败。**
        #    `tools/new-pet.mjs` 建骨架时会创建目录 + manifest，但一张图都还没有 ——
        #    那是"正在做"，不是"做坏了"。原来这里报 ❌ 并让整个脚本退出码为 1，
        #    于是只要仓库里存在一套没做完的宠物，**所有测试都会红**。
        manifest = style_dir / "manifest.json"
        need = 0
        if manifest.exists():
            try:
                need = len(json.loads(manifest.read_text(encoding="utf-8")).get("frames", []))
            except Exception:
                pass
        print(f"⏭️  {style_dir.name} 还没有素材（需要 {need} 张）—— 跳过，不算失败")
        print("    做完之后跑: npm run verify:pet -- " + style_dir.name)
        return False

    baseline = {}
    if baseline_file.exists():
        baseline = json.loads(baseline_file.read_text()).get("assets", {})

    problems: list[str] = []
    current: dict[str, int] = {}
    snapshot: dict[str, dict] = {}

    print(f"\n资产验收 · {style_dir.name} — {len(files)} 个文件\n" + "═" * 62)

    for path in files:
        name = path.stem
        rgba = load_rgba(path)
        if rgba.shape != (CANVAS, CANVAS, 4):
            problems.append(f"{name}: 尺寸/通道不对 {rgba.shape}")
            continue

        alpha = rgba[:, :, 3]
        area = opaque_count(alpha)
        current[name] = area

        notes: list[str] = []

        # ① 面积基线
        base = baseline.get(name)
        base = base if isinstance(base, dict) else ({"area": base} if base else None)
        if base and base.get("area"):
            delta = (area - base["area"]) / base["area"]
            if abs(delta) > AREA_TOLERANCE:
                notes.append(f"面积 {base['area']:,d} → {area:,d} ({delta:+.1%}) ⚠️")

        # ② 封闭空洞 —— 和基线比，不看绝对值（正常空隙也是封闭的）
        holes = [s for s in find_enclosed_holes(alpha) if s >= HOLE_MIN_AREA]
        holes = holes[:10]
        snapshot[name] = {"holes": holes}

        if base:
            base_holes = base.get("holes", []) if isinstance(base, dict) else []
            # 容差不能给 +1：基线 0 个洞时，新出现的 1 个洞正是要抓的情况。
            # 低于 HOLE_MIN_AREA 的碎片已经被过滤，所以这里可以零容忍。
            if len(holes) > len(base_holes):
                notes.append(f"封闭空洞 {len(base_holes)} → {len(holes)} 处 ⚠️")
            elif holes and base_holes and holes[0] > base_holes[0] * HOLE_GROWTH_TOLERANCE:
                notes.append(
                    f"最大空洞 {base_holes[0]:,d} → {holes[0]:,d} px ⚠️")

        # ③ 边缘接触
        margin = content_margin(alpha)
        if margin == 0:
            notes.append("内容贴到画布边缘 ⚠️")
        elif margin < 0:
            notes.append("没有任何可见内容 ⚠️")

        if notes:
            problems.extend(f"{name}: {n}" for n in notes)
            print(f"  ⚠️  {name:24s} {area:>8,d} px   " + "；".join(notes))
        else:
            print(f"  ✅ {name:24s} {area:>8,d} px")

    print("═" * 62)

    if update_baseline:
        merged = {}
        for n, a in current.items():
            merged[n] = {"area": a, "holes": snapshot.get(n, {}).get("holes", [])}
        baseline_file.write_text(json.dumps(
            {"note": ("资产基线：不透明面积 + 封闭空洞清单。"
                      "改动资产后确认无误，再跑 --update-baseline 刷新。"
                      "封闭空洞只与基线对比 —— 角色肢体间自然围出的空隙也是封闭的，"
                      "所以不能用绝对阈值判定。"),
             "canvas": CANVAS, "alphaMin": ALPHA_MIN, "assets": merged},
            indent=2, ensure_ascii=False) + "\n")
        print(f"📌 基线已更新：{baseline_file.relative_to(ROOT)}（{len(current)} 项）")
        return False

    sheets = build_sheets(files, style_dir.name)
    print("视觉验收图：")
    for sheet in sheets:
        print(f"  {sheet.relative_to(ROOT)}")

    if problems:
        print(f"\n❌ {len(problems)} 项异常：")
        for item in problems:
            print(f"   - {item}")
        print("\n确认是无意造成的话就修；是预期改动就 --update-baseline 刷新基线。")
        return True

    print("\n✅ 全部通过")
    if not baseline:
        print("   （还没有基线，跑一次 --update-baseline 建立）")
    return False


if __name__ == "__main__":
    raise SystemExit(main())
