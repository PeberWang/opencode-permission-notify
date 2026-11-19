# opencode-permission-notify

Approval prompts from OpenCode, as a native macOS floating panel in the top-right
corner of your screen — with **Allow once / Always / Reject** buttons, so you never
have to switch back to the OpenCode window to answer.

- **Non-activating** — the panel is an `NSWindowStyleMaskNonactivatingPanel`; clicking a button does not bring OpenCode forward or interrupt what you are doing
- **Quiet when it should be** — if OpenCode is already frontmost, nothing pops up
- **Never lost** — answers are written back immediately; after 5 minutes the panel closes and hands the request back to the in-window prompt
- **No dependencies** — no terminal-notifier, no notification permission; the helper binary ships with the package

## Install

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": ["opencode-permission-notify"]
}
```

Or point at a local checkout while developing:

```jsonc
{
  "plugins": ["/absolute/path/to/permission-notify"]
}
```

On first load the bundled universal binary (arm64 + x86_64) is extracted to
`~/Library/Application Support/opencode/permission-notify/bin/notify-request`.

**Requirements**: macOS, OpenCode V2 (desktop or TUI — the plugin runs in the
server).

## How it works

```
OpenCode server emits permission.asked
   ↓  the plugin filters by location (only the instance owning the session's
      directory handles it)
notify-request:
   OpenCode is frontmost → exit quietly
   otherwise draw a panel in the top-right corner and wait for a click
   ↓  stdout: index of the chosen button
ctx.permission.reply({ sessionID, requestID, decision })
```

The three buttons map to the `once` / `always` / `reject` decisions.

## Permission classes

Every request is classified once, in the `permission` `evaluate` hook, before
OpenCode publishes it. There are six classes and three tiers:

| Class | What | Default tier |
| --- | --- | --- |
| 1 | Irreversible or out of bounds: delete, sudo, credentials, publish/push, writes outside the project, anything unclassifiable | human |
| 2 | Read outside the project | pm |
| 3 | Run a shell command inside the project | pm |
| 4 | Write inside the project | pm |
| 5 | Read inside the project | silent |
| 6 | No side effects (queries, listing, reading OpenCode config) | silent |

`human` shows the panel and waits; `pm` is meant for an external reviewer (not
wired up yet, so it is allowed and logged as `pm-offline`); `silent` is allowed
and logged.

How this combines with the `permissions` in `opencode.jsonc`:

1. A host `deny` always wins; the plugin never loosens it.
2. A tier you set explicitly overrides a host `ask` (and `allow`).
3. Otherwise a host `allow` moves the class one tier lighter, and a host `ask` goes to a human.
4. With no matching host rule, the default tier applies.

Settings (only the classes you changed are stored):
`~/Library/Application Support/opencode/permission-notify/settings.json`,
e.g. `{"permissionClasses": {"3": "silent"}}`. Edit it with the settings window
(`/permission-classes` in OpenCode, or run `bin/permission-settings`); changes
apply to the next request without restarting OpenCode.

Decision ledger (JSONL, one line per decision):
`~/Library/Application Support/opencode/permission-notify/ledger.jsonl`.
Fields include `ts`, `session`, `action`, `resources`, `host_effect`, `host_rule`,
`class`, `source` (`default` / `user` / `host`), `tier`, `reason`, `why`, `effect`.
See `HANDOFF.md` for the full list.

## Configuration

| Environment variable | Description |
| --- | --- |
| `PERMISSION_NOTIFY_HELPER` | Override the helper path (rarely needed) |
| `PERMISSION_NOTIFY_SETTINGS` | Override the settings file |
| `PERMISSION_NOTIFY_LEDGER` | Override the ledger file |
| `PERMISSION_NOTIFY_ASK_TIMEOUT_S` | Seconds before an unanswered panel counts as a rejection (default 300) |

Log file: `~/Library/Application Support/opencode/permission-notify/notify.log`

## Build from source

Requires Xcode Command Line Tools:

```sh
./build.sh          # builds bin/notify-request and bin/permission-settings (universal)
```

## Limitations

- macOS only
- Panels stack by request (up to five slots); many simultaneous requests overlap slightly
- Rejections do not carry feedback text yet (OpenCode supports reject-with-reason; this only sends `reject`)

## License

MIT

---

## 中文说明

把 OpenCode 的授权请求变成屏幕右上角的 macOS 原生浮窗，带「允许一次 / 总是允许 / 拒绝」
三个按钮，不抢焦点、不用切回窗口；OpenCode 已在前台时不弹。通用二进制助手随包分发。

安装：在 `~/.config/opencode/opencode.jsonc` 的 `plugins` 中加 `"opencode-permission-notify"`。
仅支持 macOS + OpenCode V2。

授权分级（六类三档，与宿主配置合成）见上文 Permission classes。设置文件
`~/Library/Application Support/opencode/permission-notify/settings.json`（配置项 `permissionClasses`），
判定台账 `~/Library/Application Support/opencode/permission-notify/ledger.jsonl`，一次判定一行。
