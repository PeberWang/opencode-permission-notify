import { Plugin } from "@opencode/plugin"
import { writeFileSync } from "node:fs"

// 探针：验证 evaluate 钩子能否长时间等待、改判 deny 时理由是否回到模型、命令能否用 synthetic 回话。
const OUT = new URL("../probe.log", import.meta.url)
const log = (kind: string, value: unknown) =>
  writeFileSync(OUT, `${new Date().toISOString()} ${kind} ${JSON.stringify(value)}\n`, { flag: "a" })

export default Plugin.define({
  id: "permission-probe",
  async setup(ctx) {
    log("setup", { dir: (ctx as any).location?.directory })
    await ctx.permission.hook("evaluate", async (event: any) => {
      if (event.action !== "external_directory") return
      const t0 = Date.now()
      if (String(event.resources[0]).startsWith("/etc")) {
        await new Promise((r) => setTimeout(r, 15_000))
        event.effect = "allow"
      } else {
        event.effect = "deny"
        event.message = "探针拒绝：用户在授权弹窗里拒绝了这次写入"
      }
      log("evaluate", { resources: event.resources, effect: event.effect, waited: Date.now() - t0 })
    })
    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "probe-perm",
        description: "探针命令",
        execute: async ({ sessionID, prompt }: any) => {
          log("command", { sessionID, text: prompt?.text })
          await ctx.session.synthetic({ sessionID, text: `探针命令收到：${prompt?.text ?? ""}` } as any)
        },
      })
    })
  },
})
