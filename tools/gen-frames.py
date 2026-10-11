#!/usr/bin/env python3
"""用火山方舟 Seedream 给鲸鱼娘生成新动作帧。

设计目标是**尽量少花钱、尽早发现问题**：
先只生成一张，人工看过再决定要不要批量。

用法：
    # 0. 存 Key（只做一次，文件已 gitignore）
    mkdir -p .cache && printf '%s' 'ark-xxxxx' > .cache/ark-key

    # 1. 看他有哪些预设动作
    python3 tools/gen-frames.py --list

    # 2. 生成一张试水（最省钱）
    python3 tools/gen-frames.py --action pat --count 1

    # 3. 结果满意再批量
    python3 tools/gen-frames.py --action pat --count 4

    # 4. 出图后自动拼对比图，人工检查"像不像"
    #    产物在 .cache/gen/<动作>/ 下

⚠️ 这里所有产物都落在 .cache/ 里（已 gitignore）——
   它们是**候选稿**，人工挑过、抠好图、转成 webp 之后才算正式素材。
"""

from __future__ import annotations

import argparse
import base64
import json
from functools import lru_cache
import os
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
GEN_DIR = CACHE / "gen"
REF_DIR = CACHE / "refs"
KEY_FILE = CACHE / "ark-key"

API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations"

# ⚠️ 火山方舟的 model ID **必须带日期后缀**，光写名字会报
#    InvalidEndpointOrModel.NotFound —— 而且这个报错和"没开通"长得一样，
#    很容易误判。**用 GET /api/v3/models 能列出账号可见的全部模型和准确 ID**：
#        curl -s https://ark.cn-beijing.volces.com/api/v3/models \
#             -H "Authorization: Bearer $ARK_API_KEY" | python3 -m json.tool
#    当前账号可用：
#        doubao-seedream-5-0-flash-260915   ← 默认（更快更便宜，适合草稿/候选图）
#        doubao-seedream-5-0-pro-260628     （高精度，适合定稿）
DEFAULT_MODEL = "doubao-seedream-5-0-flash-260915"

# 参考图上限。
# ⚠️ 官方文档说 14，但**实测 flash 模型超过 10 张就报**
#    `InvalidParameter: number of reference images cannot exceed 10` ——
#    而且是硬失败，不降级。所以按 10 来。
#    另外「参考图数 + 生成图数 ≤ 15」这条也要留余量。
MAX_REFS = 10

# ─────────────────────────── 预设动作 ───────────────────────────
# prompt 的写法和 PC2005-cloud/dsh-pet 的素材教程是一个思路：
# 把「不能变的东西」写死（角色/画风/构图），只让「要变的东西」变。
# ── 风格从 assets/<style>/style.json 读，**不再写死** ──
#
# ⚠️ 这里原来是一个写死的 STYLE_LOCK，里面写着"蓝色渐变长发、白色小鱼发夹、
#    白色外套、深蓝百褶裙、深蓝短靴" —— 那是**鲸鱼娘专属**的。
#    做第二套宠物（月薪喵，极简扁平贴纸风）时，那些词会被硬加进提示词，
#    生成出来的猫会莫名其妙长出蓝头发和百褶裙。
#
#    "风格锁写死"正是做标准化工作流要防的事 —— 现在每套宠物一份 style.json。

def load_actions(style_id):
    """这套宠物的动作提示词。

    ⚠️ **每套一份**（`assets/<style>/actions.json`），不再共用一份写死的。
       鲸鱼娘的动作描述里全是"双手举起""敲键盘""抱着玩偶" ——
       月薪喵**没有四肢**，照那些描述生成会画出不存在的手。
       找不到就退回内置的 ACTIONS（只为兼容老的那套）。
    """
    path = os.path.join(ROOT, "assets", style_id, "actions.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    acts = data.get("actions", {})
    log(f"📋 动作: {len(acts)} 个（assets/{style_id}/actions.json）")
    return acts


def load_style(style_id):
    """读一套宠物的风格定义。找不到就用一个中性的兜底。"""
    path = os.path.join(ROOT, "assets", style_id, "style.json")
    if not os.path.exists(path):
        log(f"⚠️  assets/{style_id}/style.json 不存在 —— 用中性兜底风格")
        log(f"    建议跑 tools/new-pet.mjs 建骨架，它会生成一份")
        return {"styleLock": "画面干净，无文字，无水印。",
                "background": "背景为纯绿色 #00FF00 平面（便于后期抠图），"
                              "不要阴影、不要渐变、不要地面、不要边框、不要任何背景元素。"}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    log(f"🎨 风格: {data.get('name', style_id)}（assets/{style_id}/style.json）")
    return data


STYLE = None          # 在 main() 里按 --style 装载
STYLE_ID = "whale-girl"   # 同上
STYLE_LOCK = ""       # 兼容旧引用，运行时被 STYLE["styleLock"] 覆盖
BACKGROUND = ""

BACKGROUND = (
    "背景为纯绿色 #00FF00 平面（便于后期抠图），"
    "不要阴影、不要渐变、不要地面、不要边框、不要任何背景元素。"
)

ACTIONS = {
    "pat": {
        "desc": "摸头眯眼 —— 被摸头时幸福地眯起眼睛（现有功能缺这个表情）",
        "prompt": (
            # ⚠️ 第一版写了"被一只温柔的手摸头"，结果 AI 把那只手也画进去了 ——
            #    手不是绿色，抠图后留在画面里。所以必须明确"不要画手"，
            #    只用表情和姿态表现"被摸头"。
            # ⚠️ 两个都踩过坑：
            #   1. 写"被一只温柔的手摸头" → AI 把那只手画进去了。手不是绿色，
            #      抠图后留在画面里，还把内容包围盒撑宽（占宽 91.4% vs 现有帧 68.4%）
            #   2. 没提鲸鱼玩偶 → 她把手里的玩偶丢了。现有 21 帧**每一帧都抱着它**，
            #      丢了接进待机链会有明显的跳变
            "这个角色正被摸头。**只画角色本人，不要画手、不要画手臂、"
            "不要画任何其他人物或肢体。**"
            "她保持着原本的坐姿，双手依然抱着那只深蓝色的小鲸鱼玩偶（务必保留这个玩偶）。"
            "她微微低头，幸福地眯起眼睛（眼睛弯成两道上扬的弧线，像 ^ ^），"
            "脸颊泛着淡淡的红晕，嘴角上扬露出满足的微笑，"
            "头顶的呆毛被压得微微弯下，肩膀放松略微内收。"
            "整体姿态是被安抚、很享受的感觉。"
        ),
    },
    "eat": {
        "desc": "啃小鱼干 —— 双手捧着一条小鱼干在吃",
        # ⚠️ 注意区分两种"手"：
        #   她**自己的**手是角色的一部分，要画；
        #   别人的手（上次"摸头"里那只）不能出现 —— 抠图后会留在画面里。
        "prompt": (
            "这个角色保持着原来的坐姿，用**她自己的**双手捧着一条小鱼干，张嘴咬下去。"
            "**画面里只有她一个人** —— 不要出现别人的手、别人的手臂或其他人物。"
            "深蓝色的小鲸鱼玩偶就放在她腿上（务必保留这个玩偶）。"
            "她眼睛亮晶晶地看着手里的小鱼干，腮帮子微微鼓起，"
            "表情是开心又专注的吃货样，尾巴在身后轻轻摆动。"
        ),
    },
    "angry": {
        "desc": "生气 —— 被乱蹭之后闹脾气（替换原来的左右摆动）",
        # 为什么要这个：原来是 CSS 的 rotate 左右摆动，**她本人的表情没变** ——
        # 看起来像"图在晃"而不是"她在生气"。和摸头表情是同一类问题。
        #
        # ⚠️ 分寸：她是 Q 版可爱角色，生气要"可爱地生气"——
        #    鼓腮帮子 + 皱眉 + 扭头，**不要凶神恶煞**。
        #    也不要怒气符号（💢）之类的装饰：那是画面元素，抠图后会留在图上，
        #    而且不同批次生成的位置/大小都对不齐。
        "prompt": (
            "这个角色在闹脾气（**只画角色本人，不要画手、不要画其他人物或肢体**）。"
            "深蓝色的小鲸鱼玩偶依然在她怀里（务必保留）。"
            "她**把脸扭向一侧不看人**，眉头皱起来，嘴巴抿成一条小小的波浪线（不高兴的撇嘴），"
            "**两边的腮帮子鼓起来**（像含着东西），眼睛半眯着带着一点不满，"
            "整个人的姿态是「哼，不理你了」的赌气感。"
            "**注意：是可爱地闹别扭，不是凶狠发怒** —— 不要狰狞的表情、不要尖锐的牙齿、"
            "不要红色的怒纹或任何符号装饰。"
        ),
    },
    "miaoAwake": {
        "desc": "月薪喵 · 站立（新宠物的第一张试稿）",
        # ⚠️ 这个形象和鲸鱼娘**完全不同的风格**：扁平贴纸感、粗棕描边、纯色无阴影。
        #    风格锁那一套（Q版二次元厚涂）对它**不适用**，所以提示词里重写了风格。
        "prompt": (
            "一只**极简扁平风格**的卡通猫贴纸，纯色，**没有渐变没有阴影没有高光**。"
            "身体是**白色**的，形状像一个圆润的小幽灵/披风，底部有两个小尖角。"
            "头部很大，**两只巨大的米棕色（卡其色）耳朵**从头顶两侧向外张开，"
            "耳朵边缘**不规则**、带几根深棕色的短毛笔触。"
            "**眼睛是两个竖着的深蓝色椭圆**，位置靠中间，没有瞳孔没有高光。"
            "嘴巴是一个小小的棕色 ω 形。"
            "**左侧有一条粗的米棕色尾巴**，上面有三道深棕色条纹，向上弯曲。"
            "整体用**粗细不均的深棕色描边**勾边，像手绘贴纸。"
            "**不要画四肢、不要画手、不要画脚。**"
        ),
    },
    "needInputWave": {
        "desc": "招手 —— 举着手等确认时招一招（需求 1 的核心画面）",
        # 为什么要它：needInput 是**这个产品存在的理由**（她举手告诉你"要你确认"），
        # 但它现在**只有一张静止的图** —— 举着手一动不动。
        # 用户很可能根本没注意到她在等，尤其在屏幕边缘或者被别的窗口盖住的时候。
        #
        # ⚠️ 只让她**招一下手**，姿势不要大变 —— 这个片段要能和现有的
        #    idle_pillow 那张循环着播，姿势差太远会跳。
        "prompt": (
            "这个角色**站着**，双手举起（原本是「举手示意、需要你看一眼」的姿势）。"
            "现在让**她的一只手（画面右侧那只）向外挥动一下**，"
            "像是在朝你招手、喊你过来看 —— 手掌朝外，手臂抬得比另一只更高一些。"
            "另一只手保持举起不动。"
            "**画面里只有她一个人 —— 不要出现别人的手、别人的手臂或其他人物。**"
            "表情是**期待地看着你**（眼睛睁大、微微歪头），不是生气也不是害怕。"
            "**保持和原角色完全一致的脸型、五官、蓝色渐变长发、白色小鱼发夹、"
            "白色外套、深蓝百褶裙、深蓝短靴。**"
        ),
    },
    "angryBlock": {
        "desc": "挡住头 —— 生气之后双手护住头顶，表示「不给摸了」",
        # 为什么要它：生气原本只有一张鼓腮的帧，**冷却期在视觉上是"没反应"** ——
        # 用户不知道是"她在闹脾气"还是"摸头坏了"。加了护头动作之后，
        # 「不给摸了」这件事就写在脸上了。
        #
        # ⚠️ 她是**自己**把手举到头顶挡着，不是别人按着她的手。
        #    上次"摸头"那张就是没写清楚，AI 把别人的手也画进去了 ——
        #    手不是绿色，抠完留在画面里，还把内容包围盒撑宽（占宽 91% vs 68%）。
        "prompt": (
            "这个角色**用她自己的两只手举到头顶上方，手掌朝下压住头顶，"
            "像是在护住脑袋不让人碰**（**只画角色本人，绝对不要出现别人的手、"
            "别人的手臂或其他人物**）。"
            "深蓝色的小鲸鱼玩偶放在她腿上（务必保留）。"
            "她皱着眉头，眼睛斜着瞪向一侧，嘴巴抿紧，"
            "整个人的姿态是「不给摸了、走开」的抗拒感。"
            "**注意：是可爱地赌气，不是凶狠发怒** —— 不要狰狞的表情、"
            "不要尖锐的牙齿、不要红色怒纹或任何符号装饰。"
        ),
    },
    "stretch": {
        "desc": "伸懒腰 —— 久坐之后舒展身体",
        "prompt": (
            "这个角色正坐着伸懒腰。"
            "**画面里只有她一个人** —— 不要出现别人的手、别人的手臂或其他人物。"
            "深蓝色的小鲸鱼玩偶放在她旁边（务必保留这个玩偶）。"
            "她双臂向上举起伸展，身体微微后仰，"
            "眼睛舒服地闭起来，嘴巴张开打了个小小的哈欠，"
            "整个人是久坐之后放松舒展的感觉。"
        ),
    },
}

# 参考图：上游的角色设定图 + 21 帧总览，是"角色一致性"最强的两个锚点。
# 剩下用我们自己的帧补足（风格 + 配色）。
REF_SOURCES = {
    "reference.png": "https://raw.githubusercontent.com/Er1c0v0/dsh-whale-pet/main/character/reference.png",
    "contact-sheet.png": "https://raw.githubusercontent.com/Er1c0v0/dsh-whale-pet/main/docs/contact-sheet.png",
}
# ⚠️ 参考图**不再写死**（原来是一串 assets/whale-girl/xxx.webp）——
#    给第二套宠物生成时会拿鲸鱼娘的图当参考，**猫会长出蓝头发和百褶裙**。
#    现在按 `--style` 从 `assets/<style>/` 里动态挑：优先用这套里已经定稿的帧，
#    没有就退回 style.json 里指定的参考图（新宠物第一次生成时就是这种）。
@lru_cache(maxsize=None)
def local_refs(style_id):
    """这套宠物的参考图（绝对路径），最多 MAX_REFS 张。"""
    import glob
    style_dir = ROOT / "assets" / style_id
    out = []                      # ⚠️ 一律用 Path —— 混 str 会让下游 .relative_to() 炸

    # ① style.json 里显式指定的（新宠物第一张图就靠它）
    #    ⚠️ 可以是**数组** —— 一套宠物的设定图往往不止一张。
    #    月薪喵就是：用户给的参考图 + petdex 上别人做的 sprite 切出来的帧。
    ref = (STYLE or {}).get("reference")
    for one in ([ref] if isinstance(ref, str) else (ref or [])):
        if one and (ROOT / one).exists():
            out.append(ROOT / one)

    # ①b referenceDirs：目录里的图全带上（按文件名排序，保证可复现）
    for d in ((STYLE or {}).get("referenceDirs") or []):
        dd = ROOT / d
        if dd.is_dir():
            for f in sorted(dd.iterdir()):
                if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
                    out.append(f)

    # ② 这套里已经做好的帧 —— 优先挑形态差别大的（站立 / 侧面 / 动作）
    PRIORITY = ["idle_pillow_awake", "idle_pillow_blink", "idle_pillow_wave_1",
                "idle_pillow_angry", "working_0", "idle_pillow_sleep"]
    have = {p.stem: p for p in sorted(style_dir.glob("*.webp"))}
    # ③ 还不够才用这套里已经做好的帧补
    #
    #    ⚠️ **顺序很重要**：设定图（`refs/`、`_reference.png`）排在前面，
    #       已经做好的帧排在后面 —— 因为上限只有 10 张，
    #       截断时不能把设定图挤掉（设定图才是"角色长什么样"的权威）。
    for stem in PRIORITY:
        if len(out) >= MAX_REFS:
            break
        if stem in have and have[stem] not in out:
            out.append(have[stem])
    for stem in sorted(have):
        if len(out) >= MAX_REFS:
            break
        if have[stem] not in out:
            out.append(have[stem])

    if not out:
        log(f"⚠️  assets/{style_id}/ 里没有任何参考图 —— 第一张图只能靠提示词描述")
    if len(out) > MAX_REFS:
        log(f"     （参考图 {len(out)} 张，只用前 {MAX_REFS} 张 —— 设定图优先）")
    return out[:MAX_REFS]


# ─────────────────────────── 小工具 ───────────────────────────
def log(msg: str) -> None:
    print(msg, flush=True)


def die(msg: str) -> None:
    log(f"❌ {msg}")
    sys.exit(1)


def read_key() -> str:
    """Key 只在环境变量或 .cache/ark-key 里，**不写死在代码里**。"""
    key = os.environ.get("ARK_API_KEY", "").strip()
    if not key and KEY_FILE.exists():
        key = KEY_FILE.read_text().strip()
    if not key:
        die(
            "没找到 API Key。二选一：\n"
            "     export ARK_API_KEY=ark-xxxxx\n"
            f"     printf '%s' 'ark-xxxxx' > {KEY_FILE.relative_to(ROOT)}\n"
            "   ⚠️ 别把 Key 提交进仓库 —— .cache/ 已经在 .gitignore 里了"
        )
    if not key.startswith("ark-"):
        die(f"Key 应该以 ark- 开头，当前是 {key[:8]}...")
    return key


def post_json(url: str, body: dict, key: str, timeout: int = 180) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="ignore")
        try:
            d = json.loads(raw)
        except Exception:
            die(f"HTTP {e.code}：{raw[:400]}")
        code = d.get("code") or (d.get("error") or {}).get("code") or f"HTTP {e.code}"
        msg = d.get("message") or (d.get("error") or {}).get("message") or ""
        # 这两个错各有明确的下一步，单独说清楚
        if code == "SetLimitExceeded":
            die(
                f"{code}\n   {msg}\n\n"
                "   → 你的账号开了「安全体验模式」，额度用满了。\n"
                "     去火山方舟控制台 → 开通管理 → 关闭安全体验模式（或调高上限）\n"
                "     ⚠️ 关闭后是按量计费，账户里要有余额"
            )
        if code == "InvalidEndpointOrModel.NotFound":
            die(
                f"{code}\n   {msg}\n\n"
                "   → 这个模型你没开通。去控制台 → 开通管理 → 开通对应模型。\n"
                "     用 --list-models 可以试出你到底有哪些"
            )
        die(f"{code}\n   {msg[:400]}")
    except urllib.error.URLError as e:
        die(f"连不上网络或地址写错了：{e.reason}")


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=180) as r, dest.open("wb") as f:
        f.write(r.read())


# ─────────────────────────── 参考图 ───────────────────────────
def ensure_refs() -> list[Path]:
    """准备参考图。上游那两张会缓存，不用每次重下。"""
    REF_DIR.mkdir(parents=True, exist_ok=True)
    refs: list[Path] = []

    for name, url in REF_SOURCES.items():
        p = REF_DIR / name
        if not p.exists():
            log(f"  ↓ 下载参考图 {name}")
            try:
                download(url, p)
            except Exception as e:
                log(f"  ⚠️ 下载失败（跳过）：{e}")
                continue
        refs.append(p)

    # ⚠️ 下面这两张是从 GitHub 下的**鲸鱼娘官方设定图**，只对那套有意义。
    #    给第二套宠物喂它们 = 让猫参考蓝发少女（实测会把鲸鱼娘的特征薅过来）。
    if STYLE_ID != "whale-girl":
        refs = [p for p in refs if ".cache" not in str(p)]

    # 这套宠物自己的参考图（**不再是写死的 whale-girl**）
    for p in local_refs(STYLE_ID):
        if p not in refs:
            refs.append(p)

    if not refs:
        die("一张参考图都没有，没法做角色一致性")
    return refs[:MAX_REFS]

def to_data_uri(path: Path) -> str:
    """API 接受 HTTP URL 或 data URI。本地文件只能走 data URI。

    统一转成 png —— webp 虽然也在支持列表里，但 png 最稳。
    """
    from PIL import Image
    import io

    im = Image.open(path).convert("RGBA")
    # 参考图不需要原分辨率，压一下省带宽也省 token
    im.thumbnail((768, 768), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


# ─────────────────────────── 生成 ───────────────────────────
def build_prompt(action: str, extra: str = "") -> str:
    a = ACTIONS[action]
    parts = [a["prompt"], STYLE["styleLock"], STYLE["background"]]
    if extra:
        parts.append(extra)
    return " ".join(parts)


def generate(action: str, count: int, model: str, key: str, size: str,
             strength: float, refs: list[Path], dry_run: bool) -> list[Path]:
    out_dir = GEN_DIR / action
    out_dir.mkdir(parents=True, exist_ok=True)
    prompt = build_prompt(action)

    if dry_run:
        log("\n── DRY RUN（不真的调用，也不花钱）──")
        log(f"  动作      : {action} —— {ACTIONS[action]['desc']}")
        log(f"  模型      : {model}")
        log(f"  尺寸      : {size}   参考图强度: {strength}")
        log(f"  生成张数  : {count}")
        log(f"  参考图    : {len(refs)} 张")
        for r in refs:
            log(f"              {r.relative_to(ROOT)}")
        log(f"\n  提示词（{len(prompt)} 字）:\n    {prompt[:200]}...")
        log(f"\n  产物会落在: {out_dir.relative_to(ROOT)}")
        return []

    log(f"\n🎨 生成中…… 动作={action}  张数={count}  模型={model}")
    body = {
        "model": model,
        "prompt": prompt,
        "response_format": "url",
        "size": size,
        # ⚠️⚠️ 这两个字段是关键：
        #   output_format 默认是 jpeg，而 **jpeg 没有透明通道** ——
        #   不显式传 png 的话，就算模型能出透明底也拿不到。
        "output_format": "png",
        "watermark": False,          # 有水印就没法当素材
    }
    # ⚠️ sequential_image_generation 不能无条件发！
    #   实测 doubao-seedream-5-0-flash-260915 直接报
    #     InvalidParameter: ... is not supported by the current model
    #   只有 count > 1 时才尝试，而且失败要能降级成多次单张调用。
    if count > 1:
        body["sequential_image_generation"] = "auto"
    # 参考图：1 张传字符串，多张传数组（API 约定）
    uris = [to_data_uri(p) for p in refs]
    body["image"] = uris[0] if len(uris) == 1 else uris
    body["reference_strength"] = strength

    t0 = time.time()
    items: list[dict] = []
    if count > 1:
        # 先试组图；当前模型不支持的话降级成 count 次单张
        try:
            d = post_json(API_URL, body, key)
            items = d.get("data") or []
        except SystemExit:
            log("  ⚠️ 组图不被支持（这就是那篇文档说的「当前接口生成单图」），"
                f"降级成 {count} 次单张调用")
            items = []
        if not items:
            body.pop("sequential_image_generation", None)
            for i in range(count):
                log(f"  [{i + 1}/{count}] 单张生成中……")
                d = post_json(API_URL, body, key)
                items.extend(d.get("data") or [])
    else:
        d = post_json(API_URL, body, key)
        items = d.get("data") or []
    dt = time.time() - t0

    if not items:
        die(f"接口没返回图片：{json.dumps(d, ensure_ascii=False)[:400]}")

    saved: list[Path] = []
    for i, item in enumerate(items, 1):
        url = item.get("url")
        if not url:
            log(f"  ⚠️ 第 {i} 张没有 url，跳过")
            continue
        dest = out_dir / f"{action}_{int(time.time())}_{i}.png"
        download(url, dest)
        saved.append(dest)
        log(f"  ✅ [{i}/{len(items)}] {dest.relative_to(ROOT)}  ({dest.stat().st_size // 1024} KB)")

    log(f"\n  耗时 {dt:.1f}s，拿到 {len(saved)} 张")
    return saved


# ─────────────────────────── 检查 ───────────────────────────
def inspect(paths: list[Path]) -> None:
    """检查每张图有没有 alpha —— 这决定后面要不要走抠图那一步。"""
    from PIL import Image
    import numpy as np

    log("\n── 检查透明通道 ──")
    for p in paths:
        try:
            im = Image.open(p).convert("RGBA")
        except Exception as e:
            log(f"  ❌ {p.name}: 打不开 ({e})")
            continue
        a = np.array(im)[:, :, 3]
        opaque = (a > 250).mean() * 100
        verdict = "✅ 有透明区域" if opaque < 99 else "⚠️ 全不透明（要走抠图）"
        log(f"  {p.name}  {im.width}×{im.height}  不透明像素 {opaque:.1f}%   {verdict}")


def process(paths: list[Path], action: str, make_webp: bool) -> list[Path]:
    """候选稿 → 可用素材：抠图 → 去绿边 → 裁切 → 归一化到 512×512。

    归一化的依据是**实测现有帧的构图**（见 README）：
    待机那组坐姿是「内容高 ≈ 画布高的 85%」，所以新帧按同样比例缩放，
    这样接进现有体系时大小才对得上。
    """
    from PIL import Image
    import numpy as np

    out_dir = GEN_DIR / action / "processed"
    out_dir.mkdir(parents=True, exist_ok=True)
    cutout = ROOT / "tools" / "cutout"
    if not cutout.exists():
        die(f"没有 {cutout.relative_to(ROOT)}，先跑 npm run build:cutout")
    if not os.access(cutout, os.X_OK):
        die(f"{cutout.relative_to(ROOT)} 没有执行权限")

    CANVAS = 512
    CONTENT_H = 0.85        # 和待机帧一致
    results: list[Path] = []

    for p in paths:
        cut = out_dir / f"{p.stem}_cut.png"
        # ① 抠图（调 Swift 工具）
        rc = os.system(f'"{cutout}" "{p}" "{cut}" > /dev/null 2>&1')
        if rc != 0 or not cut.exists():
            log(f"  ⚠️ {p.name} 抠图失败，跳过")
            continue

        im = Image.open(cut).convert("RGBA")
        arr = np.array(im).astype(np.float32)

        # ② 去绿边：把绿通道压到不超过红蓝的最大值
        #    实测这一步能把边缘的「绿偏强量」从 52.9 降到 -11.5
        r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
        arr[:, :, 1] = np.minimum(g, np.maximum(r, b))
        im = Image.fromarray(arr.clip(0, 255).astype(np.uint8))

        # ③ 裁到内容包围盒
        a = np.array(im)[:, :, 3]
        ys, xs = np.where(a > 20)
        if len(ys) == 0:
            log(f"  ⚠️ {p.name} 抠完是空的，跳过")
            continue
        im = im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))

        # ④ 归一化：让内容**高度** = 画布的 85%，然后居中
        #
        # ⚠️ **宽度也要一起约束。**
        #    只按高度缩放的话，遇到**很宽**的图（比如"缩成一团/躺下"那几张）
        #    会横向溢出画布 —— 左右**直接被裁掉**。
        #    实测 `idle_pillow_sleep` 就是这样：内容宽 512（整个画布），
        #    左右边距 0px，而其它张都有 38px。
        #
        #    改成"按高和宽各算一个缩放比，取小的那个"——
        #    宽图会被整体缩小（内容高度不到 85%），但**不会裁**。
        MARGIN = 0.04                       # 左右至少留 4% 边距
        scale_h = (CANVAS * CONTENT_H) / im.height
        scale_w = (CANVAS * (1 - MARGIN * 2)) / im.width
        scale = min(scale_h, scale_w)
        if scale < scale_h * 0.999:
            log(f"  ℹ️ {p.name} 偏宽（{im.width}×{im.height}），"
                f"按宽度缩到 {scale/scale_h*100:.0f}% 以免左右被裁")
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))),
                       Image.LANCZOS)
        canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        canvas.alpha_composite(im, ((CANVAS - im.width) // 2,
                                    (CANVAS - im.height) // 2))

        dest = out_dir / f"{p.stem}.png"
        canvas.save(dest)
        results.append(dest)
        if make_webp:
            wp = out_dir / f"{p.stem}.webp"
            canvas.save(wp, format="WEBP", quality=92, method=6)
            log(f"  ✅ {dest.name}  +  {wp.name}")
        else:
            log(f"  ✅ {dest.name}")

    return results


def make_compare(paths: list[Path], action: str) -> None:
    """把新图和现有帧放在多种底色上并排 —— 一眼看出像不像、边缘干不干净。"""
    from PIL import Image

    existing = sorted((ROOT / "assets" / "whale-girl").glob("idle_pillow_*.webp"))[:2]
    tiles = [(Image.open(p).convert("RGBA"), p.stem) for p in existing]
    tiles += [(Image.open(p).convert("RGBA"), p.stem) for p in paths]
    if not tiles:
        return

    T = 200
    bgs = [(176, 214, 236, 255), (255, 255, 255, 255), (40, 44, 52, 255)]
    W, H = T * len(bgs) + 20, T * len(tiles) + 20
    out = Image.new("RGB", (W, H), (235, 235, 235))
    for r, (im, _) in enumerate(tiles):
        im = im.copy()
        im.thumbnail((T - 10, T - 10), Image.LANCZOS)
        for c, bg in enumerate(bgs):
            canvas = Image.new("RGBA", (T, T), bg)
            canvas.alpha_composite(im, ((T - im.width) // 2, (T - im.height) // 2))
            out.paste(canvas.convert("RGB"), (10 + c * T, 10 + r * T))
    dest = GEN_DIR / action / "_compare.png"
    dest.parent.mkdir(parents=True, exist_ok=True)   # action 可能是 "pat-processed" 这种新目录
    out.save(dest)
    log(f"\n🖼  对比图（左=浅蓝底 中=白底 右=深底，每行一张图）:\n   {dest.relative_to(ROOT)}")


# ─────────────────────────── 入口 ───────────────────────────
def main() -> None:
    ap = argparse.ArgumentParser(
        description="用火山方舟 Seedream 给鲸鱼娘生成新动作帧",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--style", default="whale-girl",
                    help="哪一套宠物（读 assets/<style>/style.json 的风格锁，默认 whale-girl）")
    ap.add_argument("--action", help="要生成哪个动作（用 --list 看这套有哪些）")
    ap.add_argument("--count", type=int, default=1, help="生成几张（默认 1，先试水）")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"模型（默认 {DEFAULT_MODEL}）")
    ap.add_argument("--size", default="2K", help="分辨率 1K/2K（默认 2K）")
    ap.add_argument("--strength", type=float, default=0.7,
                    help="参考图影响强度 0~1（默认 0.7；想更像原角色就调高）")
    ap.add_argument("--extra", default="", help="额外追加到提示词里的话")
    ap.add_argument("--dry-run", action="store_true", help="只打印要发什么，不真调用、不花钱")
    ap.add_argument("--process", action="store_true",
                    help="生成后自动抠图 + 去绿边 + 归一化到 512×512")
    ap.add_argument("--webp", action="store_true",
                    help="后处理时同时导出 webp（接进桌宠用的格式）")
    ap.add_argument("--list", action="store_true", help="列出预设动作")
    ap.add_argument("--list-models", action="store_true", help="探测账号开通了哪些模型")
    args = ap.parse_args()

    # ⚠️ 风格必须在解析参数**之后**装载（要读 --style）。
    global STYLE, STYLE_ID, ACTIONS
    STYLE_ID = args.style
    STYLE = load_style(args.style)
    _acts = load_actions(args.style)
    if _acts:
        ACTIONS = _acts          # 这套自己的动作表覆盖内置的

    if args.list:
        log("预设动作：")
        for k, v in ACTIONS.items():
            log(f"  {k:10s} {v['desc']}")
        log(f"\n提示词会自动加上风格锁和背景要求（共 {len(STYLE['styleLock'])} + {len(STYLE['background'])} 字）")
        return

    if args.list_models:
        key = read_key()
        # 别用"逐个试一次生成"的办法探模型 —— 又慢又费钱。
        # /api/v3/models 直接列出账号可见的全部模型和准确 ID。
        req = urllib.request.Request(
            "https://ark.cn-beijing.volces.com/api/v3/models",
            headers={"Authorization": f"Bearer {key}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                ms = json.loads(r.read().decode()).get("data", [])
        except Exception as e:
            die(f"取模型列表失败：{e}")
        log(f"账号可见 {len(ms)} 个模型。图像生成相关：")
        for m in sorted(ms, key=lambda x: x["id"]):
            if "seedream" not in m["id"].lower():
                continue
            st = m.get("status") or ""
            mark = "  ⚠️ " + st if st else "  ✅"
            log(f"  {m['id']:40s}{mark}")
        log("\n（status 为 Retiring/Shutdown 的别用；空的就是可用）")
        return

    if not args.action:
        ap.error("要么给 --action，要么给 --list / --list-models")

    key = read_key() if not args.dry_run else "ark-dry-run"
    log("── 准备参考图 ──")
    refs = ensure_refs()
    log(f"  共 {len(refs)} 张")

    saved = generate(args.action, args.count, args.model, key, args.size,
                     args.strength, refs, args.dry_run)
    if saved:
        inspect(saved)
        make_compare(saved, args.action)
        if args.process:
            log("\n── 后处理（抠图 / 去绿边 / 归一化到 512×512）──")
            done = process(saved, args.action, args.webp)
            if done:
                make_compare(done, args.action + "-processed")
                log(f"\n✅ 处理完 {len(done)} 张 → "
                    f"{GEN_DIR.relative_to(ROOT)}/{args.action}/processed/")
                log("   挑中了再手工拷进 assets/whale-girl/ 并写进 manifest")
        else:
            log("\n下一步：看对比图判断像不像。"
                "满意的话加 --process 自动抠图 + 归一化。")


if __name__ == "__main__":
    main()
