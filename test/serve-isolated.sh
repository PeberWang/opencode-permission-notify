#!/bin/zsh
# 起一个私有 opencode serve（端口 4199），插件的台账 / 设置 / 授权 / 待答都写到 test/run/，不碰线上文件。
# 用法：test/serve-isolated.sh [fake|real]   fake = 替身助手（FAKE_INDEX / FAKE_DELAY 控制"点击"），real = 真弹窗
set -u
ROOT=${0:A:h:h}
RUN=$ROOT/test/run
mkdir -p $RUN
if [[ ${1:-fake} == real ]]; then
  unset PERMISSION_NOTIFY_HELPER
else
  export PERMISSION_NOTIFY_HELPER=$ROOT/test/fake-helper.sh
fi
export PERMISSION_NOTIFY_LEDGER=$RUN/ledger.jsonl
export PERMISSION_NOTIFY_SETTINGS=$RUN/settings.json
export PERMISSION_NOTIFY_GRANTS=$RUN/grants.json
export PERMISSION_NOTIFY_PENDING=$RUN/pending
export PERMISSION_NOTIFY_REPLIES=$RUN/replies
export PERMISSION_NOTIFY_LOG=$RUN/notify.log
export PERMISSION_NOTIFY_PM_HEARTBEAT=$RUN/pm-online
export FAKE_LOG=$RUN/fake.log
export FAKE_INDEX_FILE=$RUN/fake-index
export OPENCODE_SERVER_PASSWORD=${OPENCODE_SERVER_PASSWORD:-pn-accept}
CLI_DIR="$HOME/Library/Application Support/ai.opencode.desktop/cli"
CLI=$(ls -d "$CLI_DIR"/*-arm64/opencode-cli 2>/dev/null | sort -V | tail -1)
exec "${CLI:?找不到 opencode-cli}" serve --hostname 127.0.0.1 --port 4199
