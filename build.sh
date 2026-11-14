#!/bin/zsh
# 编译通用二进制助手 + 本地安装
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p bin

echo "==> 编译 notify-request（arm64 + x86_64）"
clang -O2 -fobjc-arc -arch arm64 -arch x86_64 \
    -framework Foundation -framework CoreFoundation -framework AppKit \
    -o bin/notify-request native/notify-request.m

lipo -info bin/notify-request | sed 's/^/    /'
