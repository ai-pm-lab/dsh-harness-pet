#!/usr/bin/env python3
"""
preview-readme.py — 把 README.md 渲染成浏览器能看的 HTML（和 GitHub 上一样）。

── 为什么要有这个 ──
`.md` 用默认程序打开只能看到源码，**表格和图片的排版都没了**。
GitHub 上是什么样，本地也得能看到 —— 否则"README 好不好看"就只能靠想象。

── ⚠️ 踩过的坑：相对路径 ──
第一版把预览 HTML 放在 `桌宠文件/`（交付目录），而 README 里的图片写的是
**相对路径** `docs/images/hero.gif`。于是浏览器去
`桌宠文件/docs/images/hero.gif` 找 —— **那个目录不存在，图片全坏**。
而且我当时**没验证就说"已打开"**，用户看到的是 4 个破图。

⇒ 现在**一律把图片路径改写成绝对 `file://`**，并且
**生成后逐个验证文件真的存在** —— 有坏的直接报错退出，不静默糊过去。

── 用法 ──
    python3 tools/preview-readme.py            # 生成 + 打开
    python3 tools/preview-readme.py --no-open  # 只生成
"""
import argparse
import html
import pathlib
import re
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent


def inline(s):
    """行内 Markdown → HTML。只处理 README 里真的用到的那些。"""
    s = html.escape(s, quote=False)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'~~([^~]+)~~', r'<del>\1</del>', s)
    s = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', r'<img alt="\1" src="\2">', s)
    s = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', s)
    return s


def rewrite_images(md_text, base):
    """
    把图片/链接的相对路径改成**绝对 file:// URI**。

    ⚠️ 这是上一版坏掉的原因 —— 预览文件不在仓库根，
       相对路径会解析到别处。改成绝对路径就和预览放在哪无关了。
    """
    missing = []

    def fix(m):
        alt, path = m.group(1), m.group(2)
        if re.match(r'^[a-z]+:', path) or path.startswith('#'):
            return m.group(0)                 # 外链 / 锚点不动
        p = (base / path).resolve()
        if p.exists():
            return f'![{alt}]({p.as_uri()})'
        missing.append(path)
        return m.group(0)                     # 找不到就原样留着，最后统一报

    fixed = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', fix, md_text)
    return fixed, missing


def render(md_text, base):
    lines = md_text.split('\n')
    out = []
    in_code = in_table = in_list = False

    def close_list():
        nonlocal in_list
        if in_list:
            out.append('</ul>')
            in_list = False

    def close_table():
        nonlocal in_table
        if in_table:
            out.append('</tbody></table>')
            in_table = False

    for line in lines:
        if line.startswith('```'):
            close_list(); close_table()
            out.append('</pre>' if in_code else '<pre>')
            in_code = not in_code
            continue
        if in_code:
            out.append(html.escape(line))
            continue
        if re.match(r'^-{3,}$', line.strip()):
            close_list(); close_table(); out.append('<hr>'); continue

        h = re.match(r'^(#{1,4})\s+(.*)$', line)
        if h:
            close_list(); close_table()
            n = len(h.group(1))
            out.append(f'<h{n}>{inline(h.group(2))}</h{n}>')
            continue

        if line.startswith('|'):
            cells = [c.strip() for c in line.split('|')[1:-1]]
            if re.match(r'^\|[\s:\-]+\|', line):
                continue
            if not in_table:
                close_list(); out.append('<table>'); in_table = True
                out.append('<tr>' + ''.join(f'<th>{inline(c)}</th>' for c in cells) + '</tr>')
                continue
            out.append('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in cells) + '</tr>')
            continue
        close_table()

        li = re.match(r'^[-*]\s+(.*)$', line)
        if li:
            if not in_list:
                out.append('<ul>'); in_list = True
            out.append(f'<li>{inline(li.group(1))}</li>')
            continue

        if line.startswith('> '):
            close_list(); out.append(f'<blockquote>{inline(line[2:])}</blockquote>'); continue

        if not line.strip():
            close_list(); continue

        close_list(); out.append(f'<p>{inline(line)}</p>')

    return '\n'.join(out)


CSS = """
body{max-width:900px;margin:0 auto;padding:32px 24px 80px;
  font:16px/1.7 -apple-system,"PingFang SC",sans-serif;color:#1f2328;background:#fff}
h1{font-size:2em;border-bottom:1px solid #d8dee4;padding-bottom:.3em}
h2{font-size:1.5em;border-bottom:1px solid #d8dee4;padding-bottom:.3em;margin-top:1.6em}
h3{font-size:1.2em;margin-top:1.4em}
img{max-width:100%;border-radius:6px}
code{background:#f6f8fa;padding:.2em .4em;border-radius:6px;font-size:85%;
  font-family:ui-monospace,Menlo,monospace}
pre{background:#f6f8fa;padding:16px;border-radius:6px;overflow:auto}
pre code{background:none;padding:0}
table{border-collapse:collapse;margin:16px 0;display:block;overflow:auto}
th,td{border:1px solid #d8dee4;padding:6px 13px}
th{background:#f6f8fa;font-weight:600}
blockquote{border-left:4px solid #d0d7de;margin:0;padding:0 1em;color:#656d76}
hr{border:0;border-top:1px solid #d8dee4;margin:24px 0}
ul{padding-left:2em}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
.bar{position:fixed;top:0;left:0;right:0;background:#e8f5e9;
  border-bottom:1px solid #a5d6a7;padding:8px 24px;font-size:13px;color:#1b5e20}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--md', default=str(ROOT / 'README.md'))
    ap.add_argument('--out', default=None)
    ap.add_argument('--no-open', action='store_true')
    args = ap.parse_args()

    md_path = pathlib.Path(args.md)
    base = md_path.parent
    md_text = md_path.read_text()

    fixed, missing = rewrite_images(md_text, base)

    # ⚠️ **有图找不到就直接失败**，不要生成一份看起来正常、其实图全坏的预览。
    if missing:
        print('  ❌ 这些图找不到（README 里的路径可能写错了）：')
        for m in missing:
            print(f'       {m}   →   {(base / m).resolve()}')
        return 1

    body = render(fixed, base)
    out_path = pathlib.Path(args.out) if args.out else base / '.verify' / 'readme-preview.html'
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">'
        f'<title>README 预览 · {md_path.name}</title><style>{CSS}</style></head><body>'
        f'<div class="bar">📄 <b>{html.escape(str(md_path.name))}</b>'
        f'（{md_path}）—— 和 GitHub 上看到的一样；图片已改成绝对路径</div>'
        f'<div style="height:28px"></div>{body}</body></html>')

    # 数一下有几张图，并且确认它们真的能打开
    imgs = re.findall(r'<img[^>]+src="([^"]+)"', out_path.read_text())
    print(f'  ✅ {out_path}')
    print(f'     图 {len(imgs)} 张，全部存在：')
    for u in imgs:
        p = pathlib.Path(urllib.parse.unquote(urllib.parse.urlparse(u).path))
        print(f'       {"✅" if p.exists() else "❌"} {p.name:<18} {p.stat().st_size/1024:>7.0f} KB'
              if p.exists() else f'       ❌ {p}')

    if not args.no_open:
        import subprocess
        subprocess.run(['open', str(out_path)], check=False)
        print('     （已在浏览器打开）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
