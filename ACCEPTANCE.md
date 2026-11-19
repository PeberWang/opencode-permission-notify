# ACCEPTANCE：授权分级（六类三档）真机验收

日期：2026-11-19（本机 12:04–12:11，UTC 18:04–18:11）。OpenCode CLI 2.3.2（arm64），macOS 27.0。
证据目录：`test/evidence/acceptance/`。结果：**八条全部通过**；第 4 条附带发现一处规格层面的问题，见文末。

## 环境

- 私有服务端：`test/serve-isolated.sh`（`opencode-cli serve`，127.0.0.1:4199），插件的台账、设置、授权、日志都写到 `test/run/`，不碰线上文件。
  - fake 轮（第 1、2、3、5、7 条）：替身助手 `test/fake-helper.sh` 代替弹窗，1 秒后「点」拒绝，调用记录写 `test/run/fake.log`。
  - real 轮（第 4、6 条）：真助手 `notify-request`，等待超时 45 秒。
- 宿主配置：全局 `~/.config/opencode/opencode.jsonc` **未改动**；改宿主规则的场景都用 `test/run/projects/` 下的临时项目，各带一份项目级 `opencode.jsonc`（后匹配者优先，覆盖全局）：
  - `p0-ask`：`shell "printf pn-*" ask`
  - `p1-allow`：同上，再加一条 `shell "printf pn-*" allow`
  - `p3-deny`：`shell "printf pn-*" deny`
  - `p5-plain`：空配置，只有全局规则
- 判定的发起方式：「直接断言」= `test/accept.py assert` 调 `POST /api/session/{id}/permission`；「真实工具调用」= `opencode run --server http://127.0.0.1:4199 --archived -m deepseek/deepseek-flash`，由模型调用工具。
- 复跑：先起 `FAKE_INDEX=2 FAKE_DELAY=1 test/serve-isolated.sh fake`，再跑 `test/acceptance.sh`（第 1、2、3、5、7 条）；第 4、6 条需要真弹窗与窗口操作，步骤记在各自的证据文件里。

## 逐条结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 宿主加一条 shell allow，项目内 shell 不再弹窗，台账有对应行 | 通过 | `1-shell-allow.txt` |
| 2 | 宿主 ask，设置里类 3 显式 silent → 静默，来源 user | 通过 | `2-user-over-ask.txt` |
| 3 | 宿主 deny，插件任何设置都放不开 | 通过 | `3-host-deny.txt`、`3c-deny-detection.txt` |
| 4 | 类 1 真弹窗，标题「OpenCode 需要授权」，正文 ≤4 行 | 通过 | `4-popup.txt`、`4a-popup-single-crop.png`、`4b-popup-batch-crop.png` |
| 5 | 类 5、类 6 静默，台账各有对应行，字段齐全 | 通过 | `5-silent-classes.txt` |
| 6 | 设置窗口六行三选一可见可改，改完一条命令验证生效 | 通过 | `6-settings.txt`、`6a-settings-before.png`、`6b-settings-after.png` |
| 7 | 每条判定有且只有一行台账，可解析，字段不缺 | 通过 | `7-ledger-check.txt`、`7-real-session.txt`、`ledger-fake-run.jsonl`、`ledger-real-popup.jsonl` |
| 8 | 类型检查与构建通过 | 通过 | `8-typecheck-build.txt` |

### 1. 宿主 shell allow

- 1a 基线 `p0-ask`，`printf pn-one`：替身弹窗被调用一次（真机即弹窗），台账 `class 3 / source host / tier human / effect deny`（替身点了拒绝）。
- 1b `p1-allow`（多出一条 allow），同一命令：替身调用 0 次，200 ms 内 `effect allow`；台账 `host_rule {shell, "printf pn-*", allow} / source host / tier silent`，理由「宿主规则放行，默认 pm 取更省事一档 silent」。

### 2. 用户设置优先于宿主 ask

写 `test/run/settings.json` 为 `{"permissionClasses":{"3":"silent"}}`，服务端不重启，`p0-ask` 再发 `printf pn-two`：替身调用 0 次，`effect allow`；台账 `host_effect ask / host_rule …ask / source user / tier silent / why 用户设置类 3 为 silent`。

### 3. 宿主 deny 放不开

设置六类全部 silent。

- 3a 直接断言 `p3-deny` 的 `printf pn-three`：返回 `effect deny`；台账新增 0 行——OpenCode 对显式 deny 不调用钩子，插件根本拿不到这次判定。
- 3b 真实工具调用：模型执行 `printf pn-three-tool > deny-proof.txt`，工具报 `Permission denied: shell`，`deny-proof.txt` 没有生成；台账补记一行 `host_effect deny / host_rule {shell, "printf pn-*", deny} / tier deny / note observed-after`。
- 3c（当前代码上补跑，`3c-deny-detection.txt`）：反例，项目内 `chmod 000` 的文件被 read 工具读取失败（EACCES），台账只有 read 自身的放行行，**没有**误记成宿主 deny；正例，命令文本里不含 deny 字样的 `printf pn-blocked > out.txt` 被宿主 deny，照样补记，`host_rule` 正确。

### 4. 类 1 真弹窗

- 4a `p5-plain` 直接断言 `rm -rf build`（全局 `rm *` ask，类 1）：右上角弹窗，标题「OpenCode 需要授权」，正文一行 `rm -rf build`，三个按钮（截图 4a）。这一条在弹出约 3 秒后被人在屏幕上点了「总是允许」（不是脚本操作）；授权只写入 `test/run/grants.json`，随后删除；直接断言不执行任何命令。
- 4b 同一会话同时发 6 条类 1：其中 5 条合成**一个**弹窗，辅助功能读出的文字为「OpenCode 需要授权 / rm -rf out / npm publish / rm -rf coverage / …另 2 项」，正文 4 行（截图 4b）；脚本点「拒绝」后 5 条一起 deny，台账各一行，`batch` 相同。
- 第 6 条 `git push origin main` 没有进弹窗，见文末「发现的问题」。

### 5. 类 5、类 6 静默

`p5-plain` 直接断言：`read src/a.ts` → 类 5、`source host`（全局 `read * allow`）、silent；`glob **/*.ts` → 类 6、`source default`、silent；`webfetch https://example.com` → 类 6、`source default`、silent。替身调用 0 次。第 7 条的真实会话里，read 与 glob 也各有一行，字段齐全。

### 6. 设置窗口

- 运行 `bin/permission-settings --settings test/run/settings.json --ledger test/run/ledger.jsonl`：六行、每行三档单选与来源列（截图 6a），初始选中即默认表；类 1 标「跟随宿主 · 最近 ask → human」（来自台账里第 4 条的判定）。
- 用 osascript 点「类 3 静默 silent」（走辅助功能，等同鼠标点击）：设置文件立即变为 `{"permissionClasses":{"3":"silent"}}`，类 3 来源变「用户改过」（截图 6b），`--print` 输出一致。
- 一条命令验证（real 服务端未重启，`p0-ask` 宿主 ask）：`PN_DIR=…/p0-ask python3 -I test/accept.py assert <p0> shell "printf pn-six" && tail -1 test/run/ledger.jsonl` → 5 ms `effect allow`，台账 `source user / tier silent`，没有弹窗。
- 反向：点类 3「恢复默认」，同一命令 `printf pn-seven` 立即重新弹真窗（读出「OpenCode 需要授权, printf pn-seven」），脚本点拒绝后台账 `source host / tier human / answer reject`。

### 7. 台账一判一行

- fake 轮：直接断言 6 次 + 真实工具调用 5 次 = 11 次判定；`test/check-ledger.py` 校验 11 行，全部可解析、必填字段（`v ts session action resources host_effect class source tier reason why effect`）齐全、枚举值合法、无重复。3a 的直接断言 deny 不经钩子，不计（见 HANDOFF 已知限制 3）。
- 真实会话 `pn-accept-mixed`：模型依次 read、glob、write、shell 各一次，服务端此时同时加载着 4 个场景目录的插件实例，台账恰好新增 4 行，`call` 各不相同。
- real 轮：4a 1 次 + 4b 6 次 + 第 6 条 2 次 = 9 次判定，校验 9 行，无问题。

### 8. 类型检查与构建

`npm run typecheck` 0 错误；`npm test` 16 个用例全过（分级 8 个 + 弹窗竞态 8 个）；`./build.sh` 产出 `bin/notify-request`、`bin/permission-settings`，均为 x86_64 + arm64 通用二进制。完整输出见 `8-typecheck-build.txt`。

## 发现的问题（未改，等决策）

4b 中 `git push origin main` 属类 1，但宿主只有通配 `shell * allow` 命中。按规格二第 3 条降一档成 pm；案头尚未接入，pm 按 pm-offline 放行——5 ms 返回 allow，没有弹窗。这完全符合任务书字面规格，也与装插件之前的行为相同，但意味着在日常配置下，类 1 中被 `shell * allow` 兜住的命令（`git push`、`gh pr create`、`curl -X POST`、`scp` 等）目前不会问人。处理选项见 `HANDOFF.md` §8 第 1 条。

## 验收过程中顺带修正的

- 宿主 deny 补记判据：原先按报错文本里的关键词（deny / permission…）匹配。实测 deny 的报错是 “Unable to execute command: <命令>”，3b 能命中只是因为命令里的文件名 `deny-proof.txt` 恰好含 “deny”；换个命令就会漏记，而文件系统的 “permission denied” 又可能误中。改为认 `Permission.BlockedError`，3c 正反两例验证。
- 设置窗口的「人工 human」与来源说明被截断，调整布局后重截。
- 场景命令起初用 `echo pn-*`，发现本仓库在 OpenCode 里存有「总是允许 `shell echo *`」，会让宿主 ask 失效，改用 `printf pn-*` 重跑；正式记录只取改用之后、清空台账后的一轮。
