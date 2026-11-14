import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * permission-notify — 把 OpenCode 的授权请求变成 macOS 原生弹窗（带按钮），
 * 在弹窗里直接选「允许一次 / 总是允许 / 拒绝」，不用切回 OpenCode 窗口。
 *
 * 依赖同目录安装的 notify-request 助手（CFUserNotification）。
 */

const HOME = process.env.HOME ?? homedir()
const INSTALL_DIR = `${HOME}/Library/Application Support/opencode/permission-notify`
const HELPER = process.env.PERMISSION_NOTIFY_HELPER ?? `${INSTALL_DIR}/bin/notify-request`

/** npm 包里自带通用二进制；首次加载时释放到 Application Support */
function ensureHelper(): string | undefined {
  if (process.env.PERMISSION_NOTIFY_HELPER) return HELPER
  if (existsSync(HELPER)) return HELPER
  try {
    const bundled = fileURLToPath(new URL("../bin/notify-request", import.meta.url))
    if (!existsSync(bundled)) return undefined
    mkdirSync(dirname(HELPER), { recursive: true })
    copyFileSync(bundled, HELPER)
    chmodSync(HELPER, 0o755)
    return HELPER
  } catch {
    return undefined
  }
}

const DECISIONS = ["once", "always", "reject"] as const

const LOCK_DIR = join(tmpdir(), "opencode-permission-notify")
const LOG_FILE = join(HOME, "Library/Application Support/opencode/permission-notify/notify.log")

/** 轻量文件日志：排查「点了没反应」时不用去翻服务器日志 */
function log(line: string) {
  try {
    writeFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, { flag: "a" })
  } catch {}
}

type Reply = (typeof DECISIONS)[number]

/**
 * 插件按 location 会加载多份实例，同一授权请求会同时到达每一份。
 * 用临时文件做原子认领，保证一个请求只弹一个窗；顺带用它算出堆叠位置。
 */
function claim(requestID: string): { lock: string; slot: number } | undefined {
  mkdirSync(LOCK_DIR, { recursive: true })
  const lock = join(LOCK_DIR, `${requestID}.lock`)

  // 清理一小时前的残留
  try {
    const now = Date.now()
    for (const name of readdirSync(LOCK_DIR)) {
      const path = join(LOCK_DIR, name)
      try {
        if (now - statSync(path).mtimeMs > 3600_000) unlinkSync(path)
      } catch {}
    }
  } catch {}

  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" })
  } catch {
    return undefined // 另一份实例已经在处理
  }

  let slot = 0
  try {
    slot = readdirSync(LOCK_DIR).filter((n) => n.endsWith(".lock")).length - 1
  } catch {}
  return { lock, slot: Math.max(0, Math.min(slot, 4)) }
}

function summarize(data: any): string {
  const action: string = data?.action ?? "操作"
  const resources: string[] = Array.isArray(data?.resources) ? data.resources : []
  const lines: string[] = []

  if (data?.message) lines.push(String(data.message), "")
  lines.push(`动作：${action}`)

  if (resources.length) {
    const shown = resources.slice(0, 6)
    lines.push(`资源：`)
    for (const item of shown) {
      // 过长的路径中段省略，保证弹窗不炸开
      lines.push(item.length > 90 ? `${item.slice(0, 42)}…${item.slice(-42)}` : item)
    }
    if (resources.length > shown.length) lines.push(`…另有 ${resources.length - shown.length} 项`)
  }

  return lines.join("\n")
}

function ask(message: string, slot = 0, timeoutSeconds = 300): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      HELPER,
      [
        "--title",
        "OpenCode 需要授权",
        "--message",
        message,
        "--buttons",
        "允许一次|总是允许|拒绝",
        "--skip-if-frontmost",
        "ai.opencode.desktop",
        "--slot",
        String(slot),
        "--timeout",
        String(timeoutSeconds),
      ],
      { timeout: (timeoutSeconds + 10) * 1000 },
      (error, stdout) => {
        if (error && !stdout) return resolve(-1)
        const index = Number.parseInt(String(stdout).trim(), 10)
        resolve(Number.isNaN(index) ? -1 : index)
      },
    )
  })
}

export default Plugin.define({
  id: "permission-notify",

  async setup(ctx) {
    if (!ensureHelper()) {
      log(`找不到助手：${HELPER}`)
      return
    }

    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["permission.asked"],
          signal: controller.signal,
        })) {
          const data: any = (event as any).data
          if (!data?.id || !data?.sessionID) continue

          const myDir: string | undefined = (ctx as any).location?.directory
          const eventDir: string | undefined = (event as any).location?.directory
          log(`ctx.location=${myDir} event.location=${eventDir}`)
          // 权限请求按 location 归属；不是本实例的目录就不处理，否则 reply 会报 not found
          if (myDir && eventDir && myDir !== eventDir) continue

          log(`event ${data.id} action=${data.action} at=${Date.now()}`)
          const askedAt = Date.now()

          const claimed = claim(String(data.id))

          try {
            const index = await ask(summarize(data), claimed.slot)
            log(`clicked ${data.id} index=${index} after ${Date.now() - askedAt}ms`)

            // -2：当前前台就是 OpenCode，弹窗里已经能看见，不打扰
            if (index < 0) continue

            const reply: Reply | undefined = DECISIONS[index]
            if (!reply) continue

            try {
              await ctx.permission.reply({
                sessionID: data.sessionID,
                requestID: data.id,
                decision: reply,
              })
              log(`replied ${data.id} -> ${reply}`)
            } catch (error) {
              // 用户在窗口里抢先点了，或请求已失效：忽略
              log(`reply failed ${data.id}: ${error}`)
            }

            // 自检：回复后请求是否真的从待处理列表消失
            try {
              const pending: any[] = await ctx.permission.list({ sessionID: data.sessionID })
              const still = (pending || []).some((p) => p.id === data.id)
              log(`pending after reply: ${(pending || []).length}, still has ${data.id}: ${still}`)
            } catch (error) {
              log(`list failed: ${error}`)
            }
          } finally {
            try {
              unlinkSync(claimed.lock)
            } catch {}
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("[permission-notify] 事件流异常", error)
        }
      }
    })()

    return () => controller.abort()
  },
})
