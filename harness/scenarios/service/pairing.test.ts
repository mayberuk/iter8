import { afterAll, beforeAll, expect, test } from "bun:test"
import { cp } from "node:fs/promises"
import {
  AttachResult,
  DraftBody,
  formatPointer,
  HelloResult,
  LiveSessionList,
  Note,
  type NoteId,
  OVERLAY_ROUTES,
  type OwnerId,
  type PageId,
  type PairingGeneration,
  POINTER_LINE,
  type Round,
  SendResult,
  ServerMessage,
} from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { fixtureDir } from "../../rig/fixtures"
import { WORKER } from "../../rig/ports"
import { type Scratch, scratchDir } from "../../rig/scratch"
import { openThroughProxy, type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { type Iter8Probe, PROBE_GLOBAL } from "../../stubs/probe-overlay"

const draftSample = DraftBody.parse(
  await Bun.file(
    new URL("../../../packages/protocol/fixtures/DraftBody.json", import.meta.url),
  ).json(),
)

let browser: Browser
let probe: Scratch

beforeAll(async () => {
  probe = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url)),
  )
  browser = await launchChromium()
})

afterAll(async () => {
  await browser?.close()
  await probe?.dispose()
})

type Pair = {
  session: AgentSession
  page: Page
  pageId: PageId
  hello(): Promise<Extract<HelloResult, { outcome: "accepted" }>>
  messages(): Promise<ServerMessage[]>
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>
  draft(body: string): Promise<Note>
  send(noteIds: NoteId[], generation: PairingGeneration): Promise<SendResult>
  sendRound(body: string): Promise<{ round: Round; generation: PairingGeneration }>
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function makePair(
  service: RunningService,
  disposers: (() => Promise<void>)[],
): Promise<Pair> {
  const copy = await scratchDir(`/tmp/iter8-w${WORKER}-static-`)
  disposers.push(copy.dispose)
  await cp(fixtureDir("static"), copy.path, { recursive: true })

  const session = await startAgentSession(service)
  disposers.push(async () => {
    if (alive(session.pid)) await session.exit()
  })

  const opened = await newPage(browser)
  disposers.push(opened.close)
  const { page } = opened
  const { open } = await openThroughProxy(service, page, copy.path, { session })

  const readProbe = (name: "hello" | "connected" | "messages") =>
    page.evaluate(
      ([global, key]) => {
        const probe = Reflect.get(window, global) as Iter8Probe | undefined
        return probe ? JSON.parse(JSON.stringify(probe[key])) : null
      },
      [PROBE_GLOBAL, name] as const,
    ) as Promise<unknown>

  await waitFor("the probe's first hello", async () => (await readProbe("hello")) ?? null)
  await waitFor("the live socket", async () => ((await readProbe("connected")) ? true : null))

  const call: Pair["call"] = (method, path, body) =>
    page.evaluate(
      ([global, method, path, body]) => {
        const probe = Reflect.get(window, global) as Iter8Probe
        return probe.call(method, path, body)
      },
      [PROBE_GLOBAL, method, path, body] as const,
    )

  const hello: Pair["hello"] = async () => {
    const boot = (await page.evaluate(
      (global) => (Reflect.get(window, global) as Iter8Probe).boot,
      PROBE_GLOBAL,
    )) as Iter8Probe["boot"]
    const reply = await call(OVERLAY_ROUTES.hello.method, OVERLAY_ROUTES.hello.path, {
      protocolVersion: boot.protocolVersion,
      pageId: boot.pageId,
      machineId: boot.machineId,
    })
    expect(reply.status).toBe(200)
    const parsed = HelloResult.parse(reply.body)
    if (parsed.outcome !== "accepted") throw new Error(`hello was refused: ${parsed.reason}`)
    return parsed
  }

  const draft: Pair["draft"] = async (body) => {
    const created = await call(OVERLAY_ROUTES.createDraft.method, OVERLAY_ROUTES.createDraft.path, {
      ...draftSample,
      body,
    })
    expect(created.status).toBe(201)
    return Note.parse(created.body)
  }

  const send: Pair["send"] = async (noteIds, generation) => {
    const reply = await call(OVERLAY_ROUTES.send.method, OVERLAY_ROUTES.send.path, {
      idempotencyKey: crypto.randomUUID(),
      noteIds,
      generation,
    })
    expect(reply.status).toBe(200)
    return SendResult.parse(reply.body)
  }

  return {
    session,
    page,
    pageId: open.page.id,
    hello,
    messages: async () =>
      ((await readProbe("messages")) as unknown[]).map((message) => ServerMessage.parse(message)),
    call,
    draft,
    send,
    sendRound: async (body) => {
      const pairing = (await hello()).state.pairing
      if (pairing === null) throw new Error("the opened page has no pairing")
      const note = await draft(body)
      const sent = await send([note.id], pairing.generation)
      if (sent.outcome !== "accepted") throw new Error(`send was refused: ${sent.reason}`)
      return { round: sent.round, generation: pairing.generation }
    },
  }
}

async function withPairs(
  count: number,
  body: (pairs: Pair[], service: RunningService) => Promise<void>,
): Promise<void> {
  const disposers: (() => Promise<void>)[] = []
  const service = await startService({ overlayDir: probe.path })
  try {
    const pairs: Pair[] = []
    for (let index = 0; index < count; index++) pairs.push(await makePair(service, disposers))
    await body(pairs, service)
  } finally {
    for (const dispose of disposers.reverse()) await dispose().catch(() => {})
    await service.stop()
  }
}

const woken = async (session: AgentSession) => {
  const event = await session.waitForEvent((candidate) => candidate.event === "woken", 15_000)
  if (event.event !== "woken") throw new Error("not a woken event")
  return event.lines
}

const secret = (label: string) => `${label}-${crypto.randomUUID()}`

test("each round's pointer reaches only the session that owns its page", async () => {
  await withPairs(2, async ([a, b]) => {
    if (a === undefined || b === undefined) throw new Error("two pairs expected")
    const sentA = await a.sendRound(secret("round-a"))
    const sentB = await b.sendRound(secret("round-b"))
    expect(sentA.round.id).not.toBe(sentB.round.id)

    const linesA = await woken(a.session)
    const linesB = await woken(b.session)
    expect(linesA).toEqual([
      formatPointer({ roundId: sentA.round.id, pageId: a.pageId, noteCount: 1 }),
    ])
    expect(linesB).toEqual([
      formatPointer({ roundId: sentB.round.id, pageId: b.pageId, noteCount: 1 }),
    ])
    for (const line of [...linesA, ...linesB]) expect(line).toMatch(POINTER_LINE)

    for (const [own, other, lines] of [
      [a, b, linesA],
      [b, a, linesB],
    ] as const) {
      const prompted = await own.session.prompt()
      for (const line of [...lines, ...prompted.lines]) {
        const match = POINTER_LINE.exec(line)
        expect(match?.groups?.page).toBe(own.pageId)
        expect(match?.groups?.page).not.toBe(other.pageId)
      }
    }
    expect(a.session.events.filter((event) => event.event === "woken")).toHaveLength(1)
    expect(b.session.events.filter((event) => event.event === "woken")).toHaveLength(1)
  })
}, 90_000)

test("a wake carries pointer lines and none of the note's text", async () => {
  await withPairs(1, async ([pair]) => {
    if (pair === undefined) throw new Error("one pair expected")
    const body = secret("note-body")
    const { round } = await pair.sendRound(body)

    const lines = await woken(pair.session)
    expect(lines).toEqual([formatPointer({ roundId: round.id, pageId: pair.pageId, noteCount: 1 })])
    const text = lines.join("\n")
    expect(text).not.toContain(body)
    expect(text).not.toContain(draftSample.capture?.surroundingText ?? "unreachable")
    expect(text).not.toContain(draftSample.body)
  })
}, 60_000)

test("clear keeps the page paired at the same generation and announces the unclaimed round once", async () => {
  await withPairs(1, async ([pair]) => {
    if (pair === undefined) throw new Error("one pair expected")
    const before = (await pair.hello()).state.pairing
    if (before === null) throw new Error("the opened page has no pairing")
    const { round } = await pair.sendRound(secret("clear"))
    await woken(pair.session)

    const cleared = await pair.session.clear()
    expect(cleared.exitCode).toBe(0)
    expect(cleared.lines).toEqual([
      formatPointer({ roundId: round.id, pageId: pair.pageId, noteCount: 1 }),
    ])

    const after = (await pair.hello()).state.pairing
    expect(after?.generation).toBe(before.generation)
    expect(after?.owner).toBe(before.owner)
    expect(after?.state.status).not.toBe("gone")
    expect(after?.process.label).toBe(cleared.label)

    const prompted = await pair.session.prompt()
    expect(prompted.lines).toEqual([])

    const next = await pair.draft(secret("after-clear"))
    const sent = await pair.send([next.id], before.generation)
    expect(sent.outcome).toBe("accepted")
  })
}, 60_000)

test("a crashed session is pushed to the open page, refuses Send, and the page reattaches to the other session", async () => {
  await withPairs(2, async ([a, b]) => {
    if (a === undefined || b === undefined) throw new Error("two pairs expected")
    const ownerA = (await a.hello()).state.pairing?.owner
    const ownerB = (await b.hello()).state.pairing?.owner
    if (ownerA === undefined || ownerB === undefined) throw new Error("both pages are paired")
    expect(ownerA).not.toBe(ownerB)

    const sentA = await a.sendRound(secret("before-crash"))
    await woken(a.session)
    await b.sendRound(secret("other-page"))
    await woken(b.session)

    await a.session.crash()
    const gone = await waitFor(
      "the pairing message with state gone",
      async () =>
        (await a.messages()).find(
          (message) => message.type === "pairing" && message.pairing?.state.status === "gone",
        ) ?? null,
      { timeoutMs: 20_000, everyMs: 100 },
    )
    expect(gone).toMatchObject({
      type: "pairing",
      pairing: { owner: ownerA, state: { status: "gone", reason: "crashed" } },
    })

    const pending = await a.draft(secret("after-crash"))
    const refused = await a.send([pending.id], sentA.generation)
    expect(refused).toMatchObject({
      outcome: "refused",
      reason: "session-gone",
      pairing: { owner: ownerA, state: { status: "gone" } },
    })

    const listed = await a.call(
      OVERLAY_ROUTES.listSessions.method,
      OVERLAY_ROUTES.listSessions.path,
    )
    expect(listed.status).toBe(200)
    const sessions = LiveSessionList.parse(listed.body)
    const owners: OwnerId[] = sessions.map((entry) => entry.owner)
    expect(owners).toContain(ownerB)
    expect(owners).not.toContain(ownerA)
    expect(sessions.find((entry) => entry.owner === ownerB)).toMatchObject({ agent: "stub" })

    const attached = await a.call(OVERLAY_ROUTES.attach.method, OVERLAY_ROUTES.attach.path, {
      owner: ownerB,
    })
    expect(attached.status).toBe(200)
    const result = AttachResult.parse(attached.body)
    if (result.outcome !== "accepted") throw new Error(`attach was refused: ${result.reason}`)
    expect(result.pairing.owner).toBe(ownerB)
    expect(result.pairing.generation).toBeGreaterThan(sentA.generation)
    expect(result.requeued).toEqual([sentA.round.id])

    const stale = await a.send([pending.id], sentA.generation)
    expect(stale).toMatchObject({ outcome: "refused", reason: "stale-generation" })

    const accepted = await a.send([pending.id], result.pairing.generation)
    expect(accepted.outcome).toBe("accepted")
  })
}, 120_000)
