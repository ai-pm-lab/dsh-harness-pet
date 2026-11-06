#!/usr/bin/env bash
#
# 启动胖头鱼桌宠。
#
# 处理了三个陷阱：
#   1. ELECTRON_RUN_AS_NODE —— DSH 环境会设这个变量，它让 Electron 退化成
#      普通 Node 进程（没有 GUI、app 是 undefined）。必须取消。
#   2. Chromium 沙盒嵌套 —— 在受限环境里跑需要 --no-sandbox。
#      正常从 Finder 双击启动时不需要。
#   3. bash 3.2 的空数组 —— macOS 自带的是 2007 年的 bash 3.2，
#      在 `set -u` 下 `"${EMPTY[@]}"` 会报 unbound variable 并让脚本直接退出。
#      所以这里**不用 set -u**，数组也用 `${ARR[@]+"${ARR[@]}"}` 的老写法。
#
set -eo pipefail

cd "$(dirname "$0")"

ELECTRON="./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

if [ ! -x "$ELECTRON" ]; then
  echo "❌ 找不到 Electron 二进制。先跑："
  echo "   pnpm install"
  echo "   node node_modules/electron/install.js"
  exit 1
fi

ARGS=(".")
EXTRA=()

# 演示模式：自动轮播各状态，用来验收素材
if [ "${1:-}" = "--demo" ]; then
  ARGS+=("--demo")
  echo "▶ 演示模式：每 4 秒切换一个状态"
fi

# 只有在受限环境（例如 DSH 内部）才需要关沙盒 + 换数据目录
#
# ⚠️ 别在这里 `mkdir -p "$HOME/Library/Application Support/胖头鱼"`。
# 曾经这么写过，后果有两个：
#   ① 探测失败时留下一个空目录；
#   ② 那个空目录和 Electron 真正的 userData 不是同一个地方 ——
#      Electron 用的是 package.json 的 `productName`（"胖头鱼 · DSH 桌宠"），
#      于是 App 把 bridge.json 写在 A、插件去 B 找，
#      表现成「插件永远连不上」，两边还都不报错。
# 用 $HOME 本身探测可写性就够了。
if [ "${DSH_NO_SANDBOX:-}" = "1" ]; then
  EXTRA+=("--no-sandbox")
elif [ ! -w "$HOME" ]; then
  EXTRA+=("--no-sandbox")
  EXTRA+=("--user-data-dir=$(pwd)/.runtime-profile")
  echo "ℹ️  家目录不可写，改用项目内的数据目录并关闭 Chromium 沙盒"
fi

# 让渲染进程的 console.log 也进日志。
# 桌宠的动画逻辑全在 renderer 里，不开这个就只能靠猜。
# 日志落在 .runtime-profile/launch.log，每次启动覆盖。
EXTRA+=("--enable-logging=stderr")

# 但 Electron 的 --enable-logging 会同时打开 Chromium 的噪音日志，
# 用环境变量把级别压到只留 console
export ELECTRON_ENABLE_LOGGING=1

echo "▶ 启动胖头鱼 · DSH 桌宠"

# ${EXTRA[@]+...} 是空数组在 bash 3.2 下的安全展开写法
exec env -u ELECTRON_RUN_AS_NODE "$ELECTRON" "${ARGS[@]}" ${EXTRA[@]+"${EXTRA[@]}"}
