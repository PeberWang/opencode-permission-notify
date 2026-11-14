# opencode-permission-notify

把 OpenCode 的授权请求变成 macOS 屏幕右上角的原生浮窗，带 **允许一次 / 总是允许 / 拒绝** 三个按钮——
不用切回 OpenCode 窗口就能批复。

- **非抢焦**：浮窗是 `NSWindowStyleMaskNonactivatingPanel`，点按钮不会把 OpenCode 顶到前台，也不会打断你正在读的东西
- **该静就静**：OpenCode 已经在前台时直接不弹（窗口里的提示本来就看得见）
- **不丢请求**：浮窗点完即时回写；超时 5 分钟自动收起，交还给窗口内的原提示
- **零依赖**：不装 terminal-notifier，不需要通知权限，二进制随包分发

## 安装

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": ["opencode-permission-notify"]
}
```

或者在本地开发时指向目录：

```jsonc
{
  "plugins": ["/absolute/path/to/permission-notify"]
}
```

首次加载时会把内置的通用二进制（arm64 + x86_64）释放到
`~/Library/Application Support/opencode/permission-notify/bin/notify-request`。

**要求**：macOS、OpenCode V2（桌面版或 TUI 均可，插件跑在服务端）。

## 工作方式

```
OpenCode 服务端发出 permission.asked
   ↓  插件按 location 过滤（只有会话所属目录的实例处理）
执行 notify-request：
   前台是 OpenCode → 直接退出，不打扰
   否则在右上角画浮窗，等你点按钮
   ↓  stdout 返回按钮序号
ctx.permission.reply({ sessionID, requestID, decision })
```

按钮对应 `once` / `always` / `reject` 三种 decision。

## 配置

| 环境变量 | 说明 |
| --- | --- |
| `PERMISSION_NOTIFY_HELPER` | 覆盖助手路径（一般不用） |

日志：`~/Library/Application Support/opencode/permission-notify/notify.log`

## 从源码构建

需要 Xcode Command Line Tools：

```sh
./build.sh          # 编译通用二进制到 bin/notify-request
```

## 已知限制

- 仅 macOS
- 浮窗按请求堆叠（最多 5 个槽位）；同一时刻大量请求会略微重叠
- 拒绝时不会附带理由文本（OpenCode 支持带反馈的拒绝，这里暂时只回 `reject`）

## 许可

MIT
