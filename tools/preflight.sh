#!/usr/bin/env bash
#
# preflight.sh — 上线前自动体检。
#
# 跑完看最后的汇总。**它替代不了**那些"要时间或真机"的手动项
# 那些要时间或真机的项（挂机 8 小时、睡眠唤醒、换分辨率、打字不丢焦点）——
# 跑完这个仍然要照着规格书末尾那张手动清单过一遍。
#
# 用法：bash tools/preflight.sh

set -uo pipefail
cd "$(dirname "$0")/.."

# 运行时探测 —— **不要写死本机路径**。
#
# 这个项目原来依赖 DSH 自带的运行时（它的 python 里有 numpy），
# 但那台机器上的绝对路径写进仓库之后，**别人 clone 下来直接就跑不了**。
# 改成按顺序找：环境变量 → DSH 运行时的常见位置 → PATH。
#
# 设 DSH_RUNTIME=/path/to/dependencies 可以显式指定。
find_in_runtimes () {
  local rel="$1"
  for base in "${DSH_RUNTIME:-}" "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies"; do
    [ -n "$base" ] && [ -x "$base/$rel" ] && { printf '%s' "$base/$rel"; return 0; }
  done
  return 1
}

NODE="$(find_in_runtimes node/bin/node || command -v node)"
PY="$(find_in_runtimes python/bin/python3 || command -v python3)"

if [ -z "$NODE" ]; then
  echo "❌ 找不到 node —— 装一个，或者设 DSH_RUNTIME 指向 DSH 的 dependencies 目录"
  exit 2
fi
if [ -z "$PY" ]; then
  echo "❌ 找不到 python3"
  exit 2
fi

FAIL=0
ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; FAIL=1; }
warn() { printf '  ⚠️  %s\n' "$1"; }
info() { printf '  ℹ️  %s\n' "$1"; }

echo
echo "════════ 胖头鱼 · 上线前自动体检 ════════"

echo
echo "── 1. 单元测试（8 个）──"
# ⚠️ **这里必须和 `package.json` 的 `test` 脚本一字不差。**
#    2026-10-11 实测：原来只有 7 个，**漏了 `test-launch`**（开机启动 / 跟随 DSH）。
#    AGENTS.md 里写过「漏了它等于没跑全」—— 但体检脚本自己漏了，谁也没发现，
#    因为漏掉的测试**表现为"全绿"**，不会报错。
#    ⇒ 加完对一遍：`npm test` 里出现的 test-*.mjs 必须都在这个列表里。
for t in test-modules test-plugin test-bubble test-translate \
         test-dialogues test-petspec test-mainmenu test-launch; do
  if "$NODE" "$t.mjs" >/dev/null 2>&1; then ok "$t"; else bad "$t"; fi
done

echo
echo "── 2. Electron 渲染层自检 ──"
# ⚠️ **不要写死 Electron 的路径。**
#    三平台的二进制位置都不一样：
#      macOS    node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
#      Windows  node_modules/electron/dist/electron.exe
#      Linux    node_modules/electron/dist/electron
#    `tools/run-electron.mjs` 用 `require('electron')`（纯 Node 下返回的正好是
#    二进制路径）跨平台找，并且顺手清掉 `ELECTRON_RUN_AS_NODE` ——
#    那个变量会让 Electron 当成纯 Node 跑：不起窗口、不报错、退出码 0，
#    表现是"自检什么都没做就说通过了"。
SELF_OUT=$("$NODE" tools/run-electron.mjs --no-sandbox test-selftest.cjs 2>&1)
if printf '%s' "$SELF_OUT" | grep -q "全部通过"; then
  N=$(printf '%s' "$SELF_OUT" | grep -oE '[0-9]+ 条自检全部通过' | head -1)
  ok "test-selftest  ${N:-全部通过}"
else
  bad "test-selftest"
  printf '%s\n' "$SELF_OUT" | grep "❌" | head -5 | sed 's/^/       /'
fi

echo
echo "── 3. 素材完整性（每套形象各验一次）──"
for s in $(ls assets 2>/dev/null); do
  [ -f "assets/$s/manifest.json" ] || continue
  if "$NODE" tools/verify-pet.mjs "$s" >/dev/null 2>&1; then
    CNT=$("$NODE" tools/verify-pet.mjs "$s" 2>&1 | grep -oE '需要 [0-9]+ 张' | head -1)
    ok "verify-pet $s  ${CNT:-}"
  else
    bad "verify-pet $s"
  fi
done
if "$PY" tools/verify_assets.py >/dev/null 2>&1; then ok "verify_assets"; else bad "verify_assets"; fi

echo
echo "── 4. 版本号一致性（package.json / Info.plist / 台词文件）──"
# 交给专门的脚本查 —— 它知道三处各长什么样，
# 在这里重写一遍正则的话，两处迟早对不上（这个教训刚吃过）。
if "$NODE" tools/sync-version.mjs --check >/tmp/_sv.txt 2>&1; then
  ok "三处版本号一致：$(head -1 /tmp/_sv.txt)"
else
  bad "版本号不一致 —— 跑 node tools/sync-version.mjs 同步"
  grep '❌' /tmp/_sv.txt | head -5 | sed 's/^/       /'
fi

echo
echo "── 5. 打包前置 ──"
[ -d node_modules/electron-builder ] && ok "electron-builder 已装" \
  || bad "electron-builder 未装 → 打不出 .dmg"
[ -f build/icon.icns ] && ok "图标 build/icon.icns 存在" || bad "缺 build/icon.icns"
[ -f LICENSE ] && ok "LICENSE 存在" || bad "缺 LICENSE（别人不知道代码能不能用）"

# ── .dmg 打出来了没有 ──
# ⚠️ 注意区分两种".dev/胖头鱼（开发版）.app"：
#    · 仓库根目录那个 1.9MB 的**壳**（跑 node_modules 里的 Electron，只能自己用）
#    · dist/mac-*/ 里那个真 bundle（能拷给别人）
DMG=$(ls -t dist/*.dmg 2>/dev/null | head -1)
if [ -n "$DMG" ]; then
  SZ=$(du -sm "$DMG" 2>/dev/null | cut -f1)
  ok "打包产物 $(basename "$DMG")  ${SZ}MB"

  # ⚠️ **必须验证 dmg 里装的 app 是哪个版本** —— 光看文件名不行。
  #    实测踩过：`dist/mac-arm64/` 里留着上一次的旧 app 时，
  #    electron-builder 会**复用它**，于是产出 `胖头鱼-0.2.2-arm64.dmg`
  #    但里面装的还是 0.2.1 + 旧 bundle ID（文件名和内容对不上）。
  #    把这种 dmg 发出去，别人装到的就是旧版。
  #    ⚠️ 清的时候要 `rm -rf dist`（整个），只删 `dist/mac-arm64` 不够。
  V_EXPECT=$("$PY" -c "import json;print(json.load(open('package.json'))['version'])" 2>/dev/null)
  ID_EXPECT=$("$PY" -c "import json;print(json.load(open('package.json'))['build']['appId'])" 2>/dev/null)
  # ⚠️ 解析 `hdiutil attach` 的输出取挂载点 —— 但**有两个坑**：
  #    ① 不能用 `-quiet` —— 那样它什么都不输出，解析出来是空的（踩过）
  #    ② **必须按 tab 分隔取最后一个字段** —— 卷名里有空格
  #       （`/Volumes/胖头鱼 0.2.2`），用 `awk '{print $NF}'` 只会拿到 "2"
  #    （`-mountpoint` 那条路已废弃，报 "is deprecated"，别用）
  MP=$(hdiutil attach "$DMG" -nobrowse 2>/dev/null | grep -E "^/dev/" | tail -1 | awk -F'\t' '{print $NF}')
  if [ -n "$MP" ] && [ -f "$MP/胖头鱼.app/Contents/Info.plist" ]; then
    GOT=$("$PY" -c "
import plistlib
d = plistlib.load(open('$MP/胖头鱼.app/Contents/Info.plist','rb'))
print(d.get('CFBundleShortVersionString','?') + '|' + d.get('CFBundleIdentifier','?'))
" 2>/dev/null)
    V_GOT="${GOT%%|*}"; ID_GOT="${GOT##*|}"
    if [ "$V_GOT" = "$V_EXPECT" ] && [ "$ID_GOT" = "$ID_EXPECT" ]; then
      ok "dmg 里的 app 是 ${V_GOT}（${ID_GOT}）—— 和 package.json 对得上"
    else
      bad "dmg 里的 app 是 ${V_GOT}（${ID_GOT}），但 package.json 是 ${V_EXPECT}（${ID_EXPECT}）—— 内容对不上文件名！跑 rm -rf dist && npm run build:mac"
    fi
    hdiutil detach "$MP" -quiet 2>/dev/null
  else
    warn "挂不上 dmg，跳过版本校验"
  fi
else
  # ⚠️ **不要因为"没有 dmg"就直接判失败。**
  #    只发一个平台是完全合法的（比如先只发 Windows）。
  #    所以：有哪个查哪个，**两个都没有**才算失败。
  WIN=$(ls -t dist/*.exe 2>/dev/null | grep -v uninstaller | head -1)
  if [ -n "$WIN" ]; then
    WZ=$(du -sm "$WIN" 2>/dev/null | cut -f1)
    ok "打包产物 $(basename "$WIN")  ${WZ}MB（这次只打了 Windows）"
    info "这次没有 dist/*.dmg —— 只发 Windows 的话是正常的"
  else
    bad "dist/ 里既没有 *.dmg 也没有 *.exe —— 跑 npm run build:mac 或 npm run build:win"
  fi
fi
REAL_APP=$(ls -d dist/mac*/*.app 2>/dev/null | head -1)
if [ -n "$REAL_APP" ]; then
  SZ=$(du -sm "$REAL_APP" 2>/dev/null | cut -f1)
  # 真 bundle 里一定有 app.asar；壳没有
  if [ -f "$REAL_APP/Contents/Resources/app.asar" ]; then
    ok "dist 里的真 bundle ${SZ}MB（含 app.asar ✅ 能拷给别人）"
  else
    warn "dist 里的 app 没有 app.asar —— 可能不是完整产物"
  fi
  # LSUIElement 决定它占不占程序坞
  if "$PY" -c "import plistlib,sys; sys.exit(0 if plistlib.load(open('$REAL_APP/Contents/Info.plist','rb')).get('LSUIElement') else 1)" 2>/dev/null; then
    ok "真 bundle 的 LSUIElement=true（不占程序坞）"
  else
    warn "真 bundle 缺 LSUIElement —— 会在程序坞里多一个图标"
  fi
else
  warn "dist 里没有 .app（只打了 dmg 没解开的正常情况，忽略）"
fi

# 仓库根目录那个壳：留着当开发入口没问题，但要提醒它不是发布物
#
# ⚠️ 它 2026-10-06 从 `胖头鱼.app` 改名成了 `胖头鱼（开发版）.app` ——
#    因为 macOS 的搜索里会同时出现「装好的那个」和「这个壳」两个同名图标，
#    用户分不清哪个是真的（实测被问到）。
#    改名之后一眼能分辨，而且**正式版仍然是 /Applications/胖头鱼.app**。
SHELL_APP='.dev/胖头鱼（开发版）.app'
if [ -d "$SHELL_APP" ]; then
  SZ=$(du -sm "$SHELL_APP" 2>/dev/null | cut -f1)
  [ "${SZ:-0}" -lt 20 ] && info "根目录的 ${SHELL_APP} 只有 ${SZ}MB —— 是开发用的壳，不是发布物（发布用 dist/ 里那个）"
fi

echo
echo "── 6. 隐私与合规 ──"
if [ -f .runtime-profile/launch.log ]; then
  if grep -qiE 'sk-[A-Za-z0-9]{16,}' .runtime-profile/launch.log; then
    bad "日志里疑似有 API Key 明文"
  else
    ok "日志里没有 API Key 明文"
  fi
else
  warn "没有 launch.log，跳过日志检查"
fi
grep -q "剪贴板" README.md 2>/dev/null && ok "README 提到了剪贴板" \
  || bad "README 没写「会读剪贴板」—— 用户自己发现会很严重"
grep -qE "非官方|unofficial" README.md 2>/dev/null && ok "README 有「非官方」声明" \
  || warn "README 缺「非官方」声明"

echo
echo "── 7. 资源占用（要 app 在跑）──"
# ⚠️ **要同时认两种跑法**，否则会误报"app 没在跑"：
#      · 开发版：.../pet-app/node_modules/electron/...
#      · 发布版：/Applications/胖头鱼.app/...
#    这一节已经错过**两次**匹配串了（先是 `runtime-profile`，再是只认 `pet-app`），
#    两次的表现都是"进程明明在、这一节却永远跳过"。
WATCH_PAT='pet-app|胖头鱼\.app'
if pgrep -f "$WATCH_PAT" >/dev/null 2>&1; then
  ps aux | grep -v grep | grep -E "pet-app|胖头鱼\.app" \
    | grep -v "grep" \
    | awk '{c+=$3;m+=$6;n++} END {
        if (n == 0) { print "  ⚠️  没找到桌宠进程"; exit }
        printf "  ℹ️  桌宠 %d 个进程  CPU %.1f%%  内存 %.0f MB\n", n, c, m/1024
        if (c > 5)       print "  ⚠️  空闲 CPU 超过 5% 的门槛 —— 笔记本风扇会转"
        if (m/1024 > 500) print "  ⚠️  内存超过 500MB 的门槛（发布版基线约 455MB，见规格书 §4.4）"
        if (n > 6) print "  ⚠️  进程数偏多（" n " 个）—— 是不是**开发版和发布版同时在跑**？"
      }'
else
  warn "app 没在跑 —— 这一条要启动之后手动测"
fi

echo
echo "── 8. 数据目录 ──"
STATE="$HOME/Library/Application Support/胖头鱼"
if [ -d "$STATE" ]; then
  ok "userData 目录存在"
  for f in window-state.json translate.json; do
    if [ -f "$STATE/$f" ]; then
      MODE=$(stat -f '%Lp' "$STATE/$f" 2>/dev/null || echo '?')
      # ⚠️ 必须写 ${MODE} —— 后面紧跟的是**中文全角括号**，
      #    bash 会把它当成变量名的一部分（踩过：MODE�: unbound variable）
      [ "$MODE" = "600" ] && ok "$f 权限 600" || warn "$f 权限 ${MODE}（不是 600）"
    fi
  done
else
  warn "userData 目录还没有（没启动过？）"
fi

echo
if [ "$FAIL" = 0 ]; then
  echo "════════ ✅ 自动项全部通过 ════════"
else
  echo "════════ ❌ 有阻塞项，见上面 ❌ 的几条 ════════"
fi
echo
echo "⚠️ 别忘了还有一批**要时间或真机**的手动项（长期挂机、多分辨率、真机验收）："
echo "     · 挂机 8 小时（内存会不会涨）"
echo "     · 合盖睡眠唤醒"
echo "     · 换分辨率 / 拔外接显示器"
echo "     · 在编辑器里打字时光标会不会丢"
echo "     · 拷 .dmg 到另一台 Mac 双击能不能开"
echo

exit $FAIL
