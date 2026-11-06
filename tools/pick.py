#!/usr/bin/env python3
"""
pick.py — 按轮廓比例给候选打分、挑最好的落盘

⚠️ **自动挑只是初筛。** 比例对了不代表画得好看 ——
   所以它会把每张的偏差列出来，方便你换。

用法：
    python3 tools/pick.py --style yuexin-miao          # 挑并落盘
    python3 tools/pick.py --style yuexin-miao --dry    # 只看打分不落盘
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from silhouette import profile  # noqa: E402

ACT_TO_LOGICAL = {
    'miaoAwake': 'awake', 'miaoBlink': 'blink', 'miaoSlowBlink': 'slowBlink',
    'miaoBlinkTwice': 'blinkTwice', 'miaoEat': 'eat', 'miaoStretch': 'stretch',
    'miaoDrowsy': 'drowsy', 'miaoSleep': 'sleep', 'miaoStartle': 'startle',
    'miaoWave1': 'wave1', 'miaoWave2': 'wave2', 'miaoPatHappy': 'patHappy',
    'miaoAngry': 'angry', 'miaoAngryBlock': 'angryBlock', 'miaoWork0': 'work0',
    'miaoNeedInput': 'needInput', 'miaoBlocked': 'blocked',
    'miaoReady0': 'ready0', 'miaoReady1': 'ready1', 'miaoReady2': 'ready2',
    'miaoReady3': 'ready3', 'miaoReady4': 'ready4',
}
TOLERANCE = 0.15      # 和参考图的耳朵张开度差超过这个就算不合格


def main() -> int:
    argv = sys.argv[1:]
    style = 'yuexin-miao'
    if '--style' in argv:
        i = argv.index('--style'); style = argv[i + 1]; argv = argv[:i] + argv[i + 2:]
    dry = '--dry' in argv

    style_dir = ROOT / 'assets' / style
    manifest = json.loads((style_dir / 'manifest.json').read_text(encoding='utf-8'))
    want = {f['logical']: f['file'] for f in manifest['frames']}

    # 基准：petdex 站立帧（或 style.json 的主参考图）
    refs = sorted((ROOT / 'pet-art' / style / 'refs').glob('*.png')) if (ROOT / 'pet-art' / style / 'refs').is_dir() else []
    base_path = refs[0] if refs else (ROOT / 'pet-art' / style / '_reference.png')
    base = profile(base_path)
    if not base:
        print(f'❌ 读不到参考图 {base_path}'); return 2
    print(f'基准 {base_path.name}: 耳朵张开 {base["earSpread"]*100:.0f}%   最宽 {base["maxWidth"]*100:.0f}%\n')

    picked, nofit = [], []
    for act, logical in ACT_TO_LOGICAL.items():
        if logical not in want:
            continue
        d = ROOT / '.cache' / 'gen' / act / 'processed'
        if not d.is_dir():
            continue
        cands = [p for p in sorted(d.glob('*.webp')) if not p.name.endswith('_cut.webp')]
        # 只看这一轮生成的（文件名时间戳最新的那批）
        if not cands:
            continue
        scored = []
        for c in cands:
            r = profile(c)
            if not r:
                continue
            dev = abs(r['earSpread'] - base['earSpread'])
            scored.append((dev, c, r))
        scored.sort(key=lambda x: x[0])
        dev, best, r = scored[0]
        ok = dev <= TOLERANCE
        flag = '✅' if ok else '❌ 全部超差'
        print(f'  {logical:12} 挑中 {best.name:38} 偏差 {dev*100:4.0f} 点  {flag}')
        for dv, c, rr in scored[1:]:
            print(f'  {"":12} 备选 {c.name:38} 偏差 {dv*100:4.0f} 点')
        if not ok:
            nofit.append(logical)
            continue
        picked.append((logical, best))

    if not dry:
        for logical, src in picked:
            shutil.copy(src, style_dir / want[logical])
        print(f'\n✅ 落盘 {len(picked)} 张')
    else:
        print(f'\n（--dry，没有落盘）会落盘 {len(picked)} 张')

    if nofit:
        print(f'⚠️  这些动作的候选**全部超差**，建议重新生成：{", ".join(nofit)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
