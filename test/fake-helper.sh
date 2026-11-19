#!/bin/zsh
# 测试用替身：代替 notify-request，过 FAKE_DELAY 秒后"点击" FAKE_INDEX 号按钮。
# 用法：PERMISSION_NOTIFY_HELPER=$PWD/test/fake-helper.sh FAKE_INDEX=1 opencode run --standalone ...
print -r -- "$(date -u +%FT%T) fake-helper $*" >> "${FAKE_LOG:-/dev/stderr}"
[[ -n ${FAKE_INDEX_FILE:-} && -f $FAKE_INDEX_FILE ]] && FAKE_INDEX=$(<$FAKE_INDEX_FILE)   # 运行中切换"点哪个"，-1 = 取消/超时
sleep "${FAKE_DELAY:-2}"
echo "${FAKE_INDEX:-1}"
