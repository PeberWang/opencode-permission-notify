// 兜底弹窗（permission.asked → reply）的失效请求测试：npm run test:stale
//
// 用假 ctx 驱动插件本体，假助手替身按脚本"点击"按钮，逐条看日志里的 outcome=ok|stale|error。
// 每个场景都检查去重锁是否清干净。
import assert from "node:assert/strict"
import { test } from "node:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BASE = mkdtempSync(join(tmpdir(), "pn-stale-"))
const HOME = join(BASE, "home")
const TMP = join(BASE, "tmp")
const LOCK_DIR = join(TMP, "opencode-permission-notify")
const LOG = join(HOME, "Library/Application Support/opencode/permission-notify/notify.log")
const MARKER = join(BASE, "helper-started")

mkdirSync(HOME, { recursive: true })
mkdirSync(TMP, { recursive: true })

// 假助手：先留标记（测试据此判断"弹窗已弹出"），再等 delay 毫秒，输出按钮索引
const HELPER = join(BASE, "helper.sh")
writeFileSync(
  HELPER,
  `#!/bin/zsh
print -r -- started > "$PN_MARKER"
sleep "\${PN_DELAY:-0.1}"
print -r -- "\${PN_INDEX:-0}"
`,
)
mkdirSync(BASE, { recursive: true })
chmodSync(HELPER, 0o755)

process.env.HOME = HOME
process.env.TMPDIR = TMP
process.env.PERMISSION_NOTIFY_HELPER = HELPER
process.env.PERMISSION_NOTIFY_LEDGER = join(BASE, "ledger.jsonl")
process.env.PERMISSION_NOTIFY_SETTINGS = join(BASE, "settings.json")
process.env.PERMISSION_NOTIFY_GRANTS = join(BASE, "grants.json")
process.env.PERMISSION_NOTIFY_PENDING = join(BASE, "pending")
process.env.PERMISSION_NOTIFY_REPLIES = join(BASE, "replies")
process.env.PERMISSION_NOTIFY_LOG = LOG
process.env.PN_MARKER = MARKER

const { default: plugin } = await import("../src/index.ts")

interface CtxOptions {
  list: (call: number) => boolean | undefined | "throw"
  reply?: (input: any) => Promise<void>
  delay?: number
  index?: number
}

function makeCtx(options: CtxOptions) {
  const events: any[] = []
  const waiters: (() => void)[] = []
  const replies: any[] = []
  let calls = 0
  let stopped = false

  const ctx = {
    location: { directory: BASE },
    permission: {
      list: async () => {
        calls += 1
        const state = options.list(calls)
        if (state === "throw") throw new Error("list unavailable")
        return [{ id: "per_seed", sessionID: "ses_seed" }, { id: "per_test", sessionID: "ses_test" }].filter(() => state === true)
      },
      reply: async (input: any) => {
        replies.push(input)
        if (options.reply) await options.reply(input)
      },
      hook: async () => ({ dispose: async () => {} }),
    },
    tool: { hook: async () => ({ dispose: async () => {} }) },
    command: { transform: async () => ({ dispose: async () => {} }) },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (stopped) return
            if (events.length) {
              yield events.shift()
              continue
            }
            await new Promise<void>((resolve) => {
              waiters.push(resolve)
              if (stopped) resolve()
            })
          }
        },
      }),
    },
    agent: { get: async () => ({ permissions: [] }) },
    session: { get: async () => ({ title: "t" }) },
    __push(event: any) {
      events.push(event)
      waiters.splice(0).forEach((w) => w())
    },
    __stop() {
      stopped = true
      waiters.splice(0).forEach((w) => w())
    },
    __replies: replies,
  }
  return ctx
}

const log = () => (existsSync(LOG) ? readFileSync(LOG, "utf8") : "")
const lines = () => log().split("\n").filter(Boolean)

async function waitFor(predicate: () => boolean, ms = 12_000, label = "condition") {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`超时等待：${label}\n最近的日志：\n${lines().slice(-12).join("\n")}`)
}

const locks = () => (existsSync(LOCK_DIR) ? readdirSync(LOCK_DIR) : [])

/** 跑一次 published 请求，等日志里出现该 requestID 的结论行 */
async function run(options: CtxOptions & { requestID?: string; seedLockPid?: number }) {
  const requestID = options.requestID ?? "per_test"
  if (options.seedLockPid !== undefined) {
    mkdirSync(LOCK_DIR, { recursive: true })
    writeFileSync(join(LOCK_DIR, `${requestID}.lock`), String(options.seedLockPid))
  }
  rmSync(MARKER, { force: true })
  const before = lines().length
  const ctx = makeCtx(options)
  const cleanup = await plugin.setup(ctx as any)

  const envDelay = process.env.PN_DELAY
  const envIndex = process.env.PN_INDEX
  process.env.PN_DELAY = String(options.delay ?? 0.1)
  process.env.PN_INDEX = String(options.index ?? 0)
  ctx.__push({ data: { id: requestID, sessionID: "ses_test", action: "external_directory", resources: [BASE] }, location: { directory: BASE } })

  await waitFor(() => lines().slice(before).some((l) => l.includes(requestID) && l.includes("outcome=")), 12_000, "结论日志")
  await waitFor(() => locks().length === 0, 3_000, "锁清理")
  process.env.PN_DELAY = envDelay
  process.env.PN_INDEX = envIndex

  const added = lines().slice(before)
  ctx.__stop()
  await cleanup?.()
  return { added, replies: ctx.__replies }
}

const outcome = (added: string[], requestID = "per_test") => added.filter((l) => l.includes(requestID) && l.includes("outcome=")).at(-1) ?? ""

test("请求已经不在：不弹窗，记 stale，助手没有被调用", async () => {
  const { added } = await run({ list: () => false })
  assert.match(outcome(added), /outcome=stale/)
  assert.match(outcome(added), /stage=before-popup/)
  assert.equal(existsSync(MARKER), false, "助手不应该被启动")
  assert.equal(locks().length, 0)
})

test("正常请求：弹出后回复成功，记 ok，OpenCode 侧收到决定", async () => {
  const { added, replies } = await run({ list: () => true, index: 0 })
  assert.match(outcome(added), /outcome=ok/)
  assert.equal(replies.length, 1)
  assert.deepEqual(replies[0], { sessionID: "ses_test", requestID: "per_test", decision: "once" })
})

test("点击后、发回复前请求已消失：关闭弹窗，不发送回复，记 stale", async () => {
  const { added, replies } = await run({
    // 弹窗弹出前一直还在；助手一启动（说明已经开弹窗）就当作在别处被处理
    list: () => (existsSync(MARKER) ? false : true),
    delay: 0.2,
  })
  assert.match(outcome(added), /outcome=stale/)
  assert.match(outcome(added), /stage=before-reply/)
  assert.equal(replies.length, 0, "不应该再发回复")
  assert.equal(locks().length, 0, "锁要清掉")
})

test("确认与发送之间请求消失：reply 报 not found，按已处理记 stale，不算错误", async () => {
  const { added } = await run({
    list: () => true,
    reply: async (input) => {
      throw new Error(`Permission request not found: ${input.requestID}`)
    },
  })
  assert.match(outcome(added), /outcome=stale/)
  assert.match(outcome(added), /stage=reply/)
  assert.equal(added.some((l) => l.includes("outcome=error")), false)
})

test("真正的回复错误：记 error，与 stale 区分", async () => {
  const { added } = await run({
    list: () => true,
    reply: async () => {
      throw new Error("socket hang up")
    },
  })
  assert.match(outcome(added), /outcome=error/)
  assert.match(outcome(added), /stage=reply/)
})

test("弹窗开着时请求在别处被处理：收回窗口，记 stale", async () => {
  const started = Date.now()
  const { added } = await run({
    list: () => (existsSync(MARKER) && Date.now() - started > 1_200 ? false : true),
    delay: 6,
    index: 1,
  })
  assert.match(outcome(added), /outcome=stale/)
  assert.match(outcome(added), /stage=while-open/)
  assert.equal(locks().length, 0)
})

test("死进程留下的锁会被接管，下一个请求照常弹出", async () => {
  const { added, replies } = await run({ list: () => true, seedLockPid: 999_999 })
  const all = lines()
  assert.equal(all.some((l) => l.includes("reclaimed lock per_test")), true, "应该记一行接管")
  assert.match(outcome(added), /outcome=ok/)
  assert.equal(replies.length, 1)
  assert.equal(locks().length, 0)
})

test("查不到待处理列表时照常弹窗，reply 成功记 ok", async () => {
  const { added, replies } = await run({ list: () => "throw" })
  assert.match(outcome(added), /outcome=ok/)
  assert.equal(replies.length, 1)
})
