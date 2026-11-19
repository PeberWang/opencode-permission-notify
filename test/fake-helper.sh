#!/bin/zsh
# 测试用替身：代替 notify-request，过 FAKE_DELAY 秒后"点击" FAKE_INDEX 号按钮。
# 用法：PERMISSION_NOTIFY_HELPER=$PWD/test/fake-helper.sh FAKE_INDEX=1 opencode run --standalone ...
print -r -- "$(date -u +%FT%T) fake-helper $*" >> "${FAKE_LOG:-/dev/stderr}"
sleep "${FAKE_DELAY:-2}"
echo "${FAKE_INDEX:-1}"
