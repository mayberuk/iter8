import { afterAll, beforeAll, expect, test } from "bun:test"
import { AgentNoteResult, ServiceStatus } from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { type RunningFixture, startFixture } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { openThroughProxy, type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { type Iter8Probe, PROBE_GLOBAL } from "../../stubs/probe-overlay"

let browser: Browser
let bundle: Scratch
let fixture: RunningFixture
let service: RunningService
let session: AgentSession

beforeAll(async () => {
  bundle = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url)),
  )
  fixture = await startFixture("static")
  service = await startService({ overlayDir: bundle.path })
  session = await startAgentSession(service)
  browser = await launchChromium()
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await session?.exit()
  await service?.stop()
  await fixture?.stop()
  await bundle?.dispose()
})

const snapshot = (page: Page) =>
  page.evaluate((global) => {
    const probe = Reflect.get(window, global) as Iter8Probe | undefined
    if (!probe) return null
    const { hello, connected, messages } = probe
    return { hello, connected, messages }
  }, PROBE_GLOBAL)

const readProbe = async <K extends "hello" | "connected" | "messages">(page: Page, key: K) =>
  (await snapshot(page))?.[key] ?? null

test("an agent's note reaches the open page as the agent's and is listed again on the next load", async () => {
  const { page, errors, close } = await newPage(browser)
  try {
    const { open } = await openThroughProxy(service, page, fixture.url(), { session })
    await waitFor("the live socket", async () =>
      (await readProbe(page, "connected")) ? true : null,
    )

    const owner = (await session.run(["status", "--json"])).json(ServiceStatus).owner
    if (owner === null) throw new Error("status resolved no owner for the session")

    const run = await session.run([
      "note",
      open.page.id,
      "--intent",
      "question",
      "--body",
      "Is this the right label?",
      "--at",
      "[data-source-target=card]",
      "--json",
    ])
    expect(run.exitCode).toBe(0)
    const { note } = run.json(AgentNoteResult)
    expect(note).toMatchObject({
      intent: "question",
      body: "Is this the right label?",
      author: { kind: "agent", owner: owner.owner, name: session.label, agent: "stub" },
    })

    const pushed = await waitFor("the agent-note message", async () => {
      const messages = await readProbe(page, "messages")
      return messages?.find((message) => message.type === "agent-note") ?? null
    })
    expect(pushed).toEqual({ type: "agent-note", note })

    await page.reload()
    const hello = await waitFor("the hello after the reload", () => readProbe(page, "hello"))
    if (hello.outcome !== "accepted") throw new Error(`hello was refused: ${hello.reason}`)
    expect(hello.state.agentNotes).toEqual([note])
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 60_000)
