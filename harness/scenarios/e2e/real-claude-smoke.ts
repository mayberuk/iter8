import { cp, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { OpenResult, RoundsResult } from "@iter8/protocol"
import { z } from "zod"
import { launchChromium, newPage } from "../../rig/browser"
import { childEnv } from "../../rig/cli"
import { fixtureDir } from "../../rig/fixtures"
import { SCRATCH_ROOT, scratchDir } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { pickAndNote, sendRound, startBuiltService } from "./steps"

const REPO = join(import.meta.dir, "..", "..", "..")
const pluginOverride = process.env.ITER8_CC_PLUGIN_DIR
const PLUGIN_DIR = resolve(
  pluginOverride !== undefined && pluginOverride !== ""
    ? pluginOverride
    : join(REPO, "..", "cc-plugins", "plugins", "iter8"),
)

const TURN_TIMEOUT_MS = 180_000
const WAKE_WINDOW_MS = 120_000
const WORK_TIMEOUT_MS = 300_000
const STOP_STEP_MS = 10_000
const EVENTS_REPORTED = 10
const EVENT_CHARS_REPORTED = 1500

const StreamEvent = z.object({
  type: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
})

const IterNotFound = /iter8: (?:command )?not found|command not found: iter8/

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function openFromReply(reply: string): OpenResult {
  const start = reply.indexOf("{")
  const end = reply.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error(`the first reply holds no JSON object: ${reply}`)
  return OpenResult.parse(JSON.parse(reply.slice(start, end + 1)))
}

async function main(): Promise<number> {
  const claudePath = Bun.which("claude")
  if (claudePath === null) {
    console.error("claude is not on PATH")
    return 1
  }
  for (const required of [
    join(PLUGIN_DIR, "hooks", "hooks.json"),
    join(PLUGIN_DIR, "bin", "iter8"),
  ]) {
    if (!(await Bun.file(required).exists())) {
      console.error(
        `the iter8 plugin directory is missing ${required}; set ITER8_CC_PLUGIN_DIR to the plugin`,
      )
      return 1
    }
  }

  const lines: string[] = []
  const cleanups: (() => Promise<unknown>)[] = []
  const transcript = await scratchDir(`${SCRATCH_ROOT}e2e-smoke-transcript-`)
  let code = 0
  try {
    const service = await startBuiltService()
    cleanups.push(() => service.stop())
    const binary = service.env.command?.[0]
    if (binary === undefined) throw new Error("the service has no CLI command to hand the plugin")

    const copy = await scratchDir(`${SCRATCH_ROOT}e2e-smoke-folder-`)
    cleanups.push(copy.dispose)
    await cp(fixtureDir("static"), copy.path, { recursive: true })
    const pluginData = await scratchDir(`${SCRATCH_ROOT}e2e-smoke-plugin-data-`)
    cleanups.push(pluginData.dispose)

    const env = childEnv({
      ...service.env,
      vars: {
        ...service.env.vars,
        ITER8_BIN: binary,
        ITER8_NO_INSTALL: "1",
        ITER8_PLUGIN_DATA: pluginData.path,
      },
    })
    delete env.CLAUDE_ENV_FILE

    const child = Bun.spawn(
      [
        claudePath,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--plugin-dir",
        PLUGIN_DIR,
        "--setting-sources",
        "project,local",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        "Bash(iter8 *),Read,Edit,Skill",
      ],
      {
        cwd: copy.path,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: Bun.file(join(transcript.path, "stderr.log")),
      },
    )
    const exited = () => child.exitCode !== null || child.signalCode !== null

    const stream = Bun.file(join(transcript.path, "stream.jsonl")).writer()
    const results: z.infer<typeof StreamEvent>[] = []
    let iter8Missing = false
    const record = (line: string) => {
      lines.push(line)
      stream.write(`${line}\n`)
      stream.flush()
      let parsed: z.ZodSafeParseResult<z.infer<typeof StreamEvent>>
      try {
        parsed = StreamEvent.safeParse(JSON.parse(line))
      } catch {
        return
      }
      if (!parsed.success) return
      if (parsed.data.type === "result") results.push(parsed.data)
      if (parsed.data.type === "user" && IterNotFound.test(line)) iter8Missing = true
    }
    const reading = (async () => {
      const decoder = new TextDecoder()
      let buffered = ""
      for await (const chunk of child.stdout) {
        buffered += decoder.decode(chunk, { stream: true })
        const complete = buffered.split("\n")
        buffered = complete.pop() ?? ""
        for (const line of complete) if (line !== "") record(line)
      }
    })()

    cleanups.push(async () => {
      for (const step of ["close stdin", "SIGTERM", "SIGKILL"] as const) {
        if (step === "close stdin") child.stdin.end()
        else child.kill(step)
        try {
          await waitFor("claude to exit", async () => (exited() ? true : null), {
            timeoutMs: STOP_STEP_MS,
          })
          break
        } catch {}
      }
      await child.exited
      await reading
      await stream.end()
    })

    const assertHealthy = () => {
      if (iter8Missing) {
        throw new Error(
          "bare `iter8` was not found on the Bash tool's PATH: Claude Code did not add the plugin's bin/",
        )
      }
      if (results.some((result) => result.is_error === true)) {
        throw new Error("claude ended a turn with an error result")
      }
      if (exited()) throw new Error(`claude exited (${child.exitCode ?? child.signalCode})`)
    }

    const send = (text: string) => {
      const message = { role: "user", content: [{ type: "text", text }] }
      child.stdin.write(`${JSON.stringify({ type: "user", message })}\n`)
      child.stdin.flush()
    }

    const finishedTurn = (count: number) =>
      waitFor(
        `claude to finish turn ${count}`,
        async () => {
          const result = results[count - 1]
          if (result !== undefined) return result
          assertHealthy()
          return null
        },
        { timeoutMs: TURN_TIMEOUT_MS, everyMs: 250 },
      )

    send(
      `Open the folder ${copy.path} with iter8: run \`iter8 open ${copy.path} --json\` in Bash. Reply with only the JSON it prints.`,
    )
    const open = openFromReply((await finishedTurn(1)).result ?? "")
    const pairing = open.page.pairing
    if (pairing === null) {
      throw new Error(
        "the opened page has no paired session: the plugin's hooks did not pair claude",
      )
    }

    const browser = await launchChromium()
    cleanups.push(() => browser.close())
    const { page } = await newPage(browser)
    await page.goto(open.url)

    const heading = `Smoke-${crypto.randomUUID().slice(0, 8)}`
    await pickAndNote(page, page.locator("header h1"), {
      intent: "change",
      body: `Change the heading to ${heading}`,
    })
    await sendRound(page)

    const summary = async () => {
      const run = await service.cli(["rounds", "--json", "--owner", pairing.owner])
      return run.json(RoundsResult).rounds[0] ?? null
    }
    const sent = await waitFor(
      "the sent round to be listed for the paired session",
      async () => {
        assertHealthy()
        return await summary()
      },
      { timeoutMs: STOP_STEP_MS },
    )

    const wakeDeadline = performance.now() + WAKE_WINDOW_MS
    const delivered = await waitFor(
      "the round to be claimed by wake",
      async () => {
        assertHealthy()
        if ((await summary())?.stage === "claimed") return "wake" as const
        return performance.now() >= wakeDeadline ? ("pull" as const) : null
      },
      { timeoutMs: WAKE_WINDOW_MS + STOP_STEP_MS, everyMs: 1000 },
    )
    if (delivered === "pull") send("I've left comments on the page")

    const headingRead = new RegExp(`<h1[^>]*>\\s*${heading}\\s*</h1>`)
    await waitFor(
      "every note to be done and the file to read the new heading",
      async () => {
        assertHealthy()
        const round = await summary()
        const file = await readFile(join(copy.path, "index.html"), "utf8")
        const finished =
          round !== null && round.noteCount > 0 && round.doneCount === round.noteCount
        return finished && headingRead.test(file) ? true : null
      },
      { timeoutMs: WORK_TIMEOUT_MS, everyMs: 1000 },
    )
    console.log(`round ${sent.id} was delivered by ${delivered}`)
  } catch (error) {
    code = 1
    console.error(`smoke failed: ${describe(error)}`)
    if (lines.length > 0) {
      console.error(`last stream-json events:`)
      for (const line of lines.slice(-EVENTS_REPORTED)) {
        console.error(line.slice(0, EVENT_CHARS_REPORTED))
      }
    }
  } finally {
    for (const step of cleanups.reverse()) {
      try {
        await step()
      } catch (error) {
        code = 1
        console.error(`cleanup failed: ${describe(error)}`)
      }
    }
  }
  console.log(`transcript kept in ${transcript.path}`)
  return code
}

process.exit(await main())
