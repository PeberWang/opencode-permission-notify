/**
 * 六类三档。纯函数，不碰 OpenCode，便于单测与调整。
 *
 * 一次 evaluate 先归到六类之一（classify），再与用户设置、宿主配置合成出最终档位（resolve）。
 * 合成规则见 HANDOFF.md「判定顺序」，与任务书规格二的五条一一对应。
 */

import { homedir } from "node:os"
import { isAbsolute, resolve as resolvePath } from "node:path"

export type Effect = "allow" | "ask" | "deny"
export type Tier = "human" | "pm" | "silent"
export type ClassID = "1" | "2" | "3" | "4" | "5" | "6"
export type Source = "default" | "user" | "host"

export const TIERS: readonly Tier[] = ["human", "pm", "silent"]
export const CLASS_IDS: readonly ClassID[] = ["1", "2", "3", "4", "5", "6"]

export const CLASSES: Record<ClassID, { name: string; desc: string; tier: Tier }> = {
  "1": { name: "不可逆或越界", desc: "删除、sudo、凭证与密钥、对外发布、项目外写入、判不清归属", tier: "human" },
  "2": { name: "项目外只读", desc: "读取、搜索项目目录以外的文件", tier: "pm" },
  "3": { name: "项目内执行", desc: "在项目里跑 shell 命令", tier: "pm" },
  "4": { name: "项目内写入", desc: "在项目里编辑、写入、新建文件", tier: "pm" },
  "5": { name: "项目内只读", desc: "读取、搜索项目里的文件", tier: "silent" },
  "6": { name: "无副作用", desc: "查询、列目录、读配置、联网检索", tier: "silent" },
}

export const DEFAULT_CLASSES: Record<ClassID, Tier> = Object.fromEntries(CLASS_IDS.map((c) => [c, CLASSES[c].tier])) as Record<ClassID, Tier>

export interface Evaluation {
  action: string
  resources: readonly string[]
  /** OpenCode 按宿主规则与已保存授权算出的结果 */
  effect: Effect
  metadata?: Record<string, unknown>
}

export interface ToolCall {
  tool: string
  input?: Record<string, unknown>
}

export interface Context {
  /** 会话所在的项目目录（绝对路径） */
  project?: string
  /** 发起这次判定的工具调用；external_directory 靠它区分读与写 */
  call?: ToolCall
  home?: string
}

export interface Classified {
  cls: ClassID
  reason: string
  /** 弹窗正文：动作与命令或路径，一条一行 */
  what: string[]
  /** 「总是允许」存下的授权：同 kind 下按 pattern 匹配 */
  grant?: { kind: string; pattern: string }
}

// ---------- 显式清单 ----------

export const READ_TOOLS = new Set(["read", "grep"])
export const LIST_TOOLS = new Set(["glob", "list"])
export const WRITE_TOOLS = new Set(["write", "edit", "patch", "apply_patch", "multiedit"])

/** 内置的查询类动作：不改变任何东西 */
const QUERY_ACTIONS = new Set([
  "question",
  "todowrite",
  "todoread",
  "skill",
  "subagent",
  "task",
  "webfetch",
  "websearch",
  "execute", // Code Mode 外壳；里面的工具各自再判
  "experimental_image_generate",
  "opencode_list_mcp_resources",
  "opencode_read_mcp_resource",
])

/** 只读也算类 1：内容进入模型上下文，等同于把凭据发出去 */
export const SENSITIVE = [
  "~/.ssh/*",
  "~/.gnupg/*",
  "~/.aws/*",
  "~/.config/gh/*",
  "~/.netrc",
  "~/.openclaw/workspace/secrets.json",
  "~/.openclaw/*/secrets*",
  "~/.gmail-mcp/*",
  "~/.local/share/opencode/auth.json",
  "~/.local/share/opencode/mcp-auth.json",
  "~/.config/opencode/secrets/*",
  "~/Library/Keychains/*",
  "*.env",
  "*.env.*",
  "*/id_rsa*",
  "*/id_ed25519*",
  "*.pem",
  "*.p12",
]
/** *.env.example 之类模板不算敏感 */
const SENSITIVE_EXEMPT = ["*.env.example", "*.env.sample", "*.env.template"]

/** 不可逆、提权或系统级的 shell 命令 */
export const DESTRUCTIVE_SHELL: RegExp[] = [
  /^sudo\b/,
  /^rm\b/,
  /^rmdir\b/,
  /^dd\b/,
  /^diskutil\b/,
  /^chmod\s+-R\b/,
  /^chown\b/,
  /^kill\b/,
  /^pkill\b/,
  /^killall\b/,
  /^launchctl\b/,
  /^git\s+reset\s+--hard\b/,
  /^git\s+clean\b/,
  /^git\s+checkout\s+--(\s|$)/,
  /^git\s+branch\s+-D\b/,
  /^git\s+stash\s+drop\b/,
  /^openclaw\s+models\s+auth\b/,
  /^security\s+(find|dump|delete)-/,
]

/** 对外发布或发送数据的 shell 命令 */
export const EGRESS_SHELL: RegExp[] = [
  /^git\s+push\b/,
  /^(npm|pnpm|yarn|bun)\s+publish\b/,
  /^(curl|wget)\b.*(\s-d\b|\s--data(-\w+)?\b|\s-F\b|\s--form\b|\s-T\b|\s--upload-file\b|\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s--request\s+(POST|PUT|PATCH|DELETE)\b|\s--post-(data|file)\b)/i,
  /^scp\b/,
  /^rsync\b.*\s[^\s/]+:/,
  /^gh\s+(pr\s+(create|merge|comment|review)|release\s+create|issue\s+(create|comment)|gist\s+create|repo\s+create)\b/,
  /^twine\s+upload\b/,
  /^cargo\s+publish\b/,
]

/** MCP 工具：对外发送或公开发布（动作名已归一为小写、非字母数字转 _） */
export const MCP_EGRESS = new Set([
  "gmail_send_email",
  "github_create_pull_request",
  "github_create_pull_request_with_copilot",
  "github_merge_pull_request",
  "github_update_pull_request",
  "github_push_files",
  "github_create_or_update_file",
  "github_issue_write",
  "github_sub_issue_write",
  "github_add_issue_comment",
  "github_update_issue_comment",
  "github_add_reply_to_pull_request_comment",
  "github_pull_request_review_write",
  "github_add_comment_to_pending_review",
  "notion_api_create_a_comment",
])

/** MCP 工具名里表示只读查询的词：命中且不在发送/删除清单里，归类 6 */
const MCP_QUERY = /(^|_)(get|list|search|read|query|find|fetch|lookup|status|snapshot|screenshot|analyze|retrieve|describe|count|view|show|active_file_get_path|whoami|me)(_|$)/

const MCP_DELETE = /(^|_)(delete|remove|trash|destroy|drop|purge|revoke)(_|$)/

/** OpenCode 自己的配置与数据目录：读这里算「读配置」 */
const INTERNAL_DIRS = ["~/.config/opencode", "~/.local/share/opencode", "/dev"]

// ---------- 工具函数 ----------

export function expand(path: string, home = homedir()): string {
  if (path === "~") return home
  if (path.startsWith("~/")) return home + path.slice(1)
  if (path === "$HOME") return home
  if (path.startsWith("$HOME/")) return home + path.slice(5)
  return path
}

/** 与 OpenCode 一致的整串通配：* 匹配任意字符（含 /），? 匹配一个字符 */
export function glob(pattern: string, value: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${re}$`, "s").test(value)
}

function under(path: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, "")
  return path === d || path.startsWith(d + "/")
}

function abs(path: string, ctx: Context): string {
  const p = expand(path.replace(/\/\*$/, ""), ctx.home ?? homedir())
  return isAbsolute(p) ? resolvePath(p) : resolvePath(ctx.project ?? "/", p)
}

export function sensitive(path: string, home = homedir()): boolean {
  const p = expand(path, home)
  if (SENSITIVE_EXEMPT.some((g) => glob(g, p))) return false
  return SENSITIVE.some((g) => glob(expand(g, home), p))
}

function internal(path: string, ctx: Context): boolean {
  const p = abs(path, ctx)
  const home = ctx.home ?? homedir()
  if (INTERNAL_DIRS.some((d) => under(p, expand(d, home)))) return true
  return !!process.env.TMPDIR && under(p, resolvePath(process.env.TMPDIR, "opencode"))
}

function outside(path: string, ctx: Context): boolean {
  return !ctx.project || !under(abs(path, ctx), resolvePath(ctx.project))
}

/** 去掉开头的 VAR=x 赋值与 env/command/nohup/time 前缀，再做前缀匹配 */
export function head(command: string): string {
  let c = command.trim()
  for (;;) {
    const next = c.replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+|env\s+|command\s+|nohup\s+|time\s+)/, "")
    if (next === c) return c
    c = next
  }
}

/** 命令里显式写出的写入目标：> / >> / tee / cp、mv 的最后一个参数 */
export function writeTargets(command: string): string[] {
  const out: string[] = []
  const strip = (s: string) => s.replace(/^["']|["']$/g, "")
  for (const m of command.matchAll(/(?:^|[^<>&\d])\d?>>?\|?\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    if (!m[1].startsWith("&")) out.push(strip(m[1]))
  }
  for (const m of command.matchAll(/(?:^|[|;&]\s*)tee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/g)) out.push(strip(m[1]))
  const h = head(command)
  if (/^(cp|mv)\s/.test(h)) {
    const args = h.split(/\s+/).slice(1).filter((a) => !a.startsWith("-"))
    if (args.length >= 2) out.push(strip(args[args.length - 1]))
  }
  return out
}

export function normalizeAction(action: string): string {
  return action.toLowerCase().replace(/[^a-z0-9]+/g, "_")
}

const c = (cls: ClassID, reason: string, what: string[], grant?: Classified["grant"]): Classified => ({ cls, reason, what, grant })

/** shell 命令单独归类；外部目录检查也借它判断命令是不是越界 */
function shellClass(commands: readonly string[], ctx: Context): Classified {
  const home = ctx.home ?? homedir()
  for (const command of commands) {
    const h = head(command)
    if (DESTRUCTIVE_SHELL.some((re) => re.test(h))) return c("1", "不可逆或提权的命令", [command], { kind: "shell", pattern: command })
    if (EGRESS_SHELL.some((re) => re.test(h))) return c("1", "对外发布或发送数据", [command], { kind: "shell", pattern: command })
    const external = writeTargets(command).filter((t) => (isAbsolute(expand(t, home)) || t.startsWith("~")) && !internal(t, ctx) && outside(t, ctx))
    if (external.length) return c("1", "命令写到项目外", [command], { kind: "shell", pattern: command })
  }
  return c("3", "项目内执行", [...commands])
}

// ---------- 归类 ----------

export function classify(ev: Evaluation, ctx: Context): Classified {
  const home = ctx.home ?? homedir()
  const resources = ev.resources.map(String)
  const action = ev.action
  const tool = ctx.call?.tool
  const input = ctx.call?.input ?? {}
  const target = typeof input.path === "string" ? input.path : typeof input.filePath === "string" ? input.filePath : undefined

  // 项目外目录：OpenCode 只告诉我们是哪个目录，读还是写要看发起它的工具
  if (action === "external_directory") {
    const dir = resources[0] ?? ""
    if (tool === "shell") {
      const command = typeof input.command === "string" ? input.command : ""
      if (!command) return c("1", "项目外目录请求，查不到发起它的命令", [`shell ${dir}`])
      const sc = shellClass([command], ctx)
      return sc.cls === "1" ? sc : c("2", "命令访问项目外目录", [command])
    }
    if (tool && (READ_TOOLS.has(tool) || LIST_TOOLS.has(tool))) {
      const paths = [target, ...resources].filter(Boolean) as string[]
      const hit = paths.find((p) => sensitive(p, home))
      if (hit) return c("1", "读取凭证或密钥", [`${tool} ${target ?? hit}`], { kind: "read-sensitive", pattern: expand(target ?? hit, home) })
      if (paths.every((p) => internal(p, ctx))) return c("6", "读 OpenCode 配置", [`${tool} ${target ?? dir}`])
      return c("2", "项目外只读", [`${tool} ${target ?? dir}`])
    }
    if (tool && WRITE_TOOLS.has(tool)) {
      return c("1", "写到项目外", [`${tool} ${target ?? dir}`], { kind: "write-external", pattern: expand(dir, home) })
    }
    return c("1", tool ? `项目外目录请求来自无法归类的工具 ${tool}` : "项目外目录请求，查不到发起它的工具", [`${tool ?? action} ${dir}`.trim()])
  }

  if (READ_TOOLS.has(action) || LIST_TOOLS.has(action)) {
    const hit = resources.find((p) => sensitive(p, home))
    if (hit) return c("1", "读取凭证或密钥", [`${action} ${hit}`], { kind: "read-sensitive", pattern: abs(hit, ctx) })
    const what = [`${action} ${resources.join(", ")}`.trim()]
    // grep 的资源是正则、glob 的资源是模式，不是路径：它们的范围由前面的 external_directory 把关
    if (action === "read" && resources.some((p) => outside(p, ctx))) {
      return resources.every((p) => internal(p, ctx)) ? c("6", "读 OpenCode 配置", what) : c("2", "项目外只读", what)
    }
    return LIST_TOOLS.has(action) ? c("6", "列目录", what) : c("5", "项目内只读", what)
  }

  if (action === "edit") {
    const files = Array.isArray((ev.metadata as any)?.files) ? ((ev.metadata as any).files as any[]) : []
    const deleted = files.filter((f) => f?.status === "deleted").map((f) => String(f.file))
    if (deleted.length) return c("1", "删除文件", deleted.map((f) => `删除 ${f}`), { kind: "delete-file", pattern: abs(deleted[0], ctx) })
    const out = resources.filter((p) => outside(p, ctx) && !internal(p, ctx))
    if (out.length) return c("1", "写到项目外", out.map((p) => `edit ${p}`), { kind: "write-external", pattern: abs(out[0], ctx) })
    return c("4", "项目内写入", resources.map((p) => `edit ${p}`))
  }

  if (action === "shell") return shellClass(resources, ctx)

  if (QUERY_ACTIONS.has(action)) return c("6", "查询类", [`${action} ${resources.join(", ")}`.trim()])

  // 其余：MCP 工具或插件自定义动作，只能看名字
  const name = normalizeAction(action)
  if (MCP_EGRESS.has(name)) return c("1", "对外发送或发布", [action], { kind: "mcp", pattern: name })
  if (MCP_DELETE.test(name)) return c("1", "删除外部系统里的数据", [action], { kind: "mcp", pattern: name })
  if (MCP_QUERY.test(name)) return c("6", "查询类", [action])
  return c("1", "外部系统写入或未知动作，判不清归属", [`${action} ${resources.filter((r) => r !== "*").join(", ")}`.trim()], { kind: "mcp", pattern: name })
}

// ---------- 宿主规则 ----------

export interface HostRule {
  action: string
  resource: string
  effect: Effect
}

/** OpenCode 的 shell 规则以「 *」结尾时，也匹配不带参数的命令本身 */
function ruleMatches(rule: HostRule, action: string, resource: string): boolean {
  if (!glob(rule.action, action)) return false
  if (glob(rule.resource, resource)) return true
  return action === "shell" && rule.resource.endsWith(" *") && glob(rule.resource.slice(0, -2), resource)
}

/**
 * 在合并后的宿主规则里找每个资源最后匹配的一条。
 * 列表开头的 `* * allow` 是 OpenCode 内置的兜底策略，不算宿主有规则。
 * 多个资源时与 OpenCode 一致：任一 deny 即 deny，否则任一 ask 即 ask，否则 allow。
 */
export function hostMatch(rules: readonly HostRule[], action: string, resources: readonly string[]): { effect: Effect; rule: HostRule } | undefined {
  const own = rules[0]?.action === "*" && rules[0]?.resource === "*" && rules[0]?.effect === "allow" ? rules.slice(1) : rules
  const hits: HostRule[] = []
  for (const resource of resources.length ? resources : ["*"]) {
    const hit = own.findLast((r) => ruleMatches(r, action, resource))
    if (hit) hits.push(hit)
  }
  if (!hits.length) return undefined
  const pick = hits.find((r) => r.effect === "deny") ?? hits.find((r) => r.effect === "ask") ?? hits[0]
  return { effect: pick.effect, rule: pick }
}

// ---------- 合成 ----------

export interface Resolution {
  /** 最终档位；deny 表示宿主拒绝，插件不放宽 */
  tier: Tier | "deny"
  source: Source
  why: string
  /** 兜底改档的原因；目前只有方案 A：类 1 落到 pm 而案头离线，转人工 */
  fallback?: "class1-pm-offline"
}

/** 更省事的一档：human → pm → silent */
export function lighter(tier: Tier): Tier {
  return tier === "human" ? "pm" : "silent"
}

/**
 * 规格二的五条：
 * 1. 宿主 deny 一律生效；
 * 2. 用户在设置里显式改过的档位，优先于宿主的 ask（也优先于 allow）；
 * 3. 用户没改过时听宿主：allow 取比默认更省事的一档，ask 交给人；
 * 4. 宿主没有匹配规则，才用默认档位。
 * 通配 allow（如 shell * allow）按第 3 条处理，不当成用户点名允许。
 *
 * 方案 A 兜底：类 1 经宿主放行降到 pm、而案头不在线时，改为 human（用户显式设置的档位不受影响）。
 * 回退到方案 C（离线照旧放行）：调用方传 pmOnline: true 或去掉这段。
 */
export function resolve(input: {
  cls: ClassID
  user: Partial<Record<ClassID, Tier>>
  /** OpenCode 算出的结果（含已保存授权） */
  hostEffect: Effect
  /** 宿主配置里是否有规则匹配；没有规则但 OpenCode 仍判了 ask/deny（会话规则、已保存授权等）也算有 */
  hostMatched: boolean
  /** 案头是否在线；缺省按在线，不触发兜底 */
  pmOnline?: boolean
}): Resolution {
  const r = merge(input)
  if (r.tier === "pm" && input.cls === "1" && r.source !== "user" && input.pmOnline === false) {
    return { tier: "human", source: r.source, why: `${r.why}；案头离线，类 1 转人工`, fallback: "class1-pm-offline" }
  }
  return r
}

function merge(input: Parameters<typeof resolve>[0]): Resolution {
  const { cls, user, hostEffect } = input
  const fallback = DEFAULT_CLASSES[cls]
  if (hostEffect === "deny") return { tier: "deny", source: "host", why: "宿主规则拒绝" }
  const explicit = user[cls]
  if (explicit) return { tier: explicit, source: "user", why: `用户设置类 ${cls} 为 ${explicit}` }
  if (input.hostMatched || hostEffect !== "allow") {
    if (hostEffect === "ask") return { tier: "human", source: "host", why: "宿主规则要求询问" }
    const tier = lighter(fallback)
    return { tier, source: "host", why: `宿主规则放行，默认 ${fallback} 取更省事一档 ${tier}` }
  }
  return { tier: fallback, source: "default", why: `类 ${cls} 默认 ${fallback}` }
}

/** 读设置里的 permissionClasses：只保留合法的显式项 */
export function parseClasses(raw: unknown): Partial<Record<ClassID, Tier>> {
  const out: Partial<Record<ClassID, Tier>> = {}
  if (!raw || typeof raw !== "object") return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if ((CLASS_IDS as readonly string[]).includes(k) && (TIERS as readonly string[]).includes(String(v))) out[k as ClassID] = v as Tier
  }
  return out
}

/** 弹窗正文：只列动作与命令或路径，最多四行，每行最多 80 字（助手再按窗口宽度在中间截断，不折行） */
export function promptBody(what: readonly string[], lang: "zh" | "en" = "zh"): string {
  const cut = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s)
  const more = (n: number) => (lang === "en" ? `…and ${n} more` : `…另 ${n} 项`)
  const lines = what.length > 4 ? [...what.slice(0, 3).map(cut), more(what.length - 3)] : what.map(cut)
  return lines.join("\n")
}

/** 「总是允许」存下的授权是否覆盖这次请求 */
export function covers(grant: { kind: string; pattern: string }, wanted: { kind: string; pattern: string }): boolean {
  if (grant.kind !== wanted.kind) return false
  if (grant.pattern === wanted.pattern) return true
  // 目录授权覆盖其下的子目录：/tmp/* 覆盖 /tmp/x/*
  if (grant.kind === "write-external" && grant.pattern.endsWith("/*")) return under(wanted.pattern.replace(/\/\*$/, ""), grant.pattern.slice(0, -2))
  return false
}
