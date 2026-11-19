# OPENCLAW HANDOFF — 弹窗对已失效请求不再静默失败

日期：2026-11-19。仓库：`~/Desktop/Code工作区/permission-notify`（带 `src/index.ts` 的这个，不是 `opencode-permission-notify/native` 那个空壳）。
状态：未 `git add`、未 commit、未 push；版本号未动（0.1.1）。

## 0. 动手前的工作树现状（会影响"改在哪几处"）

工作树在我开始时**已经有一轮未提交的 v2 改写**（任务书 `BRIEF_permission_classes_v2.md`、`src/classes.ts`、`test/classes.test.ts`、`bin/permission-settings`、`HANDOFF_POPUP_RACE.md` 等），不是任务书描述的 206 行旧版。这次没有推翻它，只按任务书补它缺的那几条。

v2 里调用 `ctx.permission.reply` 的地方只有一处：兜底函数 `handlePublished()`（`permission.asked` 事件 → 弹窗 → reply）。human 档的弹窗走 `evaluate` 钩子，在钩子里就地等答案、把 allow/deny 交回去，**不经过 reply**，所以不存在"reply 找不到请求"。任务书的五条因此落在 `handlePublished` 这条兜底路径上；分级、钩子语义、三个按钮、弹窗位置与外观都没有改。

## 1. 改在哪几处

| 文件 / 函数 | 改动 |
|---|---|
| `src/index.ts` `handlePublished()` | ① 保留原有 900ms／150ms 预检查，**新增弹窗前最后一次确认**：明确返回「不在」就不弹；② 新增 `index === -3` 分支（弹窗开着时请求被别处处理 → 助手被 abort 收回）；③ 新增 `-2`（前台是 OpenCode）、`-1`（超时）、未知按钮的 `skip` 日志；④ **点击后、reply 前再确认一次**，不在就不发回复（弹窗此刻已随点击关闭）；⑤ reply 异常分两类：not-found → `stale`，其余 → `error` |
| `src/index.ts` `isNotFound()`（新增） | 判定 reply 的 not-found：`_tag === "PermissionNotFoundError"`、HTTP 404、或消息含 `not found` |
| `src/index.ts` `claim()` | 成功时返回锁；**新增死进程锁接管**：读锁里的 pid，`process.kill(pid, 0)` 判活，写入者已不在就接管，避免异常退出后下一个请求弹不出来 |
| `src/index.ts` `pending()` | 查询失败的日志加 `outcome=error stage=verify`，与正常/已处理分开 |
| `src/index.ts` `runBatch()` | `resolved batch …` 行加 `outcome=ok|skip`；`batch … failed` 加 `outcome=error stage=batch` |
| `src/index.ts` `LOG_FILE` | 支持 `PERMISSION_NOTIFY_LOG`，与既有的 `PERMISSION_NOTIFY_LEDGER/SETTINGS/GRANTS/PENDING/REPLIES` 一致（测试用来不写线上日志） |
| `test/stale.test.ts`（新增） | 8 个用例，用假 ctx 驱动插件本体跑兜底路径，见 §3 |
| `package.json` | `npm test` 同时跑 `test/classes.test.ts` 与 `test/stale.test.ts`（没有加依赖） |
| `test/serve-isolated.sh` | `opencode-cli` 路径原先写死 `2.3.0-arm64`，桌面版已升到 2.3.2，脚本直接跑不起来；改为取最新版本；另加 `PERMISSION_NOTIFY_LOG` 指向 `test/run/` |

`native/notify-request.m`、`bin/` 二进制、`classes.ts` 一字未动。

## 2. 日志格式变化

统一用 `outcome=` 收尾：`ok` 正常处理、`stale` 已被别处处理、`error` 真正的错误、`skip` 没人回答（去重、前台是 OpenCode、超时）。日志文件不变（`~/Library/Application Support/opencode/permission-notify/notify.log`），`grep outcome= ` 即可分开三类。

| 场景 | 旧 | 新 |
|---|---|---|
| 正常回复 | `replied <id> -> once` | `replied <id> -> once after 1080ms outcome=ok` |
| 弹窗前已处理 | `skipped <id> (already resolved) after Nms` | `stale <id>: already resolved elsewhere (stage=before-popup, not shown, 152ms) outcome=stale` |
| 弹窗开着时已处理 | （旧版会继续挂着/点完才失败） | `stale <id>: already resolved elsewhere (stage=while-open, popup withdrawn, 1908ms) outcome=stale` |
| 点击后、reply 前已处理 | 不检查，直接 reply | `stale <id>: already resolved elsewhere (stage=before-reply, once not sent, popup closed, 1125ms) outcome=stale` |
| 确认与发送之间消失 | `reply late <id>: already resolved elsewhere` | `stale <id>: already resolved elsewhere (stage=reply, once was not applied, Error: Permission request not found: <id>) outcome=stale` |
| 真错误 | `reply failed <id>: <err>` | `error <id>: reply failed (once): <err> outcome=error stage=reply` |
| 没弹/没点 | `published <id> action=… index=…`（混合） | `skip <id> reason=frontmost|timeout|dedupe|unknown-button-N outcome=skip stage=…` |
| 钩子路径结论 | `resolved batch <id> -> once by popup` | `resolved batch <id> -> once by popup outcome=ok`（超时为 `outcome=skip`） |

本轮日志里的实际样例（`test/evidence/stale-log.txt`）：

```
stale per_test: already resolved elsewhere (stage=before-popup, not shown, 152ms) outcome=stale
replied per_test -> once after 1080ms outcome=ok
stale per_test: already resolved elsewhere (stage=before-reply, once not sent, popup closed, 1125ms) outcome=stale
stale per_test: already resolved elsewhere (stage=reply, once was not applied, Error: Permission request not found: per_test) outcome=stale
error per_test: reply failed (once): Error: socket hang up outcome=error stage=reply
stale per_test: already resolved elsewhere (stage=while-open, popup withdrawn, 1908ms) outcome=stale
```

## 3. 验收五条：怎么测的、结果

测试命令：`npm test`（16 个用例，8 个是这次新加的）、`npx tsc --noEmit -p .`、`./build.sh`。

`test/stale.test.ts` 的做法：`HOME`、`TMPDIR`、`PERMISSION_NOTIFY_LOG/LEDGER/SETTINGS/GRANTS/PENDING/REPLIES` 先指到临时目录，再动态 import `src/index.ts`，拿到插件本体后喂一个假 ctx（`permission.list`／`permission.reply`／`event.subscribe`），助手换成按脚本"点击"的假助手。跑的是仓库里真实的 `handlePublished / claim / pending / ask`。

### 3.1 已被别处处理的请求：不弹、不发回复、不报错

| 触发时机 | 用例 | 结果 |
|---|---|---|
| 弹窗之前 | `请求已经不在：不弹窗，记 stale，助手没有被调用` | `outcome=stale stage=before-popup`（152ms）；断言假助手**没有被启动**（标记文件不存在） |
| 弹窗开着时 | `弹窗开着时请求在别处被处理：收回窗口，记 stale` | `outcome=stale stage=while-open`（1908ms）；助手被 abort，窗口收回 |
| 点击之后、reply 之前 | `点击后、发回复前请求已消失：关闭弹窗，不发送回复，记 stale` | `outcome=stale stage=before-reply`；断言 `reply` 调用次数为 **0** |
| 确认之后、发送之前（竞态） | `确认与发送之间请求消失：reply 报 not found，按已处理记 stale，不算错误` | `outcome=stale stage=reply`；断言全程没有 `outcome=error` |

「窗口真的收掉」另用**真实二进制**验过：`execFile("bin/notify-request", …, { signal })`，1.2s 时截图、1.5s abort。回调 `{"error":"AbortError","stdout":"","ms":1495}`；abort 前 `pgrep -x notify-request` = `55228`，abort 后为空。截图：`test/evidence/withdraw-before-panel.png`（右上角弹窗在，三个按钮齐全）、`test/evidence/withdraw-after-panel.png`（同一位置已经干净）。

### 3.2 正常请求仍然能回复

用例 `正常请求：弹出后回复成功，记 ok，OpenCode 侧收到决定`，断言 `permission.reply` 恰好被调用一次，入参为
`{ sessionID: "ses_test", requestID: "per_test", decision: "once" }`，日志 `outcome=ok`。

### 3.3 日志能区分三种结局

见 §2，五个 stage 的 stale、一个 ok、一个 error 都有实际样例，`test/evidence/stale-log.txt` 存了整段。

### 3.4 连续请求之间不留窗口或锁

- `test/stale.test.ts` 每个用例结束都断言 `$TMPDIR/opencode-permission-notify` 为空；跑完实际检查也是空目录。
- 用例 `死进程留下的锁会被接管，下一个请求照常弹出`：先塞一个 pid=999999 的锁，请求仍然正常弹出并回复成功，日志 `reclaimed lock per_test (owner pid 999999 gone)`。
- 真实二进制 abort 后 `pgrep` 无残留；`test/run/pending` 无残留文件。

### 3.5 构建

```
./build.sh            → notify-request / permission-settings 均为 x86_64 + arm64 fat
npx tsc --noEmit -p . → 无输出（通过）
npm test              → tests 16 / pass 16 / fail 0
```

## 4. 没做到的事与边界（事实）

1. **兜底 reply 路径没能在真实服务端上端到端跑一遍。** v2 的 human 档在 `evaluate` 钩子里就答完了，`permission.asked` 不会为它发布；只有 `judge` 抛错或其他插件发布请求时才会走到 `handlePublished`。所以这条路径用假 ctx 驱动插件本体覆盖（同一份源码、同一个 `ask/claim/pending`），而不是伪造一个真实请求。
2. **隔离服务端这条路这轮没通。** `opencode serve` 没有 `--standalone`（实测 `Unrecognized flag: --standalone`），起在 4199 的进程仍然连到主服务端；`POST /api/session/:sid/permission` 直接回 `{"effect":"deny"}`（28ms），到不了兜底弹窗。顺带修了脚本里写死的 `2.3.0` 路径。
3. **`permission.list` 查询失败的处理**：弹窗前查不到列表时按"查不到"处理、照常弹窗（宁可多弹），点击后由 reply 的 not-found 兜底；代价是列表持续失败时每个请求会多记几行 `list failed … outcome=error stage=verify`（弹窗期间每秒一次）。
4. **副作用记录**：本轮有一条 `rm -f` 命令被 human 档拦下并在约 4 分钟后以 `permission.rejected` 结束，说明主服务端已经自动加载了新代码；除这条以外没有对主服务端做任何操作，没有重启桌面版。
5. 日志里 `ctx.location=… event.location=…` 的调试行是 v2 原有的，没动。
