#!/usr/bin/env python3
"""
make-hero.py — 给 README 顶部做一张**会动的 hero 图**。

原来的 `docs/images/hero.png` 是静态的：左边标题 + 三条卖点，右边一个角色。
这个脚本**保持同样的版式**，只把右边那块换成动画 —— GitHub 上 GIF 会自动播放，
第一眼就能看出"她是活的"。

── 为什么不用现成的方形 GIF 贴上去 ──
`make-gifs.py` 出的是 384×384 方图，而 hero 是 **960×500 横版**：
左边一大块是文字。直接把方图贴上去版式就散了。
⇒ 所以这里**重画版式**，角色动画只占右边一块。

── ⚠️ 两个坑 ──

① **GIF 的 1 位透明会让抗锯齿边缘变锯齿。**
   所以背景**不透明**：照抄原 hero 的浅蓝渐变（采样出来的
   `(244,247,252)` → `(223,231,243)`），而不是抠成透明。

② **角色的每帧要"底边对齐"，不是"包围盒对齐"。**
   宠物的高度在不同动作里不一样（睡着是坐着的、庆祝是跳起来的），
   按包围盒居中会让它**每帧上下乱跳**。原素材画布本身就是 512×512 对齐的，
   所以直接整张缩放、按画布底边定位就稳了。

── 用法 ──
    python3 tools/make-hero.py                        # 出全部候选
    python3 tools/make-hero.py --style big-fish --clip working
"""
import argparse
import json
import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent

W, H = 960, 500                  # 和原 hero.png 一样，README 里不用改版式
BG_TOP = (244, 247, 252)
BG_BOT = (223, 231, 243)

FONT_PATH = '/System/Library/Fonts/STHeiti Medium.ttc'
FONT_BOLD = '/System/Library/Fonts/Hiragino Sans GB.ttc'

# 右边放角色的区域（离右边留点空）
CHAR_BOX = (572, 34, 934, 478)

TITLE = '胖头鱼 · DSH 桌宠'
SUB1 = '一个始终置顶的桌面宠物，'
SUB2 = '盯着你的 DeepSeek Harness agent 干活。'
BULLETS = [
    '需要你确认时，她会举双手一直等',
    '点她一下 = 「我看到了」',
    '复制一段英文，气泡里出中文译文',
]


def gradient():
    g = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(g)
    for y in range(H):
        t = y / (H - 1)
        d.line([(0, y), (W, y)], fill=tuple(
            round(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3)))
    return g


def font(path, size):
    """字体打不开就退回默认 —— 不要让整个脚本挂掉。"""
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def text_block(img, draw, scale_dpi=1):
    f_title = font(FONT_PATH, 42)
    f_sub = font(FONT_PATH, 21)
    f_bul = font(FONT_PATH, 20)
    draw.text((46, 96), TITLE, font=f_title, fill=(26, 34, 52))
    draw.text((46, 166), SUB1, font=f_sub, fill=(96, 108, 128))
    draw.text((46, 196), SUB2, font=f_sub, fill=(96, 108, 128))
    y = 252
    for b in BULLETS:
        draw.text((46, y), '·', font=f_bul, fill=(96, 108, 128))
        draw.text((64, y), b, font=f_bul, fill=(78, 90, 110))
        y += 34


def content_box(frames):
    """
    所有帧的**并集**内容框。

    ⚠️ **必须用并集，不能逐帧各算各的。**
       逐帧按各自的内容包围盒对齐，会把"她在动"这件事本身抹掉 ——
       因为每帧都会被拉到同样大小、同样位置，动作就没了。
       （素材制作时踩过同一个坑，见 AGENTS.md 的「怎么从 GIF 抽帧」。）

    但因为**缩放倍率要一致**，这里只用来决定"裁掉四周多少空白"，
    所有帧共用同一个框。
    """
    x0 = y0 = 10 ** 9
    x1 = y1 = -1
    for f in frames:
        b = f.split()[3].getbbox()
        if not b:
            continue
        x0 = min(x0, b[0]); y0 = min(y0, b[1])
        x1 = max(x1, b[2]); y1 = max(y1, b[3])
    if x1 < 0:
        return None
    return (x0, y0, x1, y1)


def load_clip_frames(style, clip_name, clips):
    """把一个片段的帧读成 RGBA 图（应用 offsetY）。"""
    info = clips['styles'][style]['clips'][clip_name]
    files = info['files']
    offy = info.get('offsetY') or []
    durs = info['durationsFolded']
    out, delays = [], []
    for i, fname in enumerate(files):
        if fname is None:
            continue
        p = ROOT / 'assets' / style / f'{fname}.webp'
        if not p.exists():
            continue
        im = Image.open(p).convert('RGBA')
        dy = offy[i] if i < len(offy) else 0
        if dy:
            sh = Image.new('RGBA', im.size, (0, 0, 0, 0))
            sh.alpha_composite(im, (0, int(dy)))
            im = sh
        out.append(im)
        d = durs[i] if i < len(durs) else 200
        if isinstance(d, list):
            d = d[0]
        delays.append(max(70, min(900, int(d or 200))))
    return out, delays


def paste_char(canvas, im, box):
    """
    把角色放进 CHAR_BOX：**先按并集框裁掉四周空白，再等比放大到底边居中**。

    ⚠️ 裁框由调用方统一传进来（所有帧共用）——
       逐帧各裁各的会让她每帧大小位置都不一样，动作就废了。
    """
    if box:
        im = im.crop(box)
    x0, y0, x1, y1 = CHAR_BOX
    bw, bh = x1 - x0, y1 - y0
    s = min(bw / im.width, bh / im.height)
    w, h = max(1, int(im.width * s)), max(1, int(im.height * s))
    sm = im.resize((w, h), Image.LANCZOS)
    x = x0 + (bw - w) // 2
    y = y1 - h                      # ⚠️ 底边对齐，不是垂直居中
    canvas.paste(sm, (x, y), sm)


def build(style, clip_name, clips, out_path, label=''):
    frames, delays = load_clip_frames(style, clip_name, clips)
    if len(frames) < 2:
        return None
    base = gradient()
    text_block(base, ImageDraw.Draw(base))
    box = content_box(frames)        # ⚠️ 所有帧共用一个裁框
    composed = []
    for im in frames:
        c = base.copy()
        paste_char(c, im, box)
        composed.append(c.convert('P', palette=Image.ADAPTIVE, colors=255))
    composed[0].save(out_path, save_all=True, append_images=composed[1:],
                     duration=delays, loop=0, disposal=2, optimize=True)
    kb = out_path.stat().st_size / 1024
    return kb, len(frames), sum(delays)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--clips', default=str(ROOT / '.verify' / 'clips.json'))
    ap.add_argument('--out', default=str(ROOT / '..' / '桌宠文件' / 'hero候选'))
    args = ap.parse_args()

    clips = json.loads(pathlib.Path(args.clips).read_text())
    out_dir = pathlib.Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # 候选：形象 × 片段。挑的都是"一眼看懂她在干嘛"的。
    CANDS = [
        ('big-fish',    'working', 'Q版大肥鱼-敲键盘'),
        ('big-fish',    'wave',    'Q版大肥鱼-挥手'),
        ('big-fish',    'ready',   'Q版大肥鱼-庆祝'),
        ('whale-girl',  'working', '鲸鱼娘-敲键盘'),
        ('yuexin-miao', 'working', '月薪喵-敲键盘'),
        ('yuexin-miao', 'greet',   '月薪喵-打招呼'),
    ]
    print(f'  输出 {out_dir}')
    print(f'  版式 {W}×{H}（和原 hero.png 一样，README 不用改）')
    print()
    made = []
    for style, clip, label in CANDS:
        info = clips['styles'].get(style, {}).get('clips', {})
        if clip not in info:
            print(f'  · {label:<20} 跳过（这套没有 {clip}）')
            continue
        p = out_dir / f'hero-{style}-{clip}.gif'
        r = build(style, clip, clips, p, label)
        if not r:
            print(f'  · {label:<20} 跳过（有效帧不足 2）')
            continue
        kb, nf, ms = r
        print(f'  ✅ {label:<20} {nf:>2} 帧  {ms:>5}ms  {kb:>6.0f} KB   {p.name}')
        made.append(p)
    print(f'\n  ⇒ {len(made)} 个候选')
    if made:
        print('    ⚠️ GitHub README 里的图建议 **< 3 MB**，上面这些都是几百 KB，够用。')


if __name__ == '__main__':
    main()
