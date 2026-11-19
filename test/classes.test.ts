// 六类三档单测：npm test
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  classify,
  covers,
  head,
  hostMatch,
  parseClasses,
  promptBody,
  resolve,
  writeTargets,
  type Context,
  type Evaluation,
  type HostRule,
} from "../src/classes.ts"

const home = "/Users/u"
const project = "/Users/u/code/app"
const ctx = (call?: Context["call"]): Context => ({ project, home, call })
const ev = (action: string, resources: string[], effect: Evaluation["effect"] = "allow", metadata?: any): Evaluation => ({ action, resources, effect, metadata })
const cls = (e: Evaluation, c: Context) => classify(e, c).cls

test("项目外目录：读归类 2，写归类 1，凭证读归类 1，判不清归类 1", () => {
  assert.equal(cls(ev("external_directory", ["/etc/*"], "ask"), ctx({ tool: "read", input: { path: "/etc/hosts" } })), "2")
  assert.equal(cls(ev("external_directory", ["/Users/u/Desktop/x/*"], "ask"), ctx({ tool: "grep", input: { pattern: "a" } })), "2")
  assert.equal(cls(ev("external_directory", ["/Users/u/.ssh/*"], "ask"), ctx({ tool: "read", input: { path: "/Users/u/.ssh/config" } })), "1")
  assert.equal(cls(ev("external_directory", ["/Users/u/.openclaw/workspace/*"], "ask"), ctx({ tool: "read", input: { path: "/Users/u/.openclaw/workspace/secrets.json" } })), "1")
  assert.equal(cls(ev("external_directory", ["/Users/u/.config/opencode/*"]), ctx({ tool: "read", input: { path: "/Users/u/.config/opencode/AGENTS.md" } })), "6")
  const w = classify(ev("external_directory", ["/tmp/*"], "ask"), ctx({ tool: "write", input: { path: "/tmp/a.txt" } }))
  assert.equal(w.cls, "1")
  assert.deepEqual(w.what, ["write /tmp/a.txt"])
  assert.equal(cls(ev("external_directory", ["/opt/*"], "ask"), ctx({ tool: "shell", input: { command: "ls /opt" } })), "2")
  assert.equal(cls(ev("external_directory", ["/opt/*"], "ask"), ctx({ tool: "shell", input: { command: "rm -rf /opt/x" } })), "1")
  assert.equal(cls(ev("external_directory", ["/opt/*"], "ask"), ctx()), "1")
  assert.equal(cls(ev("external_directory", ["/opt/*"], "ask"), ctx({ tool: "webfetch" })), "1")
})

test("项目内：读归类 5，列目录归类 6，写入归类 4，删除与 .env 归类 1", () => {
  assert.equal(cls(ev("read", ["src/a.ts"]), ctx()), "5")
  assert.equal(cls(ev("grep", ["TODO"]), ctx()), "5")
  assert.equal(cls(ev("glob", ["**/*.ts"]), ctx()), "6")
  assert.equal(cls(ev("read", ["/etc/hosts"]), ctx()), "2")
  assert.equal(cls(ev("edit", ["src/a.ts"], "allow", { files: [{ file: "src/a.ts", status: "modified" }] }), ctx()), "4")
  assert.equal(cls(ev("edit", ["new.md"], "allow", { files: [{ file: "new.md", status: "added" }] }), ctx()), "4")
  assert.equal(cls(ev("edit", ["src/a.ts"], "allow", { files: [{ file: "src/a.ts", status: "deleted" }] }), ctx()), "1")
  assert.equal(cls(ev("edit", ["/tmp/a.txt"]), ctx()), "1")
  assert.equal(cls(ev("read", [".env"], "ask"), ctx()), "1")
  assert.equal(cls(ev("read", [".env.example"]), ctx()), "5")
})

test("shell：不可逆、提权、对外发布、写到项目外归类 1，其余归类 3", () => {
  const s = (cmd: string) => cls(ev("shell", [cmd]), ctx())
  assert.equal(s("pytest -q"), "3")
  assert.equal(s("git status --short"), "3")
  assert.equal(s("rm -rf build"), "1")
  assert.equal(s("FOO=1 sudo ls"), "1")
  assert.equal(s("git reset --hard HEAD~1"), "1")
  assert.equal(s("git push origin main"), "1")
  assert.equal(s("npm publish"), "1")
  assert.equal(s("curl -X POST https://x.io -d a=1"), "1")
  assert.equal(s("curl -s https://x.io"), "3")
  assert.equal(s("gh pr create --fill"), "1")
  assert.equal(s("echo hi > /tmp/out.txt"), "1")
  assert.equal(s("make 2>&1 | tee /tmp/build.log"), "1")
  assert.equal(s("echo hi > out.txt"), "3")
  assert.equal(s("cmd > /dev/null 2>&1"), "3")
  assert.equal(s("echo x > /Users/u/.config/opencode/memory/a.md"), "3")
  assert.equal(s(`python3 -c "open('/tmp/x','w').write('z')"`), "3") // 已知边界：解释器内部写文件看不见
  assert.equal(s("trash old.txt"), "3") // 可恢复的删除
})

test("查询类与 MCP：查询归类 6，发送、删除、写入外部系统归类 1", () => {
  assert.equal(cls(ev("webfetch", ["https://a.b"]), ctx()), "6")
  assert.equal(cls(ev("question", ["*"]), ctx()), "6")
  assert.equal(cls(ev("gmail_search_emails", ["*"]), ctx()), "6")
  assert.equal(cls(ev("notion_API-retrieve-a-page", ["*"]), ctx()), "6")
  assert.equal(cls(ev("gmail_send_email", ["*"]), ctx()), "1")
  assert.equal(cls(ev("github_create_pull_request", ["*"]), ctx()), "1")
  assert.equal(cls(ev("zotero_zotero_delete_item", ["*"]), ctx()), "1")
  assert.equal(cls(ev("zotero_zotero_add_item", ["*"]), ctx()), "1")
  assert.equal(cls(ev("deploy", ["prod"], "ask"), ctx()), "1")
})

const base: HostRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
]

test("宿主规则匹配：内置兜底不算，后匹配者优先，「 *」也匹配无参数命令", () => {
  assert.equal(hostMatch(base, "shell", ["ls"]), undefined)
  const rules: HostRule[] = [...base, { action: "shell", resource: "*", effect: "allow" }, { action: "shell", resource: "rm *", effect: "ask" }]
  assert.deepEqual(hostMatch(rules, "shell", ["ls -la"])?.effect, "allow")
  assert.deepEqual(hostMatch(rules, "shell", ["rm -rf x"])?.effect, "ask")
  assert.deepEqual(hostMatch(rules, "shell", ["rm"])?.effect, "ask")
  assert.deepEqual(hostMatch(rules, "shell", ["ls", "rm x"])?.effect, "ask")
  assert.equal(hostMatch(base, "read", ["a/.env"])?.effect, "ask")
  assert.deepEqual(hostMatch([...base, { action: "zotero_*", resource: "*", effect: "allow" }], "zotero_zotero_add_item", ["*"])?.effect, "allow")
})

test("合成五条：deny 不放宽，用户显式优先，宿主 allow 取更省事一档、ask 交给人，无规则用默认", () => {
  // 1. 宿主 deny：任何用户设置都放不开
  assert.equal(resolve({ cls: "3", user: { "3": "silent" }, hostEffect: "deny", hostMatched: true }).tier, "deny")
  // 2. 用户显式设置优先于宿主 ask
  assert.deepEqual(resolve({ cls: "3", user: { "3": "silent" }, hostEffect: "ask", hostMatched: true }), { tier: "silent", source: "user", why: "用户设置类 3 为 silent" })
  // 3. 宿主 allow 取更省事一档，ask 交给人
  assert.equal(resolve({ cls: "3", user: {}, hostEffect: "allow", hostMatched: true }).tier, "silent")
  assert.equal(resolve({ cls: "1", user: {}, hostEffect: "allow", hostMatched: true }).tier, "pm")
  assert.equal(resolve({ cls: "5", user: {}, hostEffect: "allow", hostMatched: true }).tier, "silent")
  assert.equal(resolve({ cls: "5", user: {}, hostEffect: "ask", hostMatched: true }).tier, "human")
  assert.equal(resolve({ cls: "5", user: {}, hostEffect: "ask", hostMatched: true }).source, "host")
  // 没有配置规则，但 OpenCode 仍判了 ask（会话规则、已保存授权等）：也听宿主
  assert.equal(resolve({ cls: "4", user: {}, hostEffect: "ask", hostMatched: false }).tier, "human")
  // 4. 宿主无匹配：默认档位
  for (const [c, t] of [["1", "human"], ["2", "pm"], ["3", "pm"], ["4", "pm"], ["5", "silent"], ["6", "silent"]] as const) {
    assert.deepEqual(resolve({ cls: c, user: {}, hostEffect: "allow", hostMatched: false }).tier, t)
    assert.deepEqual(resolve({ cls: c, user: {}, hostEffect: "allow", hostMatched: false }).source, "default")
  }
})

test("方案 A：类 1 经通配 allow 降到 pm、案头离线时转人工；其余类与在线时不变；用户设置优先", () => {
  const wildcard: HostRule[] = [...base, { action: "shell", resource: "*", effect: "allow" }]
  const push = classify(ev("shell", ["git push origin main"]), ctx())
  const match = hostMatch(wildcard, "shell", ["git push origin main"])
  assert.equal(push.cls, "1")
  assert.deepEqual(match?.rule, { action: "shell", resource: "*", effect: "allow" })

  // 通配 allow 下的类 1，离线 → human，并标出兜底原因
  const offline = resolve({ cls: push.cls, user: {}, hostEffect: "allow", hostMatched: !!match, pmOnline: false })
  assert.equal(offline.tier, "human")
  assert.equal(offline.source, "host")
  assert.equal(offline.fallback, "class1-pm-offline")
  assert.match(offline.why, /案头离线，类 1 转人工/)

  // 在线 → 仍是 pm，没有兜底标记
  const online = resolve({ cls: "1", user: {}, hostEffect: "allow", hostMatched: true, pmOnline: true })
  assert.deepEqual([online.tier, online.fallback], ["pm", undefined])

  // 类 2、3、4 落到 pm 时离线照旧（pm，交给调用方按 pm-offline 放行）
  for (const c of ["2", "3", "4"] as const) {
    const r = resolve({ cls: c, user: {}, hostEffect: "allow", hostMatched: false, pmOnline: false })
    assert.deepEqual([r.tier, r.source, r.fallback], ["pm", "default", undefined])
  }
  const shell3 = resolve({ cls: "3", user: { "3": "pm" }, hostEffect: "allow", hostMatched: true, pmOnline: false })
  assert.deepEqual([shell3.tier, shell3.fallback], ["pm", undefined])

  // 用户显式把类 1 设为 silent（或 pm）：以用户为准，不兜底，来源 user
  const silent = resolve({ cls: "1", user: { "1": "silent" }, hostEffect: "allow", hostMatched: true, pmOnline: false })
  assert.deepEqual([silent.tier, silent.source, silent.fallback], ["silent", "user", undefined])
  const pm = resolve({ cls: "1", user: { "1": "pm" }, hostEffect: "allow", hostMatched: true, pmOnline: false })
  assert.deepEqual([pm.tier, pm.source, pm.fallback], ["pm", "user", undefined])

  // 兜底不放宽 deny
  assert.equal(resolve({ cls: "1", user: {}, hostEffect: "deny", hostMatched: true, pmOnline: false }).tier, "deny")
})

test("设置解析只收合法项；弹窗正文不超过四行", () => {
  assert.deepEqual(parseClasses({ "1": "human", "3": "silent", "7": "pm", "2": "maybe" }), { "1": "human", "3": "silent" })
  assert.deepEqual(parseClasses(undefined), {})
  assert.equal(promptBody(["a", "b"]), "a\nb")
  assert.equal(promptBody(["1", "2", "3", "4", "5", "6"]).split("\n").length, 4)
  assert.equal(promptBody(["1", "2", "3", "4"]).split("\n").length, 4)
  assert.equal(promptBody(["1", "2", "3", "4", "5", "6"]).split("\n")[3], "…另 3 项")
  assert.equal(promptBody(["1", "2", "3", "4", "5", "6"], "en").split("\n")[3], "…and 3 more")
})

test("命令解析与授权覆盖", () => {
  assert.equal(head("FOO=1 env nohup git push"), "git push")
  assert.deepEqual(writeTargets("echo a > /tmp/x && cat b | tee -a ~/y"), ["/tmp/x", "~/y"])
  assert.ok(covers({ kind: "write-external", pattern: "/tmp/*" }, { kind: "write-external", pattern: "/tmp/x/*" }))
  assert.ok(!covers({ kind: "write-external", pattern: "/tmp/x/*" }, { kind: "write-external", pattern: "/tmp/*" }))
  assert.ok(!covers({ kind: "shell", pattern: "git push origin main" }, { kind: "shell", pattern: "git push origin dev" }))
})
