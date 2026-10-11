#!/usr/bin/env bash
#
# make-public-repo.sh — 把当前仓库**导出一份干净的公开版**。
#
# ── 为什么需要它 ──
#
# 公开版是**快照**，不是分支：开发仓库有 240+ 个提交，
# 里面混着 AGENTS.md、内部文档、本机路径、旧的真名署名……
# 而公开版是**从当前 HEAD 重新导出**的单提交仓库。
#
# ⚠️ **所以每改一次代码都要重跑一遍** —— 否则公开版就跟不上。
#    这一步原来是手工做的，很容易漏。
#
# ── 它做四件事 ──
#   ① `git archive HEAD` 导出**只含跟踪文件**的快照（不带历史）
#   ② 在新目录 `git init` + 一个提交（署名叫 ai-pm-lab）
#   ③ **扫一遍有没有不该出现的东西**（本机路径 / 真名 / 内部文件名）
#   ④ 退出码非 0 表示有问题 —— 适合挂进 preflight
#
# ── 用法 ──
#   bash tools/make-public-repo.sh              # 导出 + 检查
#   bash tools/make-public-repo.sh --check      # 只检查现有的公开版，不重新导出
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${PUBLIC_REPO_DIR:-$(cd "$ROOT/.." && pwd)/dsh-harness-pet}"
PY="${DSH_PYTHON:-python3}"
NODE="${DSH_NODE:-node}"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
ok()   { echo "  ${GRN}✅${RST} $*"; }
bad()  { echo "  ${RED}❌${RST} $*"; FAIL=1; }
warn() { echo "  ${YEL}⚠️${RST}  $*"; }
info() { echo "  ${DIM}ℹ️${RST}  $*"; }
FAIL=0

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

echo
echo "  ════════ 公开版仓库 ════════"
echo "  开发仓库  $ROOT"
echo "  公开版    $DEST"
echo

# ─────────────────────────── 导出 ───────────────────────────
if [ "$CHECK_ONLY" = "0" ]; then
  if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
    bad "开发仓库有未提交改动 —— 先提交，否则导出的不是你以为的那份"
    echo
    exit 1
  fi

  rm -rf "$DEST"
  mkdir -p "$DEST"
  # `git archive` 只打包**跟踪的文件** —— 历史、gitignore 掉的东西都不会进来
  git -C "$ROOT" archive HEAD | tar -x -C "$DEST" || { bad "导出失败"; exit 1; }

  (
    cd "$DEST" || exit 1
    git init -q -b main
    git add -A
    git -c user.name="ai-pm-lab" \
        -c user.email="ai-pm-lab@users.noreply.github.com" \
        commit -q -F - <<'MSG'
胖头鱼 · DSH 桌宠 —— 首次发布

一个 macOS / Windows 桌面宠物，盯着 DeepSeek Harness 的 agent 干活。
需要你确认时她举起双手一直举着；长年不理她会开始闹脾气。

详细说明见 README.md。授权见 LICENSE（代码）和 ART-LICENSE.md（美术资产）。
MSG
  ) || { bad "初始化失败"; exit 1; }
  ok "已导出（$(git -C "$DEST" rev-list --count HEAD) 个提交，$(git -C "$DEST" ls-files | wc -l | tr -d ' ') 个文件）"
else
  [ -d "$DEST" ] || { bad "公开版不存在：$DEST"; exit 1; }
  info "只检查，不重新导出"
fi
echo

# ─────────────────────── ① 不该有的文件 ───────────────────────
echo "  ── ① 内部文件不该出现 ──"
INTERNAL=(
  "AGENTS.md"
  "docs/开发笔记.md" "docs/Windows版方案.md" "docs/上线前检查规格书.md"
  "docs/七条需求验收清单.md" "docs/开源发布清单.md"
  "docs/功能方案-用户自定义宠物.md" "docs/项目分析-PC2005-cloud-dsh-pet.md"
)
for f in "${INTERNAL[@]}"; do
  if [ -e "$DEST/$f" ]; then bad "$f 混进来了"; else ok "$f 不在"; fi
done
echo

# ─────────────────────── ② 隐私 / 本机信息 ───────────────────────
echo "  ── ② 隐私（本机路径 / 真名 / 旧身份）──"
# ⚠️ 只看**工作区**。历史是空的（单提交），但如果哪天改成带历史的导出，
#    这里要改成 `git log --all -p` 也扫一遍。
#
# ⚠️⚠️ **要把脚本自己排除掉。**
#    实测踩到：这个脚本的源码里**就写着这些关键词当搜索模式**，
#    于是它每次都把自己报成"泄露"（`/Users/huangjingyan`、`黄靖炎`、
#    `dsh-pet-dev`、`@localhost`、`github_pat_` 全中）。
#    **扫描器扫自己** —— 这类自指问题只能靠显式排除。
SELF_REL="tools/make-public-repo.sh"

# ⚠️⚠️ **`${pat}` 的花括号不能省。**
#    写成 `$pat」` 的话，bash 会把 `pat」` 当成变量名（引号是非 ASCII 的，
#    也算变量名的合法字符）⇒ 报 `pat�: unbound variable`。
#    ⚠️ **这个坑在 preflight.sh 里扫过 6 处，这是第 7 处** ——
#       凡是 `$变量` 后面紧跟中文标点，一律写成 `${变量}`。
for pat in "/Users/huangjingyan" "黄靖炎" "dsh-pet-dev" "@localhost" "github_pat_"; do
  hits=$(grep -rlF "$pat" "$DEST" --exclude-dir=.git 2>/dev/null | grep -v "/${SELF_REL}$")
  n=$(printf '%s' "$hits" | grep -c . || true)
  if [ "$n" = "0" ]; then ok "没有「${pat}」（脚本自己不算）"; else
    bad "「${pat}」出现在 $n 个文件里："
    # ⚠️ 列文件名时用 python 而不是 sed —— sed 碰到中文文件名会报
    #    `RE error: illegal byte sequence`（macOS 的 BSD sed 老问题）。
    printf '%s\n' "$hits" | "$PY" -c "import sys,os; [print('       ' + os.path.relpath(l.strip(), '$DEST')) for l in sys.stdin if l.strip()]"
  fi
done
echo

# ─────────────────────── ③ 密钥 ───────────────────────
echo "  ── ③ 密钥（只报数量，不打印内容）──"
for pat in 'sk-[A-Za-z0-9]{20,}' 'ghp_[A-Za-z0-9]{20,}' 'github_pat_'; do
  # ⚠️ 同样要把脚本自己排除掉 —— 这几个 pattern 就写在它源码里
  n=$(grep -rlE "$pat" "$DEST" --exclude-dir=.git 2>/dev/null | grep -v "/${SELF_REL}$" | wc -l | tr -d ' ')
  if [ "$n" = "0" ]; then ok "没有匹配 ${pat}"; else bad "${pat} 命中 $n 个文件"; fi
done
echo

# ─────────────────────── ④ 该在的东西 ───────────────────────
echo "  ── ④ 该发的文件都在 ──"
MUST=(
  "README.md" "LICENSE" "ART-LICENSE.md" "LICENSES-CC-BY-4.0.txt"
  "package.json" "pnpm-lock.yaml" "src/main.js" "pet-plugin/index.js"
  ".github/workflows/build.yml" "docs/images/hero.gif" "docs/images/styles.png"
)
for f in "${MUST[@]}"; do
  if [ -e "$DEST/$f" ]; then ok "$f"; else bad "$f **缺了**"; fi
done
echo

# ─────────────────────── ⑤ 测试能跑吗 ───────────────────────
echo "  ── ⑤ 干净 clone 出来测试能跑吗 ──"
# ⚠️ 这一步是为了抓「只在本机能跑」的东西 ——
#    实测抓到过 `sync-version.mjs` 会去检查 `.dev/` 里的 Info.plist，
#    而 `.dev/` 是 gitignore 的 ⇒ 在公开版里报"文件不存在" ⇒ 测试变红。
if [ -d "$ROOT/node_modules" ]; then
  ln -sfn "$ROOT/node_modules" "$DEST/node_modules"
  TFAIL=0
  # ⚠️ **这个列表要和 `package.json` 的 `test` 脚本一字不差。**
  #    2026-10-11 实测：这里和 `tools/preflight.sh` 都漏了 `test-launch`
  #    （开机启动 / 跟随 DSH），两处都只跑了 7 个。
  #    漏掉的测试**表现为"全过"** —— 所以谁也没发现。改完对一遍：
  #    `npm test` 里的 test-*.mjs 必须都在这个列表里。
  for t in test-modules test-plugin test-bubble test-translate \
           test-dialogues test-petspec test-mainmenu test-launch; do
    if (cd "$DEST" && "$NODE" "$t.mjs" >/dev/null 2>&1); then :; else
      bad "$t 挂了"; TFAIL=1
    fi
  done
  [ "$TFAIL" = "0" ] && ok "8 个单测全过"
  rm -f "$DEST/node_modules"
else
  warn "开发仓库没有 node_modules，跳过测试（先 pnpm install）"
fi
echo

# ─────────────────────── 汇总 ───────────────────────
echo "  ════════════════════════════════"
if [ "$FAIL" = "0" ]; then
  echo "  ${GRN}✅ 公开版是干净的，可以推${RST}"
  echo
  echo "  推的时候（先在网页建好空仓库：https://github.com/new）"
  echo "    cd \"$DEST\""
  echo "    git remote add origin https://github.com/ai-pm-lab/dsh-harness-pet.git"
  echo "    git push -u origin main"
  echo
  echo "  ⚠️ Token 要勾 \`repo\` **和 \`workflow\`** ——"
  echo "     仓库里有 .github/workflows/，少了 workflow 权限推不上去。"
else
  echo "  ${RED}❌ 有问题，先别推${RST}"
fi
echo "  ════════════════════════════════"
exit "$FAIL"
