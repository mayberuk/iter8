import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  DraftBody,
  formatPointer,
  HelloResult,
  Note,
  OVERLAY_ROUTES,
  type PageId,
  type Round,
  SendNowResult,
  SendResult,
} from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { type RunningFixture, startFixture } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { openThroughProxy, type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { type StubMod, startStubMod } from "../../stubs/agent-mod"
import { type Iter8Probe, PROBE_GLOBAL } from "../../stubs/probe-overlay"

const draftSample = DraftBody.parse(
  await Bun.file(
    new URL("../../../packages/protocol/fixtures/DraftBody.json", import.meta.url),
  ).json(),
)

let browser: Browser
let bundle: Scratch
let fixture: RunningFixture
let service: RunningService
let session: AgentSession
let page: Page
let pageId: PageId
let closePage: () => Promise<void>
let mod: StubMod

beforeAll(async () => {
  bundle = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url)),
  )
  fixture = await startFixture("static")
  service = await startService({ overlayDir: bundle.path })
  session = await startAgentSession(service)
  browser = await launchChromium()
  const opened = await newPage(browser)
  page = opened.page
  closePage = opened.close
  const { open } = await openThroughProxy(service, page, fixture.url(), { session })
  pageId = open.page.id
  await waitFor("the probe's hello", async () => (await readProbe("hello")) ?? null)
  await waitFor("the live socket", async () => ((await readProbe("connected")) ? true : null))
  mod = await startStubMod(session)
  // Until the mod's wait replaces it, the session's hook listener could take a round itself.
  await session.waitForEvent((event) => event.event === "listener-ended", 15_000)
}, 60_000)

afterAll(async () => {
  await mod?.stop()
  await closePage?.()
  await browser?.close()
  await session?.exit()
  await service?.stop()
  await fixture?.stop()
  await bundle?.dispose()
})

const readProbe = (key: "hello" | "connected") =>
  page.evaluate(
    ([global, key]) => {
      const probe = Reflect.get(window, global) as Iter8Probe | undefined
      return probe ? JSON.parse(JSON.stringify(probe[key])) : null
    },
    [PROBE_GLOBAL, key] as const,
  ) as Promise<unknown>

const call = (method: string, path: string, body?: unknown) =>
  page.evaluate(
    ([global, method, path, body]) =>
      (Reflect.get(window, global) as Iter8Probe).call(method, path, body),
    [PROBE_GLOBAL, method, path, body] as const,
  )

async function sendRound(body: string): Promise<Round> {
  const hello = HelloResult.parse(await readProbe("hello"))
  if (hello.outcome !== "accepted") throw new Error(`hello was refused: ${hello.reason}`)
  if (hello.state.pairing === null) throw new Error("the opened page has no pairing")
  const created = await call(OVERLAY_ROUTES.createDraft.method, OVERLAY_ROUTES.createDraft.path, {
    ...draftSample,
    body,
  })
  expect(created.status).toBe(201)
  const note = Note.parse(created.body)
  const sent = await call(OVERLAY_ROUTES.send.method, OVERLAY_ROUTES.send.path, {
    idempotencyKey: crypto.randomUUID(),
    noteIds: [note.id],
    generation: hello.state.pairing.generation,
  })
  expect(sent.status).toBe(200)
  const result = SendResult.parse(sent.body)
  if (result.outcome !== "accepted") throw new Error(`send was refused: ${result.reason}`)
  return result.round
}

async function stageOf(roundId: Round["id"]) {
  return (await mod.state()).rounds.find((round) => round.id === roundId)?.state.stage
}

const roundDeliveries = () => mod.deliveries.filter((delivery) => delivery.kind === "round")

const hookTool = () => session.run(["hook", "tool", "--pid", String(session.pid)])

test("a round sent while the session is busy stays queued until Send now, and hook tool hands out its pointer once", async () => {
  await mod.turn("busy")
  try {
    const round = await sendRound(`send-now ${crypto.randomUUID()}`)
    expect(await stageOf(round.id)).toBe("queued")

    const now = await call(
      OVERLAY_ROUTES.sendNow.method,
      OVERLAY_ROUTES.sendNow.path.replace(":roundId", round.id),
    )
    expect(now.status).toBe(200)
    expect(SendNowResult.parse(now.body)).toMatchObject({
      outcome: "accepted",
      round: { id: round.id, state: { stage: "queued" } },
    })

    const first = await hookTool()
    expect(first.exitCode).toBe(0)
    expect(first.stdout).toBe(`${formatPointer({ roundId: round.id, pageId, noteCount: 1 })}\n`)

    const second = await hookTool()
    expect(second).toMatchObject({ exitCode: 0, stdout: "" })

    expect(roundDeliveries().filter((delivery) => delivery.pointer.roundId === round.id)).toEqual(
      [],
    )
  } finally {
    await mod.turn("idle")
  }
}, 60_000)

test("a round sent while the session is busy without Send now reaches the mod only once the turn ends", async () => {
  await mod.turn("busy")
  const round = await sendRound(`after the turn ${crypto.randomUUID()}`)
  const quiet = await hookTool()
  expect(quiet).toMatchObject({ exitCode: 0, stdout: "" })
  expect(await stageOf(round.id)).toBe("queued")
  expect(roundDeliveries()).toEqual([])

  await mod.turn("idle")
  const pointer = { roundId: round.id, pageId, noteCount: 1 }
  await waitFor(
    "the round to reach the mod",
    async () => (roundDeliveries().length > 0 ? true : null),
    { timeoutMs: 15_000 },
  )
  expect(roundDeliveries()).toEqual([{ kind: "round", pointer, text: formatPointer(pointer) }])
}, 60_000)
