import { expect, test } from "bun:test"
import { cp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DoneResult, OpenResult, POINTER_LINE, RoundId } from "@iter8/protocol"
import type { Socket } from "bun"
import type { Browser, Locator, Page } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import { SCRATCH_ROOT, type Scratch, scratchDir } from "../../rig/scratch"
import type { RunningService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { expectLocatable, pickAndNote, sendRound, showRound, startBuiltService } from "./steps"

const FORWARD_ADDRESS = "127.0.0.2"
const SERVICE_ADDRESS = "127.0.0.1"
const FORWARD_READY_MS = 10_000
const UI_TIMEOUT_MS = 10_000

const HEADING_BEFORE = "Spring menu"
const HEADING_AFTER = "Autumn menu"
const BUTTON_BEFORE = "Order now"
const BUTTON_AFTER = "Reserve a table"

const mock = (heading: string, button: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>mock</title></head>
<body>
  <main>
    <h1>${heading}</h1>
    <button type="button">${button}</button>
  </main>
</body>
</html>
`

function bindFailure(): string | null {
  try {
    Bun.listen({ hostname: FORWARD_ADDRESS, port: 0, socket: { data() {} } }).stop(true)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const unbindable = bindFailure()
if (unbindable !== null) {
  console.info(
    `skipping the forwarded-port scenarios: ${FORWARD_ADDRESS} cannot be bound (${unbindable}); they need Linux's whole 127/8 loopback`,
  )
}

type Forward = { via: "ssh" | "tcp"; close(): Promise<void> }

async function canConnect(port: number): Promise<true | null> {
  try {
    const socket = await Bun.connect({ hostname: FORWARD_ADDRESS, port, socket: { data() {} } })
    socket.end()
    return true
  } catch {
    return null
  }
}

async function sshLogsIn(options: string[]): Promise<boolean> {
  try {
    const probe = Bun.spawn(["ssh", ...options, "localhost", "true"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    return (await probe.exited) === 0
  } catch {
    return false
  }
}

function sshForward(listenPort: number, targetPort: number, options: string[]) {
  const child = Bun.spawn(
    [
      "ssh",
      "-N",
      ...options,
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `${FORWARD_ADDRESS}:${listenPort}:${SERVICE_ADDRESS}:${targetPort}`,
      "localhost",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  )
  const stderr = new Response(child.stderr).text()
  return {
    via: "ssh" as const,
    failure: async () =>
      child.exitCode === null && child.signalCode === null
        ? null
        : `ssh -N exited (${child.exitCode ?? child.signalCode}): ${await stderr}`,
    close: async () => {
      child.kill("SIGTERM")
      await child.exited
    },
  }
}

type End = { socket: Socket<Link> | null; backlog: Uint8Array[]; ending: boolean }
type Link = { self: End; peer: End }

// Bun sockets do not buffer: a short write leaves the rest for the next drain.
function flush(end: End): void {
  const { socket } = end
  if (socket === null) return
  for (let chunk = end.backlog[0]; chunk !== undefined; chunk = end.backlog[0]) {
    const written = socket.write(chunk)
    if (written < chunk.byteLength) {
      end.backlog[0] = chunk.subarray(Math.max(written, 0))
      return
    }
    end.backlog.shift()
  }
  if (end.ending) socket.end()
}

function tcpForward(listenPort: number, targetPort: number) {
  const open = new Set<Socket<Link>>()
  const finish = (end: End) => {
    end.ending = true
    flush(end)
  }
  const handlers = {
    data(socket: Socket<Link>, chunk: Uint8Array) {
      socket.data.peer.backlog.push(new Uint8Array(chunk))
      flush(socket.data.peer)
    },
    drain(socket: Socket<Link>) {
      flush(socket.data.self)
    },
    close(socket: Socket<Link>) {
      open.delete(socket)
      finish(socket.data.peer)
    },
    error(socket: Socket<Link>) {
      socket.end()
    },
  }
  const listener = Bun.listen<Link>({
    hostname: FORWARD_ADDRESS,
    port: listenPort,
    socket: {
      ...handlers,
      open(client) {
        const clientEnd: End = { socket: client, backlog: [], ending: false }
        const upstreamEnd: End = { socket: null, backlog: [], ending: false }
        client.data = { self: clientEnd, peer: upstreamEnd }
        open.add(client)
        Bun.connect<Link>({
          hostname: SERVICE_ADDRESS,
          port: targetPort,
          data: { self: upstreamEnd, peer: clientEnd },
          socket: {
            ...handlers,
            open(upstream) {
              upstreamEnd.socket = upstream
              open.add(upstream)
              flush(upstreamEnd)
            },
            connectError() {
              client.end()
            },
          },
        }).catch(() => client.end())
      },
    },
  })
  return {
    via: "tcp" as const,
    failure: async () => null,
    close: async () => {
      listener.stop(true)
      for (const socket of open) socket.end()
      open.clear()
    },
  }
}

async function startForward(
  listenPort: number,
  targetPort: number,
  scratch: Scratch,
): Promise<Forward> {
  // A shared ControlMaster connection would own the forward, so killing our ssh would not close it.
  const options = [
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=3",
    "-o",
    `UserKnownHostsFile=${join(scratch.path, "known_hosts")}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
  ]
  const forward = (await sshLogsIn(options))
    ? sshForward(listenPort, targetPort, options)
    : tcpForward(listenPort, targetPort)
  try {
    await waitFor(
      `the ${forward.via} forward on ${FORWARD_ADDRESS}:${listenPort} to accept connections`,
      async () => {
        const failed = await forward.failure()
        if (failed !== null) throw new Error(failed)
        return canConnect(listenPort)
      },
      { timeoutMs: FORWARD_READY_MS },
    )
  } catch (error) {
    await forward.close()
    throw error
  }
  console.info(
    `forwarding ${FORWARD_ADDRESS}:${listenPort} to ${SERVICE_ADDRESS}:${targetPort} via ${forward.via}`,
  )
  return { via: forward.via, close: forward.close }
}

async function teardown(steps: (() => Promise<unknown> | undefined)[]): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "teardown failed")
}

const portOf = (url: string) => Number(new URL(url).port)

const launchThroughForward = (): Promise<Browser> =>
  launchChromium({ args: [`--host-resolver-rules=MAP *.localhost ${FORWARD_ADDRESS}`] })

const dock = (page: Page) => page.getByRole("toolbar", { name: "iter8 annotation tools" })

async function copyMock(prefix: string): Promise<Scratch> {
  const copy = await scratchDir(`${SCRATCH_ROOT}${prefix}`)
  await cp(fixtureDir("static"), copy.path, { recursive: true })
  await writeFile(join(copy.path, "index.html"), mock(HEADING_BEFORE, BUTTON_BEFORE))
  return copy
}

async function visible(locator: Locator): Promise<true | null> {
  return (await locator.count()) === 1 && (await locator.isVisible()) ? true : null
}

test.skipIf(unbindable !== null)(
  "a mock reached through a forwarded port takes a round, and the session's edits and done marks show on the open page",
  async () => {
    const services: RunningService[] = []
    const sessions: AgentSession[] = []
    const disposers: (() => Promise<unknown>)[] = []
    try {
      const service = await startBuiltService()
      services.push(service)

      const copy = await copyMock("e2e-forward-mock-")
      disposers.push(copy.dispose)
      const sshScratch = await scratchDir(`${SCRATCH_ROOT}e2e-ssh-`)
      disposers.push(sshScratch.dispose)

      const session = await startAgentSession(service)
      sessions.push(session)
      const open = (await session.run(["open", copy.path, "--json"])).json(OpenResult)
      const pagePort = portOf(open.url)
      expect(portOf(open.landingUrl)).toBe(pagePort)

      const forward = await startForward(pagePort, pagePort, sshScratch)
      let forwardOpen = true
      disposers.push(async () => {
        if (forwardOpen) await forward.close()
      })

      const browser = await launchThroughForward()
      disposers.push(() => browser.close())
      const { page, close } = await newPage(browser)
      disposers.push(close)

      await page.goto(open.landingUrl)
      await waitFor(
        "the landing page to confirm this machine and lead to the page",
        async () => (page.url() === open.url ? true : null),
        { timeoutMs: UI_TIMEOUT_MS },
      )
      const heading = page.getByRole("heading", { name: HEADING_BEFORE })
      const button = page.getByRole("button", { name: BUTTON_BEFORE })
      await waitFor("the mock heading", () => visible(heading), { timeoutMs: UI_TIMEOUT_MS })
      await waitFor("the overlay dock", () => visible(dock(page)), { timeoutMs: UI_TIMEOUT_MS })

      const planned = [
        { target: heading, intent: "change", body: `Change the heading to ${HEADING_AFTER}` },
        { target: button, intent: "change", body: `Change the button label to ${BUTTON_AFTER}` },
      ] as const
      const wakes = () =>
        session.events.flatMap((event) => (event.event === "woken" ? [event] : []))
      const wokenBefore = wakes().length
      for (const note of planned) await pickAndNote(page, note.target, note)
      await sendRound(page)

      const woken = await waitFor(
        "the owning session to be woken",
        async () => wakes()[wokenBefore] ?? null,
        { timeoutMs: 15_000 },
      )
      const pointers = woken.lines.map((line) => POINTER_LINE.exec(line)?.groups)
      expect(pointers).toHaveLength(1)
      const pointer = pointers[0]
      expect(pointer?.count).toBe(String(planned.length))
      const round = RoundId.parse(pointer?.id)

      const shown = await showRound(session, round)
      expect(shown.round.id).toBe(round)
      expect(shown.notes.map((note) => note.authored.body).sort()).toEqual(
        planned.map((note) => note.body).sort(),
      )
      for (const note of shown.notes) {
        const expected = planned.find((candidate) => candidate.body === note.authored.body)
        const target = note.authored.target
        if (target.kind !== "element" || expected === undefined) {
          throw new Error(`note "${note.authored.body}" was not stored as an element note`)
        }
        await expectLocatable(page, target.anchor, expected.target)
      }

      await writeFile(join(copy.path, "index.html"), mock(HEADING_AFTER, BUTTON_AFTER))
      for (const note of shown.notes) {
        const done = (await session.run(["done", note.authored.id, "--json"])).json(DoneResult)
        expect(done.noteId).toBe(note.authored.id)
        expect(done.resolution.status).toBe("done")
      }

      await waitFor(
        "the open page to show the session's edits on its own",
        async () =>
          (await visible(page.getByRole("heading", { name: HEADING_AFTER }))) &&
          visible(page.getByRole("button", { name: BUTTON_AFTER })),
        { timeoutMs: UI_TIMEOUT_MS },
      )

      await waitFor("the overlay dock after the page changed", () => visible(dock(page)), {
        timeoutMs: UI_TIMEOUT_MS,
      })
      const sheet = page.getByRole("complementary", { name: "Round sheet" })
      if ((await sheet.count()) === 0) {
        await page.getByRole("button", { name: "Open round sheet" }).click()
      }
      await sheet.getByRole("tab", { name: /^History/ }).click()
      const sent = sheet.getByRole("region", { name: `Round ${round.slice(1)}`, exact: true })
      const doneChips = sent.getByRole("status", { name: "done", exact: true })
      await waitFor(
        "the round sheet to show every note of the round as done",
        async () => ((await doneChips.count()) === planned.length ? true : null),
        { timeoutMs: UI_TIMEOUT_MS },
      )

      forwardOpen = false
      await forward.close()
      await expect(page.goto(open.url)).rejects.toThrow(/ERR_CONNECTION_REFUSED/)
    } finally {
      await teardown([
        ...sessions.map((session) => () => session.exit()),
        ...disposers.reverse(),
        ...services.map((service) => () => service.stop()),
      ])
    }
  },
  60_000,
)

test.skipIf(unbindable !== null)(
  "a landing link whose forwarded port reaches another machine's iter8 says that port is not the expected machine",
  async () => {
    const services: RunningService[] = []
    const sessions: AgentSession[] = []
    const disposers: (() => Promise<unknown>)[] = []
    try {
      const a = await startBuiltService()
      services.push(a)
      const b = await startBuiltService()
      services.push(b)
      expect(a.machineId).not.toBe(b.machineId)

      const copy = await copyMock("e2e-wrong-machine-")
      disposers.push(copy.dispose)
      const sshScratch = await scratchDir(`${SCRATCH_ROOT}e2e-ssh-`)
      disposers.push(sshScratch.dispose)

      const session = await startAgentSession(a)
      sessions.push(session)
      const open = (await session.run(["open", copy.path, "--json"])).json(OpenResult)
      const landingPort = portOf(open.landingUrl)
      const otherPort = b.poolPorts[0]
      if (otherPort === undefined) throw new Error("the second service has no pool port")

      const forward = await startForward(landingPort, otherPort, sshScratch)
      disposers.push(() => forward.close())

      const browser = await launchThroughForward()
      disposers.push(() => browser.close())
      const { page, close } = await newPage(browser)
      disposers.push(close)

      await page.goto(open.landingUrl)
      expect(new URL(page.url()).hash).toBe(new URL(open.landingUrl).hash)
      const message = page.getByText(
        `Port ${landingPort} on this computer is not the iter8 service that opened this page`,
      )
      await waitFor("the wrong-machine message", () => visible(message), {
        timeoutMs: UI_TIMEOUT_MS,
      })
      expect(page.url()).toBe(open.landingUrl)
      expect(await dock(page).count()).toBe(0)
    } finally {
      await teardown([
        ...sessions.map((session) => () => session.exit()),
        ...disposers.reverse(),
        ...services.map((service) => () => service.stop()),
      ])
    }
  },
  60_000,
)
