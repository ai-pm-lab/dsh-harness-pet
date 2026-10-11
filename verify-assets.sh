#!/usr/bin/env bash
# 美术资产验收。每次重建素材后都应该跑一遍。
#
# 抓的是「肉眼该看出来、但很容易漏掉」的问题 ——
# need_input 的白外套被算法挖空过一次，就是因为只扫了一眼缩略图。
set -eo pipefail
cd "$(dirname "$0")"
# ⚠️ **默认要用打包运行时里的那个 python，不是系统的。**
#
#    这个脚本要 numpy，而系统自带的 python3 没有（实测
#    `ModuleNotFoundError: No module named 'numpy'`）。
#    原来的写法 `PY="${DSH_PYTHON:-python3}"` 默认落到系统 python，
#    于是 **`npm run verify:assets` 一直是坏的**，而 `tools/preflight.sh`
#    用的是运行时 python —— 两条路一个红一个绿，很容易被糊弄过去。
#
#    优先级：显式指定的 DSH_PYTHON > 运行时自带的 > PATH 里的 python3
# ⚠️ **不要写死本机路径** —— 别人 clone 下来会跑不了。
#    按顺序找：DSH_RUNTIME → DSH 运行时的默认位置 → 系统的 python3。
for _base in "${DSH_RUNTIME:-}" "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies"; do
  [ -n "$_base" ] && [ -x "$_base/python/bin/python3" ] && { RUNTIME_PY="$_base/python/bin/python3"; break; }
done
RUNTIME_PY="${RUNTIME_PY:-}"
if [ -n "${DSH_PYTHON:-}" ]; then
  PY="$DSH_PYTHON"
elif [ -x "$RUNTIME_PY" ]; then
  PY="$RUNTIME_PY"
else
  PY="python3"
fi

# 真要用了才发现没 numpy 的话，报错信息要能指路
if ! "$PY" -c 'import numpy' 2>/dev/null; then
  echo "⚠️  $PY 里没有 numpy —— 这个脚本要它。"
  echo "    设 DSH_PYTHON 指向一个带 numpy 的 python，例如："
  echo "      DSH_PYTHON=$RUNTIME_PY ./verify-assets.sh"
  exit 1
fi

exec "$PY" tools/verify_assets.py "$@"
