#!/bin/zsh
# 在私有服务端（--standalone）里跑一轮，台账 / 授权 / 回复都写到 test/run/，不碰线上文件。
# 用法：test/run-standalone.sh "<提示词>"   环境变量 FAKE_INDEX / FAKE_DELAY 控制替身助手的"点击"
set -u
ROOT=${0:A:h:h}
export PERMISSION_NOTIFY_HELPER=$ROOT/test/fake-helper.sh
export PERMISSION_NOTIFY_LEDGER=$ROOT/test/run/ledger.jsonl
export PERMISSION_NOTIFY_GRANTS=$ROOT/test/run/grants.json
export PERMISSION_NOTIFY_REPLIES=$ROOT/test/run/replies
export FAKE_LOG=$ROOT/test/run/fake.log
cd $ROOT/test/sandbox
"/Users/mingpeiwang/Library/Application Support/ai.opencode.desktop/cli/2.3.0-arm64/opencode-cli" \
  run --standalone --auto --archived --title "pn-tier-test" -m claude-agent/haiku "$1" 2>&1 | grep -v '^\s*$' | tail -${TAIL:-12}
