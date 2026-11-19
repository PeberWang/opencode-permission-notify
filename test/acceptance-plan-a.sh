#!/bin/zsh
# 方案 A 真机验证：类 1 落到 pm 且案头离线 → 转人工。证据写 test/evidence/acceptance/A-plan-a.txt。
# 先另开一个终端起服务端：FAKE_DELAY=1 test/serve-isolated.sh fake
# 场景用 test/run/projects/p5-plain（只有全局宿主规则，其中有 shell * allow）；设置、心跳、台账都在 test/run/。
set -u
ROOT=${0:A:h:h}
cd $ROOT/test
E=evidence/acceptance/A-plan-a.txt
L=run/ledger.jsonl
R=$PWD/run/projects
D() { for f; do [[ -e $f ]] && trash $f; done; return 0; }

mkdir -p $R/p5-plain/src
echo '{}' > $R/p5-plain/opencode.jsonc
echo 'export const a = 1' > $R/p5-plain/src/a.ts
D run/settings.json run/pm-online run/fake-index
: > $L

SID=$(python3 -I accept.py session $R/p5-plain)
echo "p5-plan-a $SID" > run/sessions-plan-a.txt
python3 -I accept.py agent $R/p5-plain > /dev/null   # 预热实例
sleep 3

A() { PN_DIR=$R/p5-plain python3 -I accept.py assert $SID "$@"; }
CALLS() { local n; n=$(grep -c . run/fake.log 2>/dev/null); echo ${n:-0}; }
STEP() {   # STEP <标题> <action> <resource...>：发一次判定，打印返回、替身弹窗调用次数、台账新增行
  local title=$1; shift
  echo; echo "### $title"
  : > run/fake.log
  local n0=$(grep -c . $L)
  echo "\$ A $*"; A "$@"
  echo "--- 替身弹窗调用次数：$(CALLS)"
  [[ -s run/fake.log ]] && sed 's/^/    /' run/fake.log
  echo "--- 台账新增 $(( $(grep -c . $L) - n0 )) 行："; tail -n $(( $(grep -c . $L) - n0 )) $L
}

{
echo '## 方案 A：类 1 落到 pm 且案头离线时转人工'
echo "场景 p5-plain，宿主只有全局规则（shell * allow 等）。案头心跳文件 test/run/pm-online（不存在或超过 60 秒未刷新 = 离线）。"

echo; echo '## 1. 案头离线，类 1 经通配 allow 降到 pm → 弹窗问人'
echo 2 > run/fake-index
STEP '1a 替身点「拒绝」' shell "git push origin main"
echo -1 > run/fake-index
STEP '1b 替身返回 -1（取消 / 超时）' shell "git push origin dev"
echo 0 > run/fake-index
STEP '1c 替身点「允许一次」（证明这条路径确实在等人）' shell "git push origin feat"

echo; echo '## 2. 案头离线，类 2、3、4 落到 pm → 照旧放行（pm-offline），不弹窗'
echo '{"permissionClasses":{"2":"pm","3":"pm","4":"pm"}}' > run/settings.json
echo '$ cat test/run/settings.json   （全局宿主规则会把 2、3、4 降成 silent，所以用显式设置把它们放到 pm 档）'; cat run/settings.json
echo 2 > run/fake-index
STEP '2a 类 2 项目外只读' read /etc/hosts
STEP '2b 类 3 项目内执行' shell "printf pn-plan-a"
STEP '2c 类 4 项目内写入' edit src/a.ts
D run/settings.json

echo; echo '## 3. 案头在线，类 1 仍走 pm 托管（pm-online），不弹窗'
touch run/pm-online
echo "\$ touch test/run/pm-online   （mtime $(stat -f %Sm -t %T run/pm-online)）"
STEP '3a 类 1，案头在线' shell "git push origin release"
D run/pm-online

echo; echo '## 4. 用户把类 1 显式设为 silent：以用户为准，来源 user，不弹窗'
echo '{"permissionClasses":{"1":"silent"}}' > run/settings.json
echo '$ cat test/run/settings.json'; cat run/settings.json
STEP '4a 类 1，案头离线，用户 silent' shell "git push origin hotfix"
D run/settings.json run/fake-index

echo; echo '## 5. 台账校验（上面共 8 次判定）'
echo '$ python3 -I test/check-ledger.py test/run/ledger.jsonl 8'
python3 -I check-ledger.py $L 8
echo "exit=$?"
} 2>&1 | tee $E
cp $L evidence/acceptance/ledger-plan-a.jsonl
