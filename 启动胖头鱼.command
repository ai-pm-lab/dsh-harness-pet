#!/usr/bin/env bash
# 双击即可启动。macOS 会把 .command 文件交给终端执行。
cd "$(dirname "$0")"
exec ./start.sh "$@"
