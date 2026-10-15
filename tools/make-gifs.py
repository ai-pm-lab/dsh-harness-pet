#!/usr/bin/env python3
"""
make-gifs.py — 把每个动作片段合成 GIF。

数据从 `tools/dump-clips.cjs` 来（它起一个真渲染层，问 `clipFor()`），
**不是**直接读 manifest —— 因为「动作」有一半是代码构造的
（`workingCycle()` / `readyCycle()×5` / `IDLE_CHAIN`），
只读 manifest 会漏掉，而且 manifest 优先、代码兜底的优先级也体现不出来。

── 为什么不用截图 ──
`clipFor()` 给帧名、`FRAME_FILES` 给文件名，一拼就是 512×512 的源图。
直接用源图合成，**像素 1:1 零损失**，也不用管窗口尺寸和缩放。

── ⚠️ 三个必须处理的坑 ──

① **`offsetY` 一定要应用。**
   那是渲染时才加的上下位移，跳跃类动作（`ready`）全靠它。
   只拿帧图会做成"原地换图" —— 实测踩过：光看 manifest 里
   `offsetY: None` 就下结论"她不跳"，其实位移是**画在画面里**的，
   而 `ready` 这种是**画面 + offsetY 叠加**。两者都要算。

② **时长可能是区间**（`[2200, 4400]`）—— dump 时已折成中值，
   但这里还要**封顶**：`awake` 那种 3 秒静止帧放进 GIF 只会让人以为卡住了。

③ **GIF 只有 1 位透明 + 256 色。**
   这套图边缘是抗锯齿的，硬抠透明会留锯齿 ⇒ **默认铺不透明背景**。
   而且 256 色对平涂画风几乎无损（四五个色），但抗锯齿边会有轻微色带。

── 用法 ──
    python3 tools/make-gifs.py                      # 全部形象
    python3 tools/make-gifs.py --style big-fish     # 只做一套
    python3 tools/make-gifs.py --style big-fish --bg checker
"""
import argparse
import json
import pathlib
import sys

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent

# ⚠️ 单帧最长显示多久。`awake` 原本是 2200~4400ms ——
#    放进 GIF 就是"3 秒不动"，看的人会以为文件坏了。封顶。
MAX_FRAME_MS = 900
MIN_FRAME_MS = 60          # GIF 的最小延迟，太快浏览器会当 100ms 处理

# 输出尺寸。512 原图太大（20 帧的 ready 会到 3MB+），
# 384 在聊天窗口/README 里够清楚，体积也可控。
OUT_SIZE = 384


def checkerboard(size, cell=16, light=(255, 255, 255), dark=(226, 230, 236)):
    """棋盘格背景 —— 一眼看出"这是透明底"。"""
    im = Image.new('RGBA', size, light + (255,))
    d = ImageDraw.Draw(im)
    w, h = size
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            if (x // cell + y // cell) % 2:
                d.rectangle([x, y, x + cell - 1, y + cell - 1], fill=dark + (255,))
    return im


def make_bg(size, kind):
    if kind == 'checker':
        return checkerboard(size)
    if kind == 'white':
        return Image.new('RGBA', size, (255, 255, 255, 255))
    if kind == 'dark':
        return Image.new('RGBA', size, (32, 36, 44, 255))
    return Image.new('RGBA', size, (244, 246, 249, 255))      # light（默认）


def build_gif(style, name, clip, out_dir, bg_kind, asset_dir):
    frames, files = clip['frames'], clip['files']
    durs = clip['durationsFolded']
    offy = clip.get('offsetY') or []
    loop = clip.get('loop', False)

    # 干净地跳过：这套没有的帧、或只有 1 种画面又没位移（做成 GIF 是静止图）
    uniq = list(dict.fromkeys(frames))
    if len(uniq) < 2 and not any(offy):
        return None, '只有 1 种画面又没有位移'
    if all(f is None for f in files):
        return None, '这套没有对应的图'

    imgs, delays, applied = [], [], []
    for i, fname in enumerate(files):
        if fname is None:
            continue
        p = asset_dir / f'{fname}.webp'
        if not p.exists():
            continue
        src = Image.open(p).convert('RGBA')

        # ⚠️ `offsetY` 是**在 512 画布坐标系里的像素数**，
        #    所以要在缩放**之前**按原尺寸平移，再整体缩放 ——
        #    顺序反了的话位移量会跟着缩放比例变，和真 app 里不一致。
        dy = offy[i] if i < len(offy) else 0
        if dy:
            shifted = Image.new('RGBA', src.size, (0, 0, 0, 0))
            shifted.alpha_composite(src, (0, int(dy)))
            src = shifted

        # ⚠️ 位移之后内容可能被裁掉，所以统一用原始画布尺寸缩放
        imgs.append(src.resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS))

        d = durs[i] if i < len(durs) else 200
        if isinstance(d, list):        # 兜底：区间没折干净
            d = d[0]
        d = max(MIN_FRAME_MS, min(MAX_FRAME_MS, int(d or 200)))
        delays.append(d)
        applied.append(dy)

    if len(imgs) < 2:
        return None, '有效帧不足 2 张'

    # 铺背景（GIF 的 1 位透明会让抗锯齿边缘变锯齿，铺底更干净）
    composed = []
    bg = make_bg((OUT_SIZE, OUT_SIZE), bg_kind)
    for im in imgs:
        c = bg.copy()
        c.alpha_composite(im)
        # GIF 用调色板模式
        composed.append(c.convert('RGB').convert('P', palette=Image.ADAPTIVE, colors=255))

    first, rest = composed[0], composed[1:]
    out = out_dir / f'{style}__{name}.gif'
    first.save(
        out,
        save_all=True,
        append_images=rest,
        duration=delays,
        loop=0 if loop else 1,       # loop=0 无限；不循环的放一遍就停
        disposal=2,
        optimize=True,
    )
    kb = out.stat().st_size / 1024
    note = f'{len(imgs)} 帧  {sum(delays)}ms'
    if any(applied):
        note += f'  位移 {min(applied)}~{max(applied)}px'
    if not loop:
        note += '  一遍'
    return (out, note, kb), None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--clips', default=str(ROOT / '.verify' / 'clips.json'))
    ap.add_argument('--out', default=str(ROOT / '..' / '桌宠文件' / '动作GIF'))
    ap.add_argument('--style', action='append', help='只做这套（可重复）')
    ap.add_argument('--bg', default='light', choices=['light', 'white', 'checker', 'dark'])
    ap.add_argument('--only', action='append', help='只做这个片段（可重复）')
    args = ap.parse_args()

    data = json.loads(pathlib.Path(args.clips).read_text())
    out_dir = pathlib.Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    styles = args.style or list(data['styles'].keys())
    made = skipped = 0
    print(f'  输出目录 {out_dir}')
    print(f'  背景 {args.bg}   尺寸 {OUT_SIZE}×{OUT_SIZE}   单帧封顶 {MAX_FRAME_MS}ms')
    print()
    for style in styles:
        info = data['styles'].get(style)
        if not info:
            print(f'  ⚠️ 没有 {style} 的数据')
            continue
        asset_dir = ROOT / 'assets' / style
        print(f'  ── {style} ──')
        for name, clip in info['clips'].items():
            if args.only and name not in args.only:
                continue
            res, why = build_gif(style, name, clip, out_dir, args.bg, asset_dir)
            if res is None:
                print(f'      · {name:<12} 跳过（{why}）')
                skipped += 1
                continue
            path, note, kb = res
            src = clip.get('source', '?')
            print(f'      ✅ {name:<12} {note}   {kb:6.0f} KB   [{src}]')
            made += 1
        print()
    print(f'  ⇒ 做了 {made} 个，跳过 {skipped} 个')
    if skipped:
        print('     （跳过的是：只有 1 种画面又没位移的单帧动作 —— 做成 GIF 就是张静止图）')


if __name__ == '__main__':
    sys.exit(main())
