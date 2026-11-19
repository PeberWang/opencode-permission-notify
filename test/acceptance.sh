#!/bin/zsh
# 真机验收（第 1、2、3、5、7 条）：对私有服务端造判定，逐条看台账，证据写到 test/evidence/acceptance/。
# 先另开一个终端起服务端：FAKE_INDEX=2 FAKE_DELAY=1 test/serve-isolated.sh fake
# 场景项目在 test/run/projects/ 下，各自带一份项目级 opencode.jsonc；日常的全局配置不动。
# 注意：本仓库在 OpenCode 里存有「总是允许 shell echo *」等授权，所以场景命令用 printf pn-*。
set -u
ROOT=${0:A:h:h}
cd $ROOT/test
E=evidence/acceptance
L=run/ledger.jsonl
R=$PWD/run/projects
CLI=$(ls -d "$HOME/Library/Application Support/ai.opencode.desktop/cli"/*-arm64/opencode-cli | sort -V | tail -1)
MODEL=${PN_MODEL:-deepseek/deepseek-flash}
D() { for f; do [[ -e $f ]] && trash $f; done; return 0; }
mkdir -p $E

# ---------- 场景项目 ----------
mkdir -p $R/{p0-ask,p1-allow,p3-deny,p5-plain/src}
cat > $R/p0-ask/opencode.jsonc <<'EOF'
{
  // 验收：宿主对 printf pn-* 要求询问
  "permissions": [
    { "action": "shell", "resource": "printf pn-*", "effect": "ask" }
  ]
}
EOF
cat > $R/p1-allow/opencode.jsonc <<'EOF'
{
  // 验收：在 p0 的基础上加一条 shell allow（后匹配者优先）
  "permissions": [
    { "action": "shell", "resource": "printf pn-*", "effect": "ask" },
    { "action": "shell", "resource": "printf pn-*", "effect": "allow" }
  ]
}
EOF
cat > $R/p3-deny/opencode.jsonc <<'EOF'
{
  // 验收：宿主拒绝 printf pn-*
  "permissions": [
    { "action": "shell", "resource": "printf pn-*", "effect": "deny" }
  ]
}
EOF
echo '{}' > $R/p5-plain/opencode.jsonc
echo 'export const a = 1' > $R/p5-plain/src/a.ts

: > $L
: > run/fake.log
D run/settings.json run/sessions.txt

for p in p0-ask p1-allow p3-deny p5-plain; do
  echo "$p $(python3 -I accept.py session $R/$p)" >> run/sessions.txt
  python3 -I accept.py agent $R/$p > /dev/null   # 预热实例：实例刚起时的第一条请求可能赶在钩子注册之前
done
sleep 3

S() { grep "^$1 " run/sessions.txt | cut -d' ' -f2; }
A() { local p=$1; shift; PN_DIR=$R/$p python3 -I accept.py assert $(S $p) "$@"; }
RUN() { local p=$1 title=$2; shift 2; (cd $R/$p && OPENCODE_SERVER_PASSWORD=${OPENCODE_SERVER_PASSWORD:-pn-accept} "$CLI" run --server http://127.0.0.1:4199 --archived --title "$title" -m $MODEL "$@" 2>&1 | grep -v '^\s*$' | tail -8); }
EXPECT=0   # 预期写入台账的判定数（直接断言的宿主 deny 不经过钩子，不计）

{
echo '## 第 1 条：宿主加一条 shell allow，项目内 shell 不再弹窗'
echo
echo '### 1a 基线 p0-ask：宿主 printf pn-* ask'
echo '$ A p0-ask shell "printf pn-one"'
A p0-ask shell "printf pn-one"; EXPECT=$((EXPECT+1))
echo '--- 替身弹窗调用记录（有一行 = 真机会弹窗；替身点了「拒绝」）'; cat run/fake.log
echo '--- 台账新增行'; tail -1 $L
echo
echo '### 1b p1-allow：同一条 ask 之后再加 { shell, "printf pn-*", allow }'
: > run/fake.log
echo '$ A p1-allow shell "printf pn-one"'
A p1-allow shell "printf pn-one"; EXPECT=$((EXPECT+1))
echo "--- 替身弹窗调用次数：$(grep -c . run/fake.log)"
echo '--- 台账新增行'; tail -1 $L
} 2>&1 | tee $E/1-shell-allow.txt

{
echo '## 第 2 条：宿主 ask，设置里把类 3 显式设为 silent'
: > run/fake.log
echo '{"permissionClasses":{"3":"silent"}}' > run/settings.json
echo '$ cat test/run/settings.json   （插件自己的设置文件，不碰宿主配置；服务端不重启）'; cat run/settings.json
echo '$ A p0-ask shell "printf pn-two"'
A p0-ask shell "printf pn-two"; EXPECT=$((EXPECT+1))
echo "--- 替身弹窗调用次数：$(grep -c . run/fake.log)"
echo '--- 台账新增行'; tail -1 $L
} 2>&1 | tee $E/2-user-over-ask.txt

{
echo '## 第 3 条：宿主 deny，插件任何设置都放不开'
echo '{"permissionClasses":{"1":"silent","2":"silent","3":"silent","4":"silent","5":"silent","6":"silent"}}' > run/settings.json
echo '$ cat test/run/settings.json'; cat run/settings.json
echo
echo '### 3a 直接断言（p3-deny：宿主 printf pn-* deny）'
N0=$(grep -c . $L)
echo '$ A p3-deny shell "printf pn-three"'
A p3-deny shell "printf pn-three"
echo "--- 台账新增行数：$(( $(grep -c . $L) - N0 ))（OpenCode 对显式 deny 不调用 evaluate 钩子，插件拿不到这次判定，也就无从放宽）"
echo
echo '### 3b 真实工具调用（模型在 p3-deny 里跑 shell）'
D $R/p3-deny/deny-proof.txt
echo '$ opencode run --server <私有> … "执行 printf pn-three-tool > deny-proof.txt"'
RUN p3-deny pn-accept-deny "用 shell 工具执行这一条命令，原样执行、不要改写：printf pn-three-tool > deny-proof.txt 。执行完把工具返回的原文告诉我，然后结束，不要做别的。"
EXPECT=$((EXPECT+1))
echo "--- deny-proof.txt 是否生成：$([[ -e $R/p3-deny/deny-proof.txt ]] && echo 生成了（失败） || echo 没有生成)"
echo '--- 台账新增行（从工具报错补记）'; tail -1 $L
} 2>&1 | tee $E/3-host-deny.txt

D run/settings.json

{
echo '## 第 5 条：类 5 与类 6 静默，台账各有对应行'
: > run/fake.log
echo '$ A p5-plain read src/a.ts'; A p5-plain read src/a.ts; EXPECT=$((EXPECT+1))
tail -1 $L
echo '$ A p5-plain glob "**/*.ts"'; A p5-plain glob "**/*.ts"; EXPECT=$((EXPECT+1))
tail -1 $L
echo '$ A p5-plain webfetch https://example.com'; A p5-plain webfetch https://example.com; EXPECT=$((EXPECT+1))
tail -1 $L
echo "--- 替身弹窗调用次数：$(grep -c . run/fake.log)"
} 2>&1 | tee $E/5-silent-classes.txt

{
echo '## 第 7 条补充：真实会话里的一串工具调用（读、列目录、写、执行），每次判定一行'
echo '（服务端此时同时加载了 4 个场景位置的插件实例，用来检查多实例下不重复记账）'
D $R/p5-plain/note.md
N0=$(grep -c . $L)
RUN p5-plain pn-accept-mixed "依次做四件事，每件只调用一次工具，不要多做：1) 用 read 读 src/a.ts；2) 用 glob 列出 **/*.ts；3) 用 write 新建 note.md，内容为 hello；4) 用 shell 执行 printf pn-five。做完回复 done。"
echo "--- 本次会话新增台账行数：$(( $(grep -c . $L) - N0 ))"
tail -n $(( $(grep -c . $L) - N0 )) $L
} 2>&1 | tee $E/7-real-session.txt

echo $EXPECT > run/expected-direct.txt
