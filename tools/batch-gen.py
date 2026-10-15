#!/usr/bin/env python3
"""
batch-gen.py — 一次性把一套宠物缺的帧全部生成出来

做月薪喵时总结出来的流程，每一步都是踩出来的：

  ① **极简提示词**（`actions.json`）—— 堆满约束反而更差（实测 4 张里只对 1 张）
  ② **参考图**（`style.json`）—— 设定图排第一，上限 10 张（flash 硬限制）
  ③ 每个动作生成 N 张候选
  ④ **跑轮廓检查**（`silhouette.py`）筛掉比例跑偏的
  ⑤ 在合格的里面**自动挑最接近参考图的那张**
  ⑥ 落盘到 `assets/<style>/`

⚠️ 自动挑只是**初筛**，不是终审 —— 比例对了不代表画得好看，
   所以最后仍然要给人看一眼（脚本会列出每张的偏差，方便你换）。

用法：
    python3 tools/batch-gen.py --style yuexin-miao --count 4
    python3 tools/batch-gen.py --style yuexin-miao --only miaoSleep miaoAngry
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable

# 动作名 → 逻辑帧名（manifest 里的 logical 要用这个）
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


def main() -> int:
    argv = sys.argv[1:]
    style = 'yuexin-miao'
    if '--style' in argv:
        i = argv.index('--style'); style = argv[i + 1]; argv = argv[:i] + argv[i + 2:]
    count = 4
    if '--count' in argv:
        i = argv.index('--count'); count = int(argv[i + 1]); argv = argv[:i] + argv[i + 2:]
    only = []
    if '--only' in argv:
        i = argv.index('--only')
        only = [a for a in argv[i + 1:] if not a.startswith('--')]
        argv = argv[:i]

    style_dir = ROOT / 'assets' / style
    manifest = json.loads((style_dir / 'manifest.json').read_text(encoding='utf-8'))
    acts = json.loads((style_dir / 'actions.json').read_text(encoding='utf-8'))['actions']
    want = {f['logical']: f['file'] for f in manifest['frames']}

    # 还缺哪些（文件不在就是缺）
    todo = []
    skipped = []
    for act, logical in ACT_TO_LOGICAL.items():
        if act not in acts or logical not in want:
            continue
        if (style_dir / want[logical]).exists():
            continue
        if only and act not in only:
            continue
        # ⚠️ **可续跑**：已经有候选的就跳过。
        #    第一次跑被超时截断了（16 个只跑了 3 个，但退出码是 0 —— 很难发现），
        #    有了这个就能直接重跑，不用管跑到哪了。
        d = ROOT / '.cache' / 'gen' / act / 'processed'
        if d.is_dir() and [x for x in d.glob('*.webp') if not x.name.endswith('_cut.webp')]:
            skipped.append(act)
            continue
        todo.append((act, logical))

    if not todo:
        print('✅ 没有缺的帧')
        return 0

    if skipped:
        print(f'⏭️  跳过 {len(skipped)} 个已有候选的：{", ".join(skipped)}')
    print(f'要生成 {len(todo)} 个动作，每个 {count} 张候选\n')
    done, failed, skipped = [], [], []
    for n, (act, logical) in enumerate(todo, 1):
        print(f'━━ [{n}/{len(todo)}] {act} → {want[logical]} ━━')
        r = subprocess.run(
            [PY, str(ROOT / 'tools' / 'gen-frames.py'), '--style', style,
             '--action', act, '--count', str(count), '--process', '--webp'],
            cwd=ROOT, capture_output=True, text=True)
        out = (r.stdout or '') + (r.stderr or '')
        if '拿到' not in out:
            print('   ❌ 生成失败')
            print('   ' + out.strip().split('\n')[-1][:120])
            failed.append(act)
            continue
        (done if True else None)
        print('   ✅ 候选已生成')
    print(f'\n生成完成：{len(todo) - len(failed)} 成功 / {len(failed)} 失败')
    if failed:
        print('   失败：' + ', '.join(failed))
    print('\n下一步（挑图 + 落盘）：')
    print(f'   python3 tools/pick.py --style {style}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
