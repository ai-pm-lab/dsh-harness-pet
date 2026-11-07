#!/usr/bin/env bash
#
# soak.sh — 长期挂机测试（跑几小时，看有没有内存泄漏 / 崩溃）
#
# 为什么需要这个脚本：
#   "挂 8 小时" 如果只是干挂，早上起来**看不出任何东西** ——
#   除非它崩了（那就不是"发现问题"，是"已经太晚了"）。
#
#   真正要看的是一条**曲线**：内存是不是一直涨、CPU 是不是一直高、
#   插件有没有掉线。所以这个脚本每 5 分钟采一次样，写进 CSV，
#   最后给一份结论。
#
# 用法：
#   bash tools/soak.sh                 # 默认 8 小时、每 5 分钟一次
#   bash tools/soak.sh --hours 1       # 先跑 1 小时试试
#   bash tools/soak.sh --interval 60   # 每 60 秒一次（调试用）
#
# 输出：
#   .verify/soak-<时间戳>.csv    原始采样（可以直接拖进 Excel 画图）
#   .verify/soak-<时间戳>.log    人看的日志
#
# 中途 Ctrl-C 也可以 —— 已经采到的数据会留下，并打印小结。

set -uo pipefail

# ⚠️⚠️ **启动时先把自己复制到临时文件，再从副本重新执行。**
#
#   踩过的坑（8 小时那次，就差最后一步）：
#   **bash 是"边读边执行"脚本的** —— 它记住的是**字节偏移量**。
#   脚本跑到第 8 小时的时候，我在另一个终端**编辑了这个文件**（加 caffeinate），
#   文件一改，偏移量就对不上了，bash 从新文件的那个位置接着读，
#   读到了半截的单词，于是：
#       tools/soak.sh: line 194: M: command not found      ← 读到 "MB" 的中间
#       tools/soak.sh: line 213: break: only meaningful in a 'while' loop
#       tools/soak.sh: line 215: syntax error near unexpected token `done'
#   **数据其实已经采完了**（98 个点都在 CSV 里），但退出阶段崩了，
#   人看到的就是"跑了 8 小时最后报错" —— 很难判断到底算不算过。
#
#   复制走之后，**后面再怎么改原文件都不影响正在跑的那一份**。
if [ -z "${SOAK_REEXEC:-}" ]; then
  _SELF="${BASH_SOURCE[0]}"
  # ⚠️ **必须把原始项目根传过去。**
  #    副本在 /var/folders 里，它自己算 `dirname/..` 会算到那里去 ——
  #    实测 CSV 被写进了 `/var/folders/.../.verify/`，跑完找不到。
  _ORIG_ROOT="$(cd "$(dirname "$_SELF")/.." && pwd)"
  _TMP="$(mktemp -t soak.XXXXXX)"
  cp "$_SELF" "$_TMP" 2>/dev/null &&     SOAK_REEXEC=1 SOAK_ROOT="$_ORIG_ROOT" exec bash "$_TMP" "$@"
  # 复制失败就直接跑（旧行为），总比不跑强
fi

HOURS=8
INTERVAL=300                      # 秒
while [ $# -gt 0 ]; do
  case "$1" in
    --hours)    HOURS="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    -h|--help)  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

ROOT="${SOAK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
OUT="$ROOT/.verify"
mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
CSV="$OUT/soak-$STAMP.csv"
LOG="$OUT/soak-$STAMP.log"

# 采样一次：把「所有相关进程」的 CPU 和内存加起来。
#
# ⚠️ 一个坑：Electron 有 5~6 个进程（主进程 + 渲染 + GPU + 网络 + crashpad），
#    只看一个会低估。但**也不该把 crashpad 算进去** —— 它跟我们的代码无关，
#    而且它自己会长。所以下面按进程名区分开，两个数都记。
# ⚠️⚠️ **过滤条件踩过坑，别改宽。**
#
#   第一版写的是 `/胖头鱼|Electron/` —— 结果**把别的 app 也算进来了**：
#     · VSCode 的 chrome_crashpad_handler（它也是 Electron）
#     · WorkBuddy.app（另一个 Electron 应用，4 个进程 / 480MB）
#   10 个进程 / 802MB 全是虚的，基线本来是 5 个 / 455MB。
#
#   **只匹配命令行里的 `胖头鱼`** —— 那是 app 的可执行名，
#   开发壳和装好的 app 都叫这个，别的 app 不会叫这个。
#
#   ⚠️ **但还得排除"调用这个脚本的那条 shell 命令"** —— 又踩了一次：
#      `ps -Ao command | grep 胖头鱼` 会**匹配到自己**，因为那条命令行里
#      就写着"胖头鱼"三个字（比如 `bash -c ... ps ... 胖头鱼 ...`）。
#      实测：明明一个真进程都没有，脚本却报"进程 2"。
#      所以加了 `!/bash -c/ && !/soak\.sh/` —— 包裹脚本一定带这两个特征。
#
#   另外**要区分两种安装形态**（它们的进程数不一样）：
#     · `/Applications/胖头鱼.app`  —— 发布版，5 个进程（多一个 crashpad）
#     · 开发壳                      —— 4 个进程（跑 node_modules 里的 Electron）
#   **挂机测试要测发布版** —— 那才是用户会用的东西。
#
#   ⚠️ **判断依据不能看命令行里有没有 `.dev/`** —— 又踩了一次：
#      开发壳的子进程命令行长这样（**里面根本没有 `.dev/`**）：
#        .../pet-app/node_modules/.pnpm/electron@33.2.0/.../Electron.app/Contents/MacOS/Electron
#      于是 app=0 且 dev=0，脚本判成"没找到进程" —— 而它明明在跑。
#      **正确的是看 `node_modules`**：开发形态的进程一定带这个路径。
sample () {
  ps -Ao pcpu,rss,command 2>/dev/null | awk '
    /胖头鱼/ && !/awk/ && !/grep/ && !/bash -c/ && !/soak\.sh/ {
      cpu += $1; mem += $2
      if ($0 ~ /crashpad/) { c_cpu += $1; c_mem += $2; c_n++ }   # crashpad 不是我们的代码
      else { n++ }
      if ($0 ~ /\/Applications\/胖头鱼\.app/) app = 1
      else if ($0 ~ /node_modules/) dev = 1
    }
    END { printf "%.1f %d %d %.1f %d %d %d", cpu, mem, n, c_cpu, c_mem, app, dev }'
}

# 开跑之前先说清楚"现在测的是哪一个" —— 测错对象的话整晚白挂
check_target () {
  ps -Ao command 2>/dev/null | awk '
    /胖头鱼/ && !/awk/ && !/grep/ && !/bash -c/ && !/soak\.sh/ {
      if ($0 ~ /\/Applications\/胖头鱼\.app/) app = 1
      else if ($0 ~ /node_modules/) dev = 1
    }
    END { print (app ? "app" : "") (dev ? " dev" : "") }'
}

echo "════════ 胖头鱼 · 挂机测试 ════════" | tee "$LOG"
echo "  时长      ：${HOURS} 小时"                | tee -a "$LOG"
echo "  采样间隔  ：${INTERVAL} 秒"              | tee -a "$LOG"
echo "  采样次数  ：约 $(( HOURS * 3600 / INTERVAL )) 次" | tee -a "$LOG"
echo "  原始数据  ：$CSV"                        | tee -a "$LOG"
echo "  中途 Ctrl-C 也能留下已采到的数据。"      | tee -a "$LOG"
echo                                   | tee -a "$LOG"
TARGET="$(check_target)"
case "$TARGET" in
  *app*dev*|*dev*app*)
      echo "  ⚠️  **装好的 app 和开发壳同时在跑** —— 下面的数字是两个加一起的，" | tee -a "$LOG"
      echo "      没有意义。先关掉一个再跑：                                    " | tee -a "$LOG"
      echo "        pkill -9 -f 胖头鱼; pkill -9 -f node_modules/.pnpm/electron" | tee -a "$LOG" ;;
  *dev*) echo "  ⚠️  **现在跑的是开发壳**（不是装好的 app）。"                  | tee -a "$LOG"
      echo "      挂机测试应该测发布版 —— 那才是用户会用的东西，而且进程数不同。" | tee -a "$LOG"
      echo "        pkill -9 -f 胖头鱼; pkill -9 -f node_modules/.pnpm/electron" | tee -a "$LOG"
      echo "        open -a /Applications/胖头鱼.app                          "   | tee -a "$LOG" ;;
  *app*) echo "  ✅ 测的是**装好的 app**（/Applications/胖头鱼.app）—— 对的。"   | tee -a "$LOG" ;;
  *)     echo "  ❌ **没找到胖头鱼进程** —— 先启动她再跑这个脚本。"             | tee -a "$LOG" ;;
esac
echo                                   | tee -a "$LOG"
echo                                   | tee -a "$LOG"
echo "时间,已运行分钟,进程数,CPU%,内存MB,crashpad进程,crashpad内存MB,是发布版,是开发版" > "$CSV"

# ⚠️ **Mac 一睡，她就跟着停 —— 8 小时白挂。**
#
# 实测本机 `pmset` 的 `sleep` 是 1 分钟（当时只是被 sharingd/powerd 临时挡着，
# 挡的人一走就睡了），所以脚本自己挂一个 `caffeinate -i -w $$`：
#   · `-i` 只挡**系统睡眠**，不挡屏幕睡眠（屏幕黑了不影响她跑）
#   · `-w $$` **正好盯到本脚本退出**，不会多留
# 退出时一起收掉，别留个一直不让电脑睡的进程在那。
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -i -w $$ &
  CAFFEINATE_PID=$!
  echo "  ☕ 已挂 caffeinate（pid ${CAFFEINATE_PID}）—— 防止 Mac 睡着把试验打断" | tee -a "$LOG"
else
  CAFFEINATE_PID=""
  echo "  ⚠️  找不到 caffeinate —— 自己确认「节能」里没设成很快睡眠"              | tee -a "$LOG"
fi

START=$(date +%s)
END=$(( START + HOURS * 3600 ))
ROUND=0
CRASH=0
DOWN=0
FIRST_MEM=""
LAST_MEM=""

trap 'echo; echo "  （收到中断，正在收尾…）"; finish' INT TERM

finish () {
  [ -n "${CAFFEINATE_PID:-}" ] && kill "$CAFFEINATE_PID" 2>/dev/null
  local now elapsed mins
  now=$(date +%s); elapsed=$(( now - START )); mins=$(( elapsed / 60 ))
  echo                                            | tee -a "$LOG"
  echo "════════ 小结（跑了 ${mins} 分钟，采样 ${ROUND} 次）════════" | tee -a "$LOG"

  if [ "$DOWN" -gt 0 ]; then
    echo "  ⚠️  有 $DOWN 次采样没找到进程 —— 跑的过程中她**掉过**。" | tee -a "$LOG"
    echo "      去 .runtime-profile/launch.log 看有没有崩溃记录。"     | tee -a "$LOG"
  else
    echo "  ✅ 全程都在（每次都找得到进程）"                            | tee -a "$LOG"
  fi

  if [ -n "$FIRST_MEM" ] && [ -n "$LAST_MEM" ] && [ "$FIRST_MEM" -gt 0 ] 2>/dev/null; then
    local grow pct
    grow=$(( LAST_MEM - FIRST_MEM ))
    pct=$(( grow * 100 / FIRST_MEM ))
    echo "  内存：${FIRST_MEM}MB → ${LAST_MEM}MB  （${grow:+$grow}MB，${pct}%）" | tee -a "$LOG"
    if [ "$pct" -ge 100 ]; then
      echo "  ❌ **涨了一倍以上** —— 这是内存泄漏的典型特征，要查。" | tee -a "$LOG"
    elif [ "$pct" -ge 50 ]; then
      echo "  ⚠️  涨了 ${pct}% —— 有可能只是缓存，也可能有问题。看看曲线是"台阶"还是"斜坡"。" | tee -a "$LOG"
    else
      echo "  ✅ 涨幅在正常范围内（Chromium 自己会缓存，小幅上涨是正常的）" | tee -a "$LOG"
    fi
  fi

  echo                                                                     | tee -a "$LOG"
  echo "  详细数据：$CSV"                                                  | tee -a "$LOG"
  echo "  看曲线的办法（按分钟和内存两列画）："                            | tee -a "$LOG"
  echo "    open -a Numbers \"$CSV\"     # 或者直接拖进 Excel"             | tee -a "$LOG"
  echo "════════════════════════════════════"                              | tee -a "$LOG"
  exit 0
}

while :; do
  ROUND=$(( ROUND + 1 ))
  NOW=$(date +%s)
  MINS=$(( (NOW - START) / 60 ))
  TS=$(date +%H:%M:%S)

  read -r CPU MEM N C_CPU C_MEM IS_APP IS_DEV <<< "$(sample)"
  : "${CPU:=0}"; : "${MEM:=0}"; : "${N:=0}"; : "${C_MEM:=0}"; : "${IS_APP:=0}"; : "${IS_DEV:=0}"

  if [ "${N:-0}" -eq 0 ]; then
    DOWN=$(( DOWN + 1 ))
    printf "  %s  %4d 分  ⚠️  没找到进程\n" "$TS" "$MINS" | tee -a "$LOG"
  else
    MMB=$(( MEM / 1024 ))
    printf "  %s  %4d 分  进程 %d  CPU %5.1f%%  内存 %4dMB\n" "$TS" "$MINS" "$N" "$CPU" "$MMB" | tee -a "$LOG"
    if [ -z "$FIRST_MEM" ]; then FIRST_MEM=$MMB; fi
    LAST_MEM=$MMB
  fi
  echo "$TS,$MINS,$N,$CPU,$(( MEM / 1024 )),$C_CPU,$(( C_MEM / 1024 )),$IS_APP,$IS_DEV" >> "$CSV"

  # 每 12 次（默认 1 小时）报一次阶段结论，方便瞄一眼
  if [ $(( ROUND % 12 )) -eq 0 ] && [ -n "$FIRST_MEM" ]; then
    echo "      └─ 每小时的进度点。到目前内存 ${FIRST_MEM}MB → ${LAST_MEM}MB" | tee -a "$LOG"
  fi

  [ "$NOW" -ge "$END" ] && break
  sleep "$INTERVAL"
done

finish
