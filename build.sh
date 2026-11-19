#!/bin/zsh
# 编译通用二进制助手（弹窗 + 设置窗口）
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p bin

for name in notify-request permission-settings; do
    echo "==> 编译 $name（arm64 + x86_64）"
    clang -O2 -fobjc-arc -arch arm64 -arch x86_64 \
        -framework Foundation -framework CoreFoundation -framework AppKit \
        -o bin/$name native/$name.m
    lipo -info bin/$name | sed 's/^/    /'
done
