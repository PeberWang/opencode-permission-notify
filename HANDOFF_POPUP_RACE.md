# HANDOFF — 授权弹窗不再为已经处理掉的请求弹出

日期：2026-11-18（本机）/ 2026-11-19Z。仓库：`permission-notify`，未提交、未发布、版本号未动（仍为 0.1.1）。

## 1. 根因复述（含一处更正）

- 弹窗的三个按钮与 `DECISIONS = ["once","always","reject"]` 映射正确，选项没有缺失。
- 失败的原因是请求在弹窗出现之前就已经被别人回答了：日志里 `reply failed … Permission request not found` 共 130 次，`replied` 18 次；失败那次之后 `pending after reply: 0`，说明请求早已消失。
- **更正：抢答的不一定是案头 daemon。** `opencode run --help` 显示 `--auto` 是 OpenCode `run` 客户端自带的参数（"Auto-approve permissions that are not explicitly denied"），案头的 run 正是用 `opencode run … --auto` 启动的（如 pid 30142）。实测这个客户端在请求到达后 **≤10ms** 就回答完毕。`desk/daemon.py` 的 `permission_card()` 是否也会回答，本轮没有去读那边的代码（在工作区外），但无论谁回答，弹窗都抢不到。
- 第三个来源：**非交互的 `opencode run`（不带 `--auto`）会立即自动拒绝**（"This non-interactive run cannot ask the user for permission, so the request was rejected"）。这类请求旧版也会弹窗。
- **任务书没有提到的放大因素：事件循环是串行的。** 旧代码在 `for await` 里 `await ask()`，一个弹窗挂着时，后面到达的请求要排队。例如 `per_1f1320f78` 在 00:25:52.248Z 就到了，却要等前一个弹窗点完，到 00:25:53.838Z 才开始处理。所以日志里出现「点完一个，同一毫秒又冒出一个」的现象：后一个请求早已被回答，但它的弹窗现在才出来。
- 另一个潜在缺陷：`claim()` 拿不到锁时返回 `undefined`，旧代码紧接着读 `claimed.slot`，会抛 TypeError；而 `finally` 里的 `claimed.lock` 会再抛一次，直接打断事件订阅循环，这个实例从此不再弹窗。

## 2. 改动（只改了 `src/index.ts`，另新增 `test/`）

`git diff --stat`：`src/index.ts | 168 ++++++++++-----`（+122 / −46）

| 位置 | 改动 |
|---|---|
| `PRECHECK_MS = 900`、`PRECHECK_EVERY_MS = 150`、`WATCH_EVERY_MS = 1000` | 存活检查参数，前两项可用环境变量 `PERMISSION_NOTIFY_PRECHECK_MS` / `PERMISSION_NOTIFY_PRECHECK_EVERY_MS` 覆盖（测试用） |
| `pending()` | 调 `ctx.permission.list({ sessionID })` 判断请求是否还在；查询失败返回 `undefined`，按「还在」处理（宁可多弹，不漏弹） |
| `handle()`（新） | 每个请求一份：认领锁 →（预检查）请求到达后每 150ms 复查一次，持续 900ms，期间消失就记 `skipped … (already resolved) after Nms` 并返回 →（弹窗）弹出后每 1s 复查，请求在别处被处理就杀掉助手进程收回弹窗，记 `dismissed … (resolved elsewhere)` → 点击后回复 |
| 回复失败分类 | `not found` 记为 `reply late … already resolved elsewhere`，不算错误；其余异常仍记 `reply failed …` |
| `ask()` | 新增 `signal` 参数传给 `execFile`；被收回时返回 `-3`。按钮集合、`--skip-if-frontmost ai.opencode.desktop`、`--slot`、`--timeout` 原样保留 |
| `claim()` / `slot()` | 去重锁逻辑不变；拿不到锁就直接返回（修掉上面的 TypeError）。堆叠位置的计算挪到预检查之后（规则同原来：持锁数 − 1，上限 4），已跳过的请求不占位置 |
| 事件循环 | `void handle(data)`，不再串行 `await`，多个请求各自检查、各自堆叠（原有的 slot 堆叠逻辑本来就是为并发准备的） |
| 启动标记 | `started v0.1.1+race-fix pid=… dir=… src=<实际加载的文件 URL>` |

延迟的取舍（实测见 §4.1）：自动批准都在 10–150ms 内完成，900ms 留了约 6 倍余量；需要人点的请求只晚 0.9s 出现，相比日志里 1–25s 的点击用时可以忽略。万一自动批准慢于 900ms，弹窗出来后最多 1s 就会被收回，不会让人点到一个已经不存在的请求上。

`test/` 目录：
- `test/fake-helper.sh`：替身助手，过 `FAKE_DELAY` 秒后「点击」`FAKE_INDEX` 号按钮，用 `PERMISSION_NOTIFY_HELPER` 指过去。
- `test/race_test.py`：对一个独立的 `opencode serve` 直接造 `external_directory` 请求，按场景（立即 / 延迟 N ms / 无人回答 / 重复）在「别处」回答。
- `test/evidence/`：真实助手弹窗截图、替身助手收到的参数。

## 3. 加载路径与生效证明

**修复前实际加载的代码**：npm 缓存
`~/.cache/opencode/npm/opencode-permission-notify@latest/1794649366415/node_modules/opencode-permission-notify/src/index.ts`
（v0.1.1，与仓库 HEAD 的 `src/index.ts` 逐字节一致；`~/.cache/opencode/packages` 下没有这个包；`~/.local/share` 下也没有）。`@opencode/plugin` 由 OpenCode 内置解析，缓存目录里没有装这个依赖。

插件运行在桌面版带起的常驻服务端里：`~/Library/Application Support/ai.opencode.desktop/cli/2.3.0-arm64/opencode-cli serve --service`（pid 12947）。所有 `opencode run` 默认连到这个服务端，所以改代码后要**重启桌面版**才会换成新代码。

**部署方式**：`~/.config/opencode/opencode.jsonc` 的 `plugins` 里把 `"opencode-permission-notify"` 换成本地路径
`"/Users/mingpeiwang/Desktop/Code工作区/permission-notify"`（与 openclaw-inbox 同一做法），旁边写了注释，说明发布新版后改回包名。没有选择覆盖 npm 缓存：`@latest` 缓存随时可能被重新拉取成 npm 上的旧版 0.1.1。

**私有服务端里已经生效**（`opencode run --standalone` 会读取最新配置）：

```
2026-11-19T00:28:19.142Z started v0.1.1+race-fix pid=32974 dir=/Users/mingpeiwang/Desktop/Code工作区/permission-notify src=file:///Users/mingpeiwang/Desktop/Code%E5%B7%A5%E4%BD%9C%E5%8C%BA/permission-notify/src/index.ts
```

**主服务端重启后**：见 §4.5（待补）。

## 4. 验收

### 4.1 自动批准的场景不再弹窗

`opencode run --standalone --auto` 在本仓库目录里读取项目外的 `/etc/hosts` 触发 `external_directory`。调用正常返回文件内容，没有弹窗：

```
2026-11-19T00:28:22.532Z event per_1f1345a83001BD1Wr9Nmv4Ke2p action=external_directory at=1795048102532
2026-11-19T00:28:22.692Z skipped per_1f1345a83001BD1Wr9Nmv4Ke2p (already resolved) after 160ms
```

为了量出自动批准到底有多快，把复查间隔临时调到 10ms（`PERMISSION_NOTIFY_PRECHECK_EVERY_MS=10`），连续读 6 个 `/etc` 文件：7 个请求中有 6 个在第一次复查（10–14ms）时就已消失；剩下那个是新服务端的第一个请求（152ms，含冷启动）：

```
00:28:39.618Z skipped per_1f1349caa… after 152ms
00:28:39.654Z skipped per_1f1349d5a… after 11ms
00:28:41.102Z skipped per_1f134a303… after 11ms
00:28:42.441Z skipped per_1f134a83e… after 10ms
00:28:43.818Z skipped per_1f134ad9f… after 10ms
00:28:45.479Z skipped per_1f134b418… after 14ms
00:28:46.784Z skipped per_1f134b935… after 10ms
```

非交互 run 自动拒绝的情形同样被跳过：

```
00:29:12.274Z skipped per_1f1351c38… (already resolved) after 152ms
00:29:12.274Z skipped per_1f1351c3b… (already resolved) after 151ms
```

时机扫描（`test/race_test.py`，在一个独立的 `opencode serve --port 4199` 上，助手换成替身，替身 3s 后点击）：

| 场景 | 「别处」回答时间 | 插件行为 |
|---|---|---|
| instant | 2ms | `skipped … after 152ms` |
| late=500 | 509ms | `skipped … after 606ms` |
| late=1100 | 1108ms | 弹出后 `dismissed … (resolved elsewhere) after 1918ms` |
| late=2000 | 2005ms | 弹出后 `dismissed … after 2922ms` |

真实助手被收回的验证：用 `execFile(..., { signal })` 起真实的 `notify-request`，1.5s 时截图（弹窗在，三个按钮齐全，见 `test/evidence/popup-real-helper.png`），随后 abort：回调拿到 `AbortError`、stdout 为空，用时 1741ms；`pgrep notify-request` 已经找不到进程，窗口随进程退出而消失。

**通过主服务端走一次真正的案头 `--auto` 任务**：见 §4.5（待补）。

### 4.2 正常场景仍然弹窗，「总是允许」能存下来

同一个独立服务端，不在别处回答，替身约 3s 后点 index=1：

```
00:31:10.972Z event per_1f136ec7b001DmcWW0dsrFxFnt action=external_directory
00:31:14.906Z clicked per_1f136ec7b001DmcWW0dsrFxFnt index=1 after 3934ms
00:31:14.908Z replied per_1f136ec7b001DmcWW0dsrFxFnt -> always
00:31:14.908Z pending after reply: still has per_1f136ec7b001DmcWW0dsrFxFnt: false
```

同一资源再请求一次，服务端直接返回 `{'effect': 'allow'}`，不产生 `permission.asked` 事件，也不弹窗。`/api/permission/saved` 里能看到对应记录 `psv_1f136fbdb002…  external_directory /tmp/pn-race-human/*`。测试完已经把这条记录删除，测试会话也已全部删除。

真实按钮点一次：见 §4.5（待补）。

### 4.3 按钮与文案未变

- 替身助手收到的参数（`test/evidence/fake-helper-args.log`）：`--title OpenCode 需要授权 … --buttons 允许一次|总是允许|拒绝 --skip-if-frontmost ai.opencode.desktop --slot 0 --timeout 300`，与修复前一致。
- 真实弹窗截图：允许一次 / 总是允许 / 拒绝。
- 助手二进制没有改动（`cmp bin/notify-request` 与缓存里的一致）；`index < 0` 时直接返回的分支保留，`-2` 路径仍在。这次没有为测试去抢前台焦点，前台不弹的实际表现以 §4.5 重启后的真实日志为准。

### 4.4 没有新增异常

整个测试过程中，新代码没有产生 `reply failed`、`handle failed` 或 `list failed`。重启后的真实使用统计：见 §4.5（待补）。

### 4.5 主服务端（已生效，不需要重启）

更正：前面说的「要重启桌面版」是错的。OpenCode V2 会监视配置文件，保存后自动重载插件。改完 `opencode.jsonc` 之后，主服务端 pid 12947 立刻加载了新代码：

```
2026-11-19T00:28:10.873Z started v0.1.1+race-fix pid=12947 dir=/Users/mingpeiwang src=file:///Users/mingpeiwang/Desktop/Code%E5%B7%A5%E4%BD%9C%E5%8C%BA/permission-notify/src/index.ts
2026-11-19T00:28:10.915Z started v0.1.1+race-fix pid=12947 dir=/Users/mingpeiwang/Desktop/Code工作区/openclaw-desk src=…
```

服务端日志（`~/.local/share/opencode/log/opencode.log`）里同样有 `loading plugin id=/Users/mingpeiwang/Desktop/Code工作区/permission-notify`。

00:28Z 之后的真实使用（含案头的 `--auto` 任务）：请求全部被 `skipped (already resolved)`，约 150ms 内判定，没有弹窗；`reply failed` 为 0。

**本轮的设计方向已被否定，后续见 `DESIGN_PERMISSION_TIERS.md`。**

## 5. 遗留问题

1. **发布**：本机现在靠本地路径加载。发布 0.1.2 后要把 `opencode.jsonc` 改回 `"opencode-permission-notify"`，否则这台机器会一直跑仓库里的工作副本（包括没提交的改动）。
2. **`--auto` 的请求是否还要提示**：现在这类请求完全静默。如果你希望知道案头替你批准了什么，需要在案头那边做，或者在这里加一个只通知、不带按钮的提示。这一轮不改权限策略。
3. **`list` 一直失败时会反复记日志**：弹窗期间每秒复查一次，如果 `permission.list` 持续报错，每秒会记一行 `list failed`。目前没有观察到这种情况。
4. **`ctx.location=… event.location=…` 调试行**：每个请求、每个实例都会记一行（目前一个请求 4 行），日志涨得快。这是原来就有的行为，这次没动。
5. **同一时刻的竞态仍然存在**：自动批准如果正好晚于 900ms，弹窗最多会显示约 1s 后才被收回；这 1s 内点下去会记 `reply late`（不算错误）。
6. **`desk/daemon.py` 的 `permission_card()` 没有核查**：它在工作区外，本轮没有读。抢答的主体按 §1 的实测更正为 `run --auto` 客户端。
