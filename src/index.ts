import { Plugin } from "@opencode/plugin"
import { execFile, execFileSync, spawn } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CLASSES,
  classify,
  covers,
  hostMatch,
  parseClasses,
  promptBody,
  resolve,
  type Classified,
  type ClassID,
  type Effect,
  type HostRule,
  type Resolution,
  type Tier,
} from "./classes.ts"

/**
 * permission-notify — OpenCode 授权的六类三档。
 *
 * 在 permission evaluate 钩子里、请求发布之前判定一次（覆盖服务端上的所有会话）：
 * 先归类（classes.ts），再与用户设置、宿主规则合成出档位：
 * - silent：直接放行；
 * - pm：交给案头；案头不在线时放行并标注 pm-offline；
 * - human：钩子就地等人——右上角弹窗，同一会话同一类的请求合并成一批问一次；
 * - 宿主 deny：照旧拒绝，插件不放宽。
 * 每次判定写一行台账（JSONL），字段见 HANDOFF.md。
 *
 * 依赖同目录安装的 notify-request 助手（非抢焦浮窗）；设置窗口是 bin/permission-settings。
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

const SETTINGS_APP = process.env.PERMISSION_NOTIFY_SETTINGS_APP ?? fileURLToPath(new URL("../bin/permission-settings", import.meta.url))

const DECISIONS = ["once", "always", "reject"] as const
type Reply = (typeof DECISIONS)[number]

const LOCK_DIR = join(tmpdir(), "opencode-permission-notify")
const LOG_FILE = process.env.PERMISSION_NOTIFY_LOG ?? join(INSTALL_DIR, "notify.log")
/** 判定台账（JSONL，一次判定一行） */
const LEDGER = process.env.PERMISSION_NOTIFY_LEDGER ?? join(INSTALL_DIR, "ledger.jsonl")
/** 插件自己的设置：{"permissionClasses": {"1": "human", ...}}，只存用户显式改过的类 */
const SETTINGS = process.env.PERMISSION_NOTIFY_SETTINGS ?? join(INSTALL_DIR, "settings.json")
/** 「总是允许」存下的授权；/permissions 可查看与撤销 */
const GRANTS = process.env.PERMISSION_NOTIFY_GRANTS ?? join(INSTALL_DIR, "grants.json")
/** 等人回答的批次：pending/<batch>.json；案头作答写 replies/<batch>.json，等待中的批次读到即结束 */
const PENDING = process.env.PERMISSION_NOTIFY_PENDING ?? join(INSTALL_DIR, "pending")
const REPLIES = process.env.PERMISSION_NOTIFY_REPLIES ?? join(INSTALL_DIR, "replies")

/** 案头心跳：案头在线时定期刷新这个文件的修改时间，超过 PM_TTL_S 秒没刷新就算离线 */
const PM_HEARTBEAT = process.env.PERMISSION_NOTIFY_PM_HEARTBEAT ?? join(INSTALL_DIR, "pm-online")
const PM_TTL_S = Number(process.env.PERMISSION_NOTIFY_PM_TTL_S ?? 60)

const BATCH_WINDOW_MS = Number(process.env.PERMISSION_NOTIFY_BATCH_MS ?? 600)
const ASK_TIMEOUT_S = Number(process.env.PERMISSION_NOTIFY_ASK_TIMEOUT_S ?? 300)
const LEDGER_MAX_BYTES = 10 * 1024 * 1024
const HOST_RULES_TTL_MS = 2_000
const TRACE = process.env.PERMISSION_NOTIFY_TRACE === "1"

/** 启动标记里的版本号：用来确认 OpenCode 实际加载的是哪一份代码 */
const BUILD = "classes"
function version(): string {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "?"
  } catch {
    return "?"
  }
}

/** 轻量文件日志：排查「点了没反应」时不用去翻服务器日志 */
function log(line: string) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    writeFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, { flag: "a" })
  } catch {}
}

const short = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s)

function record(entry: Record<string, unknown>) {
  try {
    mkdirSync(dirname(LEDGER), { recursive: true })
    if (existsSync(LEDGER) && statSync(LEDGER).size > LEDGER_MAX_BYTES) renameSync(LEDGER, `${LEDGER}.1`)
    writeFileSync(LEDGER, JSON.stringify({ v: 2, ts: new Date().toISOString(), ...entry }) + "\n", { flag: "a" })
  } catch (error) {
    log(`ledger write failed: ${error}`)
  }
}

// ---------- 设置：每次判定都看一眼文件，改完即生效 ----------

type Lang = "zh" | "en"

let settingsCache: { mtime: number; classes: Partial<Record<ClassID, Tier>>; lang?: Lang } | undefined

function readSettings() {
  try {
    const mtime = statSync(SETTINGS).mtimeMs
    if (settingsCache?.mtime === mtime) return settingsCache
    const raw = JSON.parse(readFileSync(SETTINGS, "utf8"))
    const lang = raw.uiLanguage === "zh" || raw.uiLanguage === "en" ? (raw.uiLanguage as Lang) : undefined
    settingsCache = { mtime, classes: parseClasses(raw.permissionClasses), lang }
    return settingsCache
  } catch {
    return undefined
  }
}

function userClasses(): Partial<Record<ClassID, Tier>> {
  return readSettings()?.classes ?? {}
}

/** 系统首选语言：只查一次（GUI 启动的进程往往没有 LANG，问 defaults 最准） */
let systemLang: Lang | undefined
function detectSystemLang(): Lang {
  if (systemLang) return systemLang
  let first = ""
  try {
    const out = execFileSync("/usr/bin/defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8", timeout: 2000 })
    first = out.match(/"?([A-Za-z][\w-]*)"?\s*,?\s*\n/)?.[1] ?? ""
  } catch {}
  if (!first) first = Intl.DateTimeFormat().resolvedOptions().locale
  systemLang = first.toLowerCase().startsWith("zh") ? "zh" : "en"
  return systemLang
}

/** 弹窗语言：设置窗口存下的 uiLanguage 优先，否则跟随系统；只管显示，判定与台账不受影响 */
function uiLang(): Lang {
  return readSettings()?.lang ?? detectSystemLang()
}

const POPUP_TEXT: Record<Lang, { title: string; buttons: string }> = {
  zh: { title: "OpenCode 需要授权", buttons: "允许一次|总是允许|拒绝" },
  en: { title: "OpenCode needs permission", buttons: "Allow once|Always allow|Reject" },
}

function pmOnline(): boolean {
  try {
    return Date.now() - statSync(PM_HEARTBEAT).mtimeMs <= PM_TTL_S * 1000
  } catch {
    return false
  }
}

// ---------- 宿主规则：合并后的 agent 权限（全局 + 项目 + agent），按 location 取 ----------

const hostRules = new Map<string, { at: number; rules: HostRule[] }>()

async function rulesFor(ctx: any, agent: string | undefined): Promise<HostRule[] | undefined> {
  const agentID = agent ?? "build"
  const key = `${ctx.location?.directory}|${agentID}`
  const cached = hostRules.get(key)
  if (cached && Date.now() - cached.at < HOST_RULES_TTL_MS) return cached.rules
  try {
    const raw: any = await ctx.agent.get({ agentID })
    const list: any[] = (raw?.data ?? raw)?.permissions ?? []
    const rules = list
      .filter((r) => typeof r?.action === "string" && typeof r?.resource === "string" && ["allow", "ask", "deny"].includes(r?.effect))
      .map((r) => ({ action: r.action, resource: r.resource, effect: r.effect as Effect }))
    hostRules.set(key, { at: Date.now(), rules })
    return rules
  } catch (error) {
    log(`agent lookup failed ${agentID}: ${error}`)
    return undefined
  }
}

// ---------- 「总是允许」 ----------

interface Grant {
  id: string
  kind: string
  pattern: string
  cls: ClassID
  created: string
  session: string
  who: string
}

function grants(): Grant[] {
  try {
    return JSON.parse(readFileSync(GRANTS, "utf8"))
  } catch {
    return []
  }
}

function saveGrants(list: Grant[]) {
  mkdirSync(dirname(GRANTS), { recursive: true })
  writeFileSync(`${GRANTS}.tmp`, JSON.stringify(list, null, 2))
  renameSync(`${GRANTS}.tmp`, GRANTS)
}

function granted(classified: Classified): Grant | undefined {
  const g = classified.grant
  return g ? grants().find((x) => covers(x, g)) : undefined
}

// ---------- 进程内状态 ----------

/** 工具调用 id → 工具名与入参（execute.before 先于 evaluate 触发） */
const calls = new Map<string, { tool: string; input: Record<string, unknown>; at: number; judged: number; denied?: boolean; approved?: string }>()
/** 同一次判定只做一次 */
const judged = new Map<string, Promise<Outcome>>()
const batches = new Map<string, Batch>()
const sessions = new Map<string, { at: number; info?: SessionInfo }>()

interface SessionInfo {
  title: string
  directory?: string
}

interface Outcome {
  effect: Effect
  message?: string
}

/** 台账一行里与这次判定有关的字段，判定结束时补上 effect 与结论再写出 */
type Base = Record<string, unknown> & { session: string }

interface Item {
  base: Base
  classified: Classified
  callID?: string
}

interface Answer {
  decision: Reply | "timeout"
  by: string
}

interface Batch {
  id: string
  key: string
  session: string
  who: string
  cls: ClassID
  items: Item[]
  open: boolean
  done: Promise<Answer>
  finish: (r: Answer) => void
}

async function sessionInfo(ctx: any, sessionID: string): Promise<SessionInfo | undefined> {
  const cached = sessions.get(sessionID)
  if (cached && Date.now() - cached.at < 30_000) return cached.info
  try {
    const raw: any = await ctx.session.get({ sessionID })
    const s = raw?.data ?? raw
    const info = { title: String(s?.title ?? ""), directory: s?.location?.directory }
    sessions.set(sessionID, { at: Date.now(), info })
    return info
  } catch (error) {
    log(`session lookup failed ${sessionID}: ${error}`)
    return undefined
  }
}

/** 「谁在请求」：案头交办的会话标题以 🦞 开头 */
function describeWho(info: SessionInfo | undefined, sessionID: string, agent?: string): string {
  const title = info?.title.trim() ?? ""
  const name = title.startsWith("🦞") ? `案头交办「${title.replace(/^🦞\s*/, "")}」` : title ? `会话「${title}」` : `会话 ${sessionID.slice(-8)}`
  return agent ? `${name}（${agent}）` : name
}

// ---------- 弹窗 ----------

/** 返回按钮索引；-1 超时/取消；-2 OpenCode 在前台；-3 被 signal 收回 */
function ask(
  message: string,
  slot = 0,
  signal?: AbortSignal,
  options: { skipFrontmost?: boolean; timeoutSeconds?: number } = {},
): Promise<number> {
  const timeoutSeconds = options.timeoutSeconds ?? ASK_TIMEOUT_S
  const text = POPUP_TEXT[uiLang()]
  return new Promise((resolve) => {
    execFile(
      HELPER,
      [
        "--title",
        text.title,
        "--message",
        message,
        "--buttons",
        text.buttons,
        ...(options.skipFrontmost ? ["--skip-if-frontmost", "ai.opencode.desktop"] : []),
        "--slot",
        String(slot),
        "--timeout",
        String(timeoutSeconds),
      ],
      { timeout: (timeoutSeconds + 10) * 1000, signal },
      (error, stdout) => {
        if (signal?.aborted) return resolve(-3)
        if (error && !stdout) return resolve(-1)
        const index = Number.parseInt(String(stdout).trim(), 10)
        resolve(Number.isNaN(index) ? -1 : index)
      },
    )
  })
}

function readReply(batchID: string): { decision: Reply; by: string } | undefined {
  const file = join(REPLIES, `${batchID}.json`)
  try {
    const body = JSON.parse(readFileSync(file, "utf8"))
    unlinkSync(file)
    if (DECISIONS.includes(body.decision)) return { decision: body.decision, by: String(body.by ?? "docket") }
  } catch {}
  return undefined
}

/** 打开一批：写 pending/<batch>.json 给案头出卡，弹窗与案头并行，谁先答算谁的 */
async function runBatch(batch: Batch) {
  batch.open = true
  const what = batch.items.flatMap((i) => i.classified.what)
  const pendingFile = join(PENDING, `${batch.id}.json`)
  try {
    mkdirSync(PENDING, { recursive: true })
    writeFileSync(pendingFile, JSON.stringify({ batch: batch.id, session: batch.session, who: batch.who, class: batch.cls, what, created: new Date().toISOString() }))
  } catch (error) {
    log(`pending write failed ${batch.id}: ${error}`)
  }
  log(`ask batch ${batch.id} class=${batch.cls} n=${batch.items.length}`)

  const stop = new AbortController()
  let docket: { decision: Reply; by: string } | undefined
  const watcher = setInterval(() => {
    docket ??= readReply(batch.id)
    if (docket) stop.abort()
  }, 500)
  let index: number
  try {
    index = await ask(promptBody(what, uiLang()), Math.min(batches.size - 1, 4), stop.signal)
  } finally {
    clearInterval(watcher)
    try {
      unlinkSync(pendingFile)
    } catch {}
  }

  let result: Answer
  if (index === -3 && docket) result = docket
  else if (index >= 0 && DECISIONS[index]) result = { decision: DECISIONS[index], by: "popup" }
  else result = { decision: "timeout", by: index === -1 ? "timeout" : "error" }

  if (result.decision === "always") {
    const list = grants()
    for (const item of batch.items) {
      const g = item.classified.grant
      if (!g || list.some((x) => covers(x, g))) continue
      list.push({
        id: `grt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        kind: g.kind,
        pattern: g.pattern,
        cls: item.classified.cls,
        created: new Date().toISOString(),
        session: batch.session,
        who: batch.who,
      })
    }
    saveGrants(list)
  }
  log(`resolved batch ${batch.id} -> ${result.decision} by ${result.by} outcome=${result.decision === "timeout" ? "skip" : "ok"}`)
  batches.delete(batch.key)
  batch.finish(result)
}

function newBatch(key: string, item: Item, who: string): Batch {
  let finish!: Batch["finish"]
  const done = new Promise<Answer>((resolve) => (finish = resolve))
  const batch: Batch = {
    id: `bat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    key,
    session: item.base.session,
    who,
    cls: item.classified.cls,
    items: [item],
    open: false,
    done,
    finish,
  }
  batches.set(key, batch)
  setTimeout(
    () =>
      void runBatch(batch).catch((error) => {
        log(`batch ${batch.id} failed: ${error} outcome=error stage=batch`)
        batches.delete(key)
        finish({ decision: "timeout", by: "error" })
      }),
    BATCH_WINDOW_MS,
  )
  return batch
}

/** 同一会话、同一类的请求并进同一批；已经弹出的批次不再加人，等它答完再看 */
async function enqueue(item: Item, who: string): Promise<Outcome> {
  const key = `${item.base.session}|${item.classified.cls}`
  for (;;) {
    const current = batches.get(key)
    if (current && !current.open) {
      current.items.push(item)
      return settle(current, item)
    }
    if (current) {
      await current.done
      const hit = granted(item.classified)
      if (hit) return finishItem(item, "allow", { note: "grant", grant: hit.id })
      continue
    }
    return settle(newBatch(key, item, who), item)
  }
}

async function settle(batch: Batch, item: Item): Promise<Outcome> {
  const result = await batch.done
  const allow = result.decision === "once" || result.decision === "always"
  if (allow && item.callID) {
    const call = calls.get(item.callID)
    if (call) call.approved = batch.id
  }
  const extra = { batch: batch.id, by: result.by, answer: result.decision }
  if (allow) return finishItem(item, "allow", extra)
  const why = result.decision === "timeout" ? `${Math.round(ASK_TIMEOUT_S / 60)} 分钟内没有人确认` : "用户拒绝了"
  return finishItem(item, "deny", extra, `${why}：${item.classified.what.join("；")}。这次操作没有执行。`)
}

/** 每次判定的唯一出口：写一行台账，返回给钩子 */
function finishItem(item: Item, effect: Effect, extra: Record<string, unknown> = {}, message?: string): Outcome {
  record({ ...item.base, effect, ...extra })
  if (effect === "deny" && item.callID) {
    const call = calls.get(item.callID)
    if (call) call.denied = true
  }
  return message ? { effect, message } : { effect }
}

async function judge(ctx: any, event: any): Promise<Outcome> {
  const info = await sessionInfo(ctx, event.sessionID)
  const callID: string | undefined = event.source?.id ? String(event.source.id) : undefined
  const call = callID ? calls.get(callID) : undefined
  const project = info?.directory ?? ctx.location?.directory
  const resources: string[] = (event.resources ?? []).map(String)
  const classified = classify(
    { action: event.action, resources, effect: event.effect, metadata: event.metadata },
    { project, call: call && { tool: call.tool, input: call.input } },
  )
  const rules = await rulesFor(ctx, event.agent)
  const match = rules ? hostMatch(rules, event.action, resources) : undefined
  const hostEffect: Effect = event.effect
  const online = pmOnline()
  const resolution: Resolution = resolve({ cls: classified.cls, user: userClasses(), hostEffect, hostMatched: !!match, pmOnline: online })
  const who = describeWho(info, event.sessionID, event.agent)
  if (call) call.judged += 1

  const item: Item = {
    callID,
    classified,
    base: {
      session: event.sessionID,
      who,
      agent: event.agent,
      call: callID,
      tool: call?.tool,
      action: event.action,
      resources: resources.slice(0, 5).map((r) => short(r)),
      host_effect: hostEffect,
      host_rule: match?.rule ?? null,
      class: classified.cls,
      class_name: CLASSES[classified.cls].name,
      source: resolution.source,
      tier: resolution.tier,
      reason: classified.reason,
      why: resolution.why,
      ...(resolution.fallback ? { fallback: resolution.fallback } : {}),
    },
  }

  switch (resolution.tier) {
    case "deny":
      return finishItem(item, "deny", {}, event.message)
    case "silent":
      return finishItem(item, "allow")
    case "pm":
      // 托管：放行并留痕，案头读台账复核（方案 A）；离线时也放行，类 1 已在 resolve 里转人工
      return finishItem(item, "allow", { note: online ? "pm-online" : "pm-offline" })
    case "human": {
      const hit = granted(classified)
      if (hit) return finishItem(item, "allow", { note: "grant", grant: hit.id })
      // 同一次工具调用在前一道检查（如 external_directory）里已经由人批准过，不再问第二遍
      if (call?.approved) return finishItem(item, "allow", { note: "same-call", batch: call.approved })
      if (!classified.what.length) classified.what = [`${event.action} ${resources.join(", ")}`.trim()]
      return enqueue(item, who)
    }
  }
}

// ---------- /permissions：查看与撤销「总是允许」 ----------

function listGrants(): string {
  const list = grants()
  if (!list.length) return "目前没有「总是允许」存下的授权。"
  return [
    `「总是允许」存下的授权（${list.length} 条，文件 ${GRANTS}）：`,
    ...list.map((g) => `- ${g.id}  类 ${g.cls ?? "?"}  ${g.pattern}  （${g.created.slice(0, 16)}，${g.who}）`),
    "",
    "撤销：/permissions revoke <id>，全部撤销：/permissions revoke all",
  ].join("\n")
}

function revoke(arg: string): string {
  const list = grants()
  const keep = arg === "all" ? [] : list.filter((g) => g.id !== arg)
  if (keep.length === list.length) return `没有找到授权 ${arg}。\n\n${listGrants()}`
  saveGrants(keep)
  log(`revoked ${list.length - keep.length} grants: ${arg}`)
  return `已撤销 ${list.length - keep.length} 条授权。\n\n${listGrants()}`
}

/** 打开设置窗口（独立进程，关掉 OpenCode 也不影响） */
function openSettings(): string {
  if (!existsSync(SETTINGS_APP)) return `找不到设置窗口程序：${SETTINGS_APP}。先在仓库里跑 ./build.sh。`
  const child = spawn(SETTINGS_APP, ["--settings", SETTINGS, "--ledger", LEDGER], { detached: true, stdio: "ignore" })
  child.on("error", (error) => log(`settings window failed: ${error}`))
  child.unref()
  return `已打开授权分级设置窗口。设置文件：${SETTINGS}`
}

// ---------- 兜底：仍被发布出来的请求（其他插件发起、或钩子未生效时） ----------

const PRECHECK_MS = 900
const PRECHECK_EVERY_MS = 150
const WATCH_EVERY_MS = 1000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 三种结局统一用 outcome=ok|stale|error 收尾，另有 outcome=skip 表示没人回答（超时、前台已是 OpenCode、去重） */
async function pending(ctx: any, sessionID: string, requestID: string): Promise<boolean | undefined> {
  try {
    const list: any[] = await ctx.permission.list({ sessionID })
    return (list || []).some((p) => p.id === requestID)
  } catch (error) {
    log(`list failed ${requestID} outcome=error stage=verify: ${error}`)
    return undefined
  }
}

/** reply 的 not-found：请求在别处（案头、--auto、OpenCode 窗口）先被处理掉了，属正常竞争 */
function isNotFound(error: unknown): boolean {
  const tag = (error as any)?._tag
  if (tag === "PermissionNotFoundError") return true
  const status = (error as any)?.status ?? (error as any)?.statusCode
  if (status === 404) return true
  return /not found/i.test(String((error as any)?.message ?? error))
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === "EPERM" // 进程在，只是没权限发信号
  }
}

/** 插件按 location 加载多份实例，同一个已发布请求会到达每一份：用临时文件做原子认领 */
function claim(requestID: string): string | undefined {
  mkdirSync(LOCK_DIR, { recursive: true })
  const lock = join(LOCK_DIR, `${requestID}.lock`)
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
    return lock
  } catch {}
  // 上次异常退出留下的锁：写入者已经不在了就接管，别让后面的请求弹不出来
  try {
    const owner = Number.parseInt(readFileSync(lock, "utf8").trim(), 10)
    if (alive(owner)) return undefined
    unlinkSync(lock)
    writeFileSync(lock, String(process.pid), { flag: "wx" })
    log(`reclaimed lock ${requestID} (owner pid ${Number.isInteger(owner) ? owner : "?"} gone)`)
    return lock
  } catch {
    return undefined
  }
}

async function handlePublished(ctx: any, data: any) {
  const askedAt = Date.now()
  const elapsed = () => Date.now() - askedAt
  const lock = claim(String(data.id))
  if (!lock) {
    log(`skip ${data.id} reason=dedupe outcome=skip stage=claim`)
    return
  }
  try {
    // 1. 弹窗前：请求到达后每 150ms 复查，900ms 内消失就不弹
    while (elapsed() < PRECHECK_MS) {
      await sleep(PRECHECK_EVERY_MS)
      if ((await pending(ctx, data.sessionID, data.id)) === false) {
        log(`stale ${data.id}: already resolved elsewhere (stage=before-popup, not shown, ${elapsed()}ms) outcome=stale`)
        return
      }
    }
    // 最后一次确认：只在明确「还在」或「查不到」时弹，明确「不在」就不弹
    if ((await pending(ctx, data.sessionID, data.id)) === false) {
      log(`stale ${data.id}: already resolved elsewhere (stage=before-popup, not shown, ${elapsed()}ms) outcome=stale`)
      return
    }

    const resources: string[] = Array.isArray(data.resources) ? data.resources : []
    const message = promptBody(resources.length ? resources.map((r) => `${data.action} ${r}`) : [String(data.action)], uiLang())
    // 弹窗开着期间请求在别处被处理：收回窗口，让人点不到一个已经不存在的请求
    const dismiss = new AbortController()
    const watcher = setInterval(async () => {
      if ((await pending(ctx, data.sessionID, data.id)) === false) dismiss.abort()
    }, WATCH_EVERY_MS)
    let index: number
    try {
      index = await ask(message, 0, dismiss.signal, { skipFrontmost: true })
    } finally {
      clearInterval(watcher)
    }

    if (index === -3) {
      log(`stale ${data.id}: already resolved elsewhere (stage=while-open, popup withdrawn, ${elapsed()}ms) outcome=stale`)
      return
    }
    if (index === -2) {
      log(`skip ${data.id} reason=frontmost outcome=skip stage=popup`)
      return
    }
    const reply = DECISIONS[index]
    if (!reply) {
      log(`skip ${data.id} reason=${index === -1 ? "timeout" : `unknown-button-${index}`} outcome=skip stage=popup after ${elapsed()}ms`)
      return
    }

    // 2. 发回复前再确认一次：确认与发送之间仍有极短窗口，交给下面的 catch 兜底
    if ((await pending(ctx, data.sessionID, data.id)) === false) {
      log(`stale ${data.id}: already resolved elsewhere (stage=before-reply, ${reply} not sent, popup closed, ${elapsed()}ms) outcome=stale`)
      return
    }

    try {
      await ctx.permission.reply({ sessionID: data.sessionID, requestID: data.id, decision: reply })
      log(`replied ${data.id} -> ${reply} after ${elapsed()}ms outcome=ok`)
    } catch (error) {
      // 3. 确认之后、发送之前请求消失：按「已被别处处理」记 info，不算错误
      if (isNotFound(error)) {
        log(`stale ${data.id}: already resolved elsewhere (stage=reply, ${reply} was not applied, ${error}) outcome=stale`)
      } else {
        log(`error ${data.id}: reply failed (${reply}): ${error} outcome=error stage=reply`)
      }
    }
  } finally {
    try {
      unlinkSync(lock)
    } catch {}
  }
}

/**
 * 宿主显式 deny 不经过 evaluate 钩子；从工具报错里补一行台账，保证每次判定都有记录。
 * 同一次调用里插件自己判过 deny 时，报错来自插件，已有台账，不补记；
 * 前面的检查放行过（如 external_directory）而后一道被宿主拒绝，照样补记。
 * 只认 OpenCode 的 Permission.BlockedError（2.3.2 实测挂在 error.error 上），文件系统的 EACCES 等不算。
 */
function blockedBy(error: unknown): HostRule[] | undefined {
  let e: any = error
  for (let depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    if (e._tag === "Permission.BlockedError") return Array.isArray(e.rules) ? e.rules : []
    e = e.error ?? e.cause
  }
  return undefined
}

function recordHostDeny(ctx: any, event: any) {
  const call = calls.get(String(event.id))
  if (!call || call.denied) return
  const rules = blockedBy(event.error)
  if (!rules) return
  const message = String(event.error?.message ?? event.error ?? "")
  const input = (event.input ?? {}) as Record<string, unknown>
  const action = event.tool === "shell" ? "shell" : event.tool === "write" || event.tool === "patch" ? "edit" : String(event.tool)
  const resource = typeof input.command === "string" ? input.command : typeof input.path === "string" ? input.path : typeof input.filePath === "string" ? input.filePath : "*"
  const match = hostMatch(rules, action, [resource])
  const classified = classify({ action, resources: [resource], effect: "deny" }, { project: sessions.get(event.sessionID)?.info?.directory ?? ctx.location?.directory })
  record({
    session: event.sessionID,
    who: describeWho(sessions.get(event.sessionID)?.info, event.sessionID, event.agent),
    agent: event.agent,
    call: String(event.id),
    tool: event.tool,
    action,
    resources: [short(resource)],
    host_effect: "deny",
    host_rule: match?.effect === "deny" ? match.rule : null,
    class: classified.cls,
    class_name: CLASSES[classified.cls].name,
    source: "host",
    tier: "deny",
    reason: classified.reason,
    why: "宿主规则拒绝（未经过 evaluate 钩子，从工具报错补记）",
    effect: "deny",
    note: "observed-after",
    error: short(message, 200),
  })
}

export default Plugin.define({
  id: "permission-notify",

  async setup(ctx) {
    if (!ensureHelper()) {
      log(`找不到助手：${HELPER}`)
      return
    }
    const dir = (ctx as any).location?.directory
    log(`started v${version()}+${BUILD} pid=${process.pid} dir=${dir} src=${import.meta.url}`)

    const hooks: { dispose(): Promise<void> }[] = []

    hooks.push(
      await (ctx as any).tool.hook("execute.before", (event: any) => {
        calls.set(String(event.id), { tool: String(event.tool), input: event.input ?? {}, at: Date.now(), judged: 0 })
        if (calls.size > 500) {
          const cutoff = Date.now() - 600_000
          for (const [id, c] of calls) if (c.at < cutoff) calls.delete(id)
        }
      }),
    )

    hooks.push(
      await (ctx as any).tool.hook("execute.after", (event: any) => {
        if (TRACE && event.status === "error") log(`trace execute.after ${event.id} ${short(JSON.stringify({ ...event, input: undefined, output: undefined }), 600)}`)
        if (event.status === "error") recordHostDeny(ctx, event)
      }),
    )

    hooks.push(
      await (ctx as any).permission.hook("evaluate", async (event: any) => {
        if (TRACE) log(`trace evaluate ${event.sessionID} ${event.source?.id ?? "-"} ${event.action} effect=${event.effect}`)
        const key = [event.sessionID, event.source?.id ?? "", event.action, ...(event.resources ?? [])].join("\u0000")
        let outcome = judged.get(key)
        if (!outcome) {
          outcome = judge(ctx, event).catch((error): Outcome => {
            // 判定本身出错：不放行，也不打断人，交还 OpenCode 原判（ask 会走兜底弹窗）
            log(`judge failed: ${error}`)
            return { effect: event.effect }
          })
          judged.set(key, outcome)
          void outcome.finally(() => setTimeout(() => judged.delete(key), 5_000))
        }
        const result = await outcome
        event.effect = result.effect
        if (result.message) event.message = result.message
      }),
    )

    hooks.push(
      await (ctx as any).command.transform((editor: any) => {
        editor.add({
          name: "permissions",
          description: "查看或撤销「总是允许」存下的授权（/permissions revoke <id|all>）",
          execute: async ({ sessionID, prompt }: any) => {
            const args = String(prompt?.text ?? "").trim().split(/\s+/).filter(Boolean)
            const text = args[0] === "revoke" && args[1] ? revoke(args[1]) : listGrants()
            await (ctx as any).session.synthetic({ sessionID, text })
          },
        })
        editor.add({
          name: "permission-classes",
          description: "打开授权分级设置窗口（六类三档）",
          execute: async ({ sessionID }: any) => {
            await (ctx as any).session.synthetic({ sessionID, text: openSettings() })
          },
        })
      }),
    )

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: ["permission.asked"], signal: controller.signal })) {
          const data: any = (event as any).data
          if (!data?.id || !data?.sessionID) continue
          const eventDir: string | undefined = (event as any).location?.directory
          if (dir && eventDir && dir !== eventDir) continue
          log(`published event ${data.id} action=${data.action}`)
          void handlePublished(ctx, data).catch((error) => log(`handle failed ${data.id}: ${error}`))
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("[permission-notify] 事件流异常", error)
      }
    })()

    return () => {
      controller.abort()
      for (const h of hooks) void h.dispose().catch(() => {})
    }
  },
})
