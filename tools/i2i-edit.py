#!/usr/bin/env python3
"""以某一张已生成的图为底，**只改指定的一处** —— 做"同一姿势的微变帧"。

## 为什么需要它
做「工作中」这种动画时，如果每帧都从零生成，模型会**自由发挥**：
Q版大肥鱼的三帧工作图，桌子、电脑、坐姿全都不一样
（量化：帧间 51~57% 的像素不同），连起来像"换了三个场景"。

正确做法是**认准一张底图**，之后的每一帧都由它**改一处**得来 ——
这样桌子、电脑、身体都是**同一张图**，只有指定的地方动。

## 用法
    python3 tools/i2i-edit.py --style big-fish \
        --base .cache/gen/bfWorking0/bfWorking0_xxx.png \
        --name bfWorking1 --change "把两只手在键盘上抬高一点点" \
        --strength 0.92 --count 1

产物落在 `.cache/gen/<name>/`，和 gen-frames.py 一致，后面可以直接 --process。
"""
from __future__ import annotations
import argparse, base64, io, json, os, sys, time, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
GEN = CACHE / "gen"
API = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
MODEL = "doubao-seedream-5-0-flash-260915"


def key() -> str:
    k = os.environ.get("ARK_API_KEY", "").strip()
    if k:
        return k
    f = CACHE / "ark-key"
    if f.exists():
        return f.read_text().strip()
    sys.exit("找不到 API key：设 ARK_API_KEY 或写 .cache/ark-key")


def data_uri(p: Path) -> str:
    """转成 data URI。⚠️ 必须先压到合理尺寸 —— 原图 2K/6MB 直接 base64 会超限。"""
    from PIL import Image
    im = Image.open(p).convert("RGB")
    if max(im.size) > 2048:
        s = 2048 / max(im.size)
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=92)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def style_lock(style: str) -> str:
    f = ROOT / "assets" / style / "style.json"
    if not f.exists():
        return ""
    d = json.loads(f.read_text())
    return (d.get("styleLock", "") + " " + d.get("background", "")).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--style", required=True)
    ap.add_argument("--base", required=True, help="底图（已生成的那张）")
    ap.add_argument("--name", required=True, help="产物目录名，如 bfWorking1")
    ap.add_argument("--change", required=True, help="**只描述要改的那一处**")
    ap.add_argument("--strength", type=float, default=0.92)
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--size", default="2K")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    # ⚠️ **一律解析成绝对路径** —— 传相对路径时 `relative_to(ROOT)` 会直接抛异常
    #    （踩过：`--base .cache/gen/bfWorking0` 报 "is not in the subpath of ..."）
    base = Path(a.base)
    if not base.is_absolute():
        base = (Path.cwd() / base).resolve()
    # ⚠️ **先判断是不是目录，再判断存不存在。**
    #    反过来写会踩坑：目录本身是"存在"的，于是不会进"取最新一张"的分支，
    #    直接把目录当文件喂给 PIL → IsADirectoryError。
    if base.is_dir():
        # 给目录就自动取里面最新的一张（生成目录里常常有好几张候选）
        cands = sorted(base.glob("*.png"), key=os.path.getmtime)
        if not cands:
            sys.exit(f"目录里没有 png: {base}")
        base = cands[-1]
    if not base.exists():
        sys.exit(f"底图不存在: {a.base}")

    prompt = (
        "**这是一张图片编辑任务。**\n"
        f"底图是《Q版大肥鱼》的一帧。请**只做这一处改动**：{a.change}\n\n"
        "⚠️ 极其重要：**画面里其余所有东西必须和底图完全一样、逐像素保持一致** ——\n"
        "包括桌子、笔记本电脑（大小、颜色、角度、位置）、身体姿势、坐姿、"
        "裙摆、头发、发箍、双手之外的四肢、以及纯绿色背景。\n"
        "不要把任何东西重新画一遍、不要换角度、不要换构图、不要改大小。\n\n"
        "画风：Q版二次元赛璐璐上色，三头身比例。\n"
        + style_lock(a.style)
    )

    def rel(p):
        try:
            return p.relative_to(ROOT)
        except ValueError:
            return p

    log = lambda m: print(m, flush=True)
    log(f"  底图: {rel(base)}")
    log(f"  只改: {a.change}")
    log(f"  参考强度: {a.strength}（越高越贴近底图）")

    if a.dry_run:
        log("\n── DRY RUN ──")
        log(f"  提示词（{len(prompt)} 字）:\n    {prompt[:300]}…")
        return

    body = {
        "model": a.model, "prompt": prompt,
        "image": data_uri(base),
        "reference_strength": a.strength,
        "response_format": "url", "size": a.size,
        "output_format": "png", "watermark": False,
    }
    out_dir = GEN / a.name
    out_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for i in range(a.count):
        req = urllib.request.Request(
            API, data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {key()}", "Content-Type": "application/json"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                res = json.loads(r.read())
        except urllib.error.HTTPError as e:
            log(f"  ❌ HTTP {e.code}: {e.read().decode()[:400]}"); return
        for item in res.get("data", []):
            url = item.get("url")
            if not url:
                continue
            with urllib.request.urlopen(url, timeout=120) as r:
                buf = r.read()
            fp = out_dir / f"{a.name}_{int(time.time())}_{i+1}.png"
            fp.write_bytes(buf)
            saved.append(fp)
            log(f"  ✅ [{i+1}/{a.count}] {rel(fp)}  ({len(buf)//1024} KB)  耗时 {time.time()-t0:.0f}s")
    if saved:
        log(f"\n  下一步：python3 tools/gen-frames.py --style {a.style} --action {a.name} --process --webp")
        log("  ⚠️ 但 gen-frames 会重新生成 —— 直接调 process() 或手工抠图更省。")


if __name__ == "__main__":
    main()
