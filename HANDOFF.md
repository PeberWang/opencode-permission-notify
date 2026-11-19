# HANDOFF：授权分级（六类三档）收尾

日期：2026-11-19。仓库：`~/Desktop/Code工作区/permission-notify`。
状态：本地已提交，**未推送、未发版，版本号仍是 0.1.1**。验收记录见 `ACCEPTANCE.md`。

一句话：**装法**是日常配置已按本地路径加载本仓库，无需改配置；**重启方式**是完全退出 OpenCode 桌面版（⌘Q）再打开，`notify.log` 出现 `started v0.1.1+classes` 即生效；**已知限制**见 §8；原先「被通配 `shell * allow` 兜住的类 1 不弹窗」已按方案 A 兜底（2026-11-19 追加，见 §8 第 1 条）。

## 1. 本轮做了什么

实现是 08:00 那一轮落地的（`src/classes.ts`、`src/index.ts`、设置窗口、八条单测），这次没有重写，只补了下面几处：

| 位置 | 改动 | 原因 |
|---|---|---|
| `src/index.ts` `recordHostDeny()` / `blockedBy()` | 补记宿主 deny 的条件从「报错文本含 deny/permission」改为认 OpenCode 的 `Permission.BlockedError`（2.3.2 实测挂在 `event.error.error._tag`）；用它附带的规则集补上 `host_rule` | 实测 deny 的报错文本是 “Unable to execute command: <命令>”，旧正则只有在命令本身含 deny 等字样时才命中，否则漏记；文件系统的 “permission denied” 又可能误中（验收 3c 正反两例） |
| 同上，`calls` 加 `denied` | 「同一次调用里插件自己判过 deny 就不补记」取代「判过任何一次就不补记」 | 旧条件下，外部目录先放行、后一道被宿主 deny 时会漏记 |
| `src/index.ts` `execute.after` | `PERMISSION_NOTIFY_TRACE=1` 时记下出错工具调用的事件结构 | 排查用；默认不写 |
| `native/permission-settings.m` | 单选格加宽、「跟随宿主」缩成一行，完整规则放鼠标悬停提示 | 真机截图里「人工 human」和来源说明被截断 |
| `README.md` | 加 Permission classes 一节：六类表、合成四条、设置文件与台账路径 | 规格二第 5 条要求台账路径写进 README |
| `test/acceptance.sh`、`test/check-ledger.py`、`test/accept.py` | 可复跑的真机验收脚本、台账校验器；`accept.py assert` 支持 `PN_DIR` | 验收 |
| `.gitignore` | 忽略 `test/run/`（私有服务端的台账、设置、场景项目） | |

`src/tiers.ts` 与 `test/tiers.test.ts` 在本轮开始时已经不在工作树里，仓库内也没有任何引用，不存在两套实现。`DESIGN_PERMISSION_TIERS.md` 是定案前的草案，保留作决策记录（§1 已按方案 A 定案）。

## 2. 配置项 `permissionClasses`

- 位置：`~/Library/Application Support/opencode/permission-notify/settings.json`（插件自己的文件，**不写** `opencode.jsonc`）。环境变量 `PERMISSION_NOTIFY_SETTINGS` 可改路径。
- 形如 `{"permissionClasses": {"3": "silent"}}`。只存用户显式改过的类；文件不存在、某类缺省、取值不合法，都按默认表：

  | 类 | 名称 | 默认 |
  |---|---|---|
  | 1 | 不可逆或越界 | human |
  | 2 | 项目外只读 | pm |
  | 3 | 项目内执行 | pm |
  | 4 | 项目内写入 | pm |
  | 5 | 项目内只读 | silent |
  | 6 | 无副作用 | silent |

- 即时生效：每次判定按文件 mtime 重读（`src/index.ts` `userClasses()`），不用重启 OpenCode。
- 「总是允许」存下的授权另在同目录 `grants.json`，`/permissions` 查看与撤销。

## 3. 判定顺序（`src/classes.ts` `resolve()` 第 378 行起，合成在 `merge()`）

1. OpenCode 算出的 `effect` 为 deny：最终 deny，来源 host。
2. 用户在设置里显式改过这一类：用用户的档位，来源 user（优先于宿主 ask，也优先于 allow）。
3. 宿主有匹配规则，或 OpenCode 判了 ask（会话规则、已保存授权也算）：ask 交给人（human）；allow 取比默认更省事的一档（human→pm，pm→silent），来源 host。通配 allow（`shell * allow`）同样只按这一条处理，不当成用户点名允许。
4. 宿主没有匹配规则：默认档位，来源 default。
5. **方案 A 兜底**：以上得到 pm 的类 1（来源 host 或 default，实际只会是宿主 allow 降档），若案头离线，改为 human；`why` 末尾加「案头离线，类 1 转人工」，并多出 `fallback: "class1-pm-offline"`。用户显式设置的档位（含把类 1 设为 silent 或 pm）不受影响，来源仍记 user。宿主 deny 先于这一步返回，兜底不放宽 deny。

档位执行（`src/index.ts` `judge()`）：silent 放行；pm 放行并标 `note: "pm-online"` 或 `"pm-offline"`（托管：留痕，由案头读台账复核）；human 先查「总是允许」授权，再进批次弹窗（同一会话同一类 600ms 内的请求合成一个弹窗），等待超时（默认 300 秒）按拒绝处理。

## 4. 宿主 deny 不可放宽：实现位置

三层，任何一层都足以保证：

1. **OpenCode 本身**：配置里显式的 deny 不调用 `evaluate` 钩子（`test/evidence/probe-evaluate.log`；验收第 3 条 3a 再次实测），插件拿不到这次判定，无从改写。
2. **`src/classes.ts:398`**：`merge()` 第一行（`resolve()` 先调它，兜底排在其后），`hostEffect === "deny"` 直接返回 deny，排在用户设置之前。
3. **`src/index.ts:485`**：`judge()` 的 `case "deny"` 原样回 deny，并带上 OpenCode 的拒绝说明。

`recordHostDeny()`（`src/index.ts:691`）只在工具报错之后补一行台账（`note: "observed-after"`），不参与判定。

## 5. 台账

- 路径：`~/Library/Application Support/opencode/permission-notify/ledger.jsonl`（`PERMISSION_NOTIFY_LEDGER` 可改）。超过 10MB 时改名为 `ledger.jsonl.1` 再写新文件（只保留一份旧的）。
- 一次判定一行 JSON。同一请求被多个位置实例收到时，进程内按「会话 + 调用 + 动作 + 资源」合并，只判一次、只写一行（验收第 7 条在 4 个实例同时加载时实测）。

| 字段 | 说明 |
|---|---|
| `v` | 格式版本，现为 2 |
| `ts` | ISO 时间（UTC） |
| `session` | 会话 id |
| `who` | 会话标题（案头交办的显示为「案头交办「…」」）与 agent |
| `agent` | agent 名 |
| `call` / `tool` | 发起它的工具调用 id 与工具名；直接走 API 的判定没有 |
| `action` | OpenCode 的动作名（shell、read、edit、external_directory、MCP 工具名…） |
| `resources` | 资源数组，最多 5 项、每项最多 300 字 |
| `host_effect` | OpenCode 算出的结果（allow / ask / deny，含已保存授权） |
| `host_rule` | 宿主配置里最后匹配的那条规则，没有则 null |
| `class` / `class_name` | 类号（"1"–"6"）与类名 |
| `source` | 档位来源：default / user / host |
| `tier` | 最终档位：human / pm / silent / deny |
| `reason` | 归类理由 |
| `why` | 合成理由 |
| `effect` | 交回 OpenCode 的结果：allow / deny |
| `fallback` | 可选：`class1-pm-offline`，表示这一行本是 pm、因案头离线由方案 A 转人工（此时 `tier` 为 human，`answer` 记人的回答） |
| `note` | 可选：`pm-online` / `pm-offline`（pm 托管放行时案头是否在线）、`grant`（命中「总是允许」）、`same-call`（同一调用前一道已由人批准）、`observed-after`（从工具报错补记的宿主 deny） |
| `batch` / `by` / `answer` | human 档：批次 id、谁答的（popup / docket / timeout / error）、回答（once / always / reject / timeout） |
| `grant` / `error` | 命中的授权 id；补记 deny 时的报错原文 |

案头另有一条通道：human 档等待期间写 `pending/<batch>.json`，案头写 `replies/<batch>.json` 即可作答（与弹窗并行，谁先答算谁的）。

## 6. 设置窗口

- 在 OpenCode 里输入 `/permission-classes`；或直接运行 `bin/permission-settings`（默认指向上面的线上设置文件与台账）。
- `--settings <文件> --ledger <文件>` 指定别的文件；`--print` 不开窗口，把六行当前状态打印成 JSON。
- 每行：类名与一句说明、三档单选、来源（默认 / 用户改过 / 跟随宿主 · 最近 ask → human）、「恢复默认」。点选即原子写回，只改 `permissionClasses`，保留文件里其他键。
- 「跟随宿主」看的是台账里这一类最近一次判定，是历史状态，不是对下一次的预测。

## 7. 回滚

- 只停分级、保留弹窗：没有单独开关；退回上一个提交即可（`git log` 里本提交的前一个是 `f3fdcc3`）：`git checkout f3fdcc3 -- src bin package.json` 后重启 OpenCode。注意这会连同弹窗竞态修复（`HANDOFF_POPUP_RACE.md`、`OPENCLAW_HANDOFF_STALE_REPLY.md`）一起退掉，因为它们在同一个提交里；`src/classes.ts` 会留在目录里但不再被引用。
- 整个插件停用：在 `~/.config/opencode/opencode.jsonc` 的 `plugins` 里删掉 `"/Users/mingpeiwang/Desktop/Code工作区/permission-notify"` 一行，重启 OpenCode。授权回到 OpenCode 窗口内询问，宿主规则照旧。
- 清掉用户设置：删 `settings.json`（或在窗口里逐行「恢复默认」）。台账、`grants.json` 可直接删，不影响运行。

## 8. 已知限制

1. **被通配 allow 兜住的类 1：已按方案 A 兜底（2026-11-19）。** 日常配置里有 `shell * allow`，`git push origin main`、`gh pr create`、`curl -X POST`、`scp` 这类类 1 命令只命中这条通配，按规格第 3 条降成 pm。现在案头离线时改为弹窗问人，取消或超时按拒绝；案头在线时仍按 pm 托管放行；用户在设置里显式改过类 1 时以用户为准。实现：`src/classes.ts` `resolve()` 末段（纯函数，单测覆盖），`src/index.ts` `pmOnline()` 与 `judge()`。验证见 `ACCEPTANCE.md`「方案 A」一节。
   - **案头离线的判定**：心跳文件 `~/Library/Application Support/opencode/permission-notify/pm-online`（`PERMISSION_NOTIFY_PM_HEARTBEAT` 可改）。文件不存在、或修改时间超过 60 秒（`PERMISSION_NOTIFY_PM_TTL_S`）即离线。案头上线后需要定期 `touch` 这个文件（间隔应明显小于 60 秒）；**目前案头还没有写心跳，所以实际一律按离线处理**，类 1 被通配兜住的命令都会弹窗。
   - **回退到方案 C**（离线照旧放行）：最省事是让插件认为案头一直在线，例如在启动 OpenCode 的环境里设 `PERMISSION_NOTIFY_PM_TTL_S` 为极大值并 `touch` 一次心跳文件；彻底回退则删掉 `resolve()` 里 `if (r.tier === "pm" && input.cls === "1" …)` 那一段（或 `git revert` 方案 A 的提交），重启 OpenCode。
   - 注意：心跳只是「案头活着」的信号，不代表案头会对某条请求作答；案头在线时 pm 仍是放行并留痕，复核在事后。
2. **pm 档未接案头。** 除方案 A 兜底的类 1 外，pm 判定都是放行并留痕（`pm-online` / `pm-offline`）；案头读台账、写心跳的改造另派。
3. **不经工具调用的宿主 deny 不入台账。** 直接调 API 发起、被显式 deny 的判定，OpenCode 不调钩子，插件看不到（验收 3a）。工具调用里的 deny 靠 `execute.after` 补记，依赖 OpenCode 2.3.2 的 `Permission.BlockedError` 结构；升级后若结构变了，补记会静默失效（判定本身不受影响）。
4. **OpenCode 的「已保存授权」算宿主 allow。** 例如本仓库存有 `shell echo *` 的「总是允许」，配置里对 `echo` 写 ask 也会得到 `host_effect: allow`，插件据此降档。验收因此改用 `printf pn-*`。
5. **实例刚启动时的第一条请求可能绕过插件。** 某个目录的实例刚起、钩子尚未注册时到达的判定，由 OpenCode 单独处理，不入台账（验收预演中见过一次：p5 实例启动瞬间的 `sudo` 请求直接返回 deny、无台账）。
6. **归类的盲区**：解释器内部写文件（`python3 -c "open('/tmp/x','w')…"`）看不出越界，归类 3；MCP 工具只能按名字判断，判不清的一律归类 1。
7. 本轮没有在桌面版里实际敲 `/permission-classes`；窗口是直接运行二进制验收的，命令只是同一个二进制的启动器。

## 9. 残留与环境

- 验收全程用私有服务端（`test/serve-isolated.sh`，端口 4199），台账、设置、授权都写在 `test/run/`（已忽略），全局 `opencode.jsonc` 未改动。场景项目的宿主规则写在 `test/run/projects/*/opencode.jsonc`，只在那几个目录生效。
- 验收建的 19 个会话已通过 API 删除；之后 3c 补跑又建了 2 个已归档会话（pn-accept-eacces2、pn-accept-blocked），不在会话列表里，未删。更早几轮留下的会话没动：未归档的 `ses_e0bc22f4fffeBh6Qmekw2FQ4YG`（test/run/sandbox）、`ses_e0bdb3679ffeHKt1uh4qrqPx7N`（test/accept/proj），以及已归档的 pn-tier-test / pn-probe 共 5 个。
- 本仓库的代码已在日常 OpenCode 里按本地路径加载；这次的改动要等 OpenCode 重启才会生效。
