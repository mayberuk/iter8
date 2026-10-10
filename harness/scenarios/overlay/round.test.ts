import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import {
  LiveSession,
  Note,
  OVERLAY_ROUTES,
  Pairing,
  Round,
  type ServerMessage,
  TOKEN_HEADER,
} from "@iter8/protocol"
import type { Browser, Locator } from "playwright"
import liveSessionJson from "../../../packages/protocol/fixtures/LiveSession.json"
import noteJson from "../../../packages/protocol/fixtures/Note.json"
import goneJson from "../../../packages/protocol/fixtures/Pairing.gone.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import roundJson from "../../../packages/protocol/fixtures/Round.json"
import orphanedJson from "../../../packages/protocol/fixtures/Round.orphaned.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const PAGE = "mockpage"
const SHOT = "shot_8f2c1a9e"
const LIVE = Pairing.parse(pairingJson)
const GONE = Pairing.parse(goneJson)
const OTHER = LiveSession.parse({ ...liveSessionJson, state: { status: "live" } })
const GONE_SESSION = {
  owner: GONE.owner,
  agent: GONE.agent,
  process: GONE.process,
  cwd: GONE.cwd,
  state: GONE.state,
}
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

function headingTarget(id: string, text: string) {
  return {
    kind: "element" as const,
    anchor: {
      selector: [`#${id}`],
      role: "heading",
      text,
      box: { x: 0, y: 0, width: 100, height: 30 },
      renderGeneration: 0,
    },
  }
}

function draft(
  id: string,
  body: string,
  target: Note["target"] = headingTarget("overview-heading", "Overview"),
  intent: Note["intent"] = "fix",
) {
  return Note.parse({ ...noteJson, id, pageId: PAGE, body, target, intent, capture: undefined })
}

function onPage<T extends { pageId: string; notes: { pageId: string }[] }>(json: T) {
  return Round.parse({
    ...json,
    pageId: PAGE,
    notes: json.notes.map((note) => ({ ...note, pageId: PAGE })),
  })
}

const BODIES = ["First note body", "Second note body", "Third note body"]
const TARGETS = [
  headingTarget("overview-heading", "Overview"),
  headingTarget("details-heading", "Details"),
  headingTarget("notes-heading", "Notes"),
]
const INTENTS = ["fix", "fix", "change"] as const
const THREE = {
  drafts: BODIES.map((body, i) => draft(`N3${i}`, body, TARGETS[i], INTENTS[i])),
  rounds: [],
  agentNotes: [],
}
const ONE = { drafts: [draft("N30", BODIES[0] as string)], rounds: [], agentNotes: [] }

const ANSWERED_ROUND = onPage(roundJson)
const OPEN_ROUND = Round.parse({
  ...ANSWERED_ROUND,
  state: {
    stage: "queued",
    queuedAt: "2026-10-09T18:34:00.000Z",
    idempotencyKey: "send-7c1e9b2a40d3",
  },
  notes: ANSWERED_ROUND.notes.map((note) => ({ ...note, resolution: { status: "open" } })),
})
const ORPHANED = onPage(orphanedJson)
const QUEUED_STATE = {
  stage: "queued",
  queuedAt: "2026-10-09T18:34:00.000Z",
  idempotencyKey: "send-7c1e9b2a40d3",
} as const
const ANNOUNCED_AT = "2026-10-09T18:35:00.000Z"
const ANNOUNCED = Round.parse({
  ...OPEN_ROUND,
  state: { ...QUEUED_STATE, stage: "announced", announcedAt: ANNOUNCED_AT, generation: 2 },
})
const WORKING = Round.parse({
  ...ANNOUNCED,
  state: { ...ANNOUNCED.state, stage: "claimed", claimedAt: "2026-10-09T18:36:00.000Z" },
})
const FINISHED = Round.parse({ ...ANSWERED_ROUND, state: WORKING.state })
const QUEUED_ORPHAN = Round.parse({
  ...ORPHANED,
  state: {
    stage: "queued",
    queuedAt: ORPHANED.state.stage === "orphaned" ? ORPHANED.state.queuedAt : "",
    idempotencyKey: "send-31f0aa8c5e72",
  },
})
const ANSWER_TEXT = "Yes, below 640px it stacks."

let browser: Browser
let overlayBuild: Scratch
let opened: Awaited<ReturnType<typeof openOverlay>> | null = null

beforeAll(async () => {
  browser = await launchChromium()
  overlayBuild = await buildOverlay()
})

afterEach(async () => {
  await opened?.close()
  opened = null
})

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
})

async function open(mock: Parameters<typeof openOverlay>[0]["mock"] = {}) {
  opened = await openOverlay({ overlayDir: overlayBuild.path, folder: STATIC, mock, browser })
  await until("the dock to be ready", () =>
    opened ? opened.overlay.getByRole("button", { name: "Pick element" }).isVisible() : false,
  )
  return opened
}

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

type Opened = Awaited<ReturnType<typeof open>>

async function openSheet(o: Opened, tab: "round" | "history" = "round"): Promise<Locator> {
  const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
  await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
  await until("the round sheet", () => sheet.isVisible())
  if (tab === "history") await sheet.getByRole("tab", { name: /^History/ }).click()
  return sheet
}

/** A pushed message reaches only an open socket, so push until its effect shows. */
async function pushUntil(o: Opened, message: ServerMessage, landed: () => Promise<boolean>) {
  await waitFor(
    "the pushed message to land",
    async () => {
      o.mock.push(message)
      return (await landed()) ? true : null
    },
    { timeoutMs: 5000, everyMs: 100 },
  )
}

async function serveScreenshot(o: Opened): Promise<Record<string, string>[]> {
  const seen: Record<string, string>[] = []
  await o.page.route(`**/screenshots/${SHOT}`, (route) => {
    seen.push(route.request().headers())
    return route.fulfill({ status: 200, contentType: "image/png", body: PNG })
  })
  return seen
}

const clockTime = (o: Opened, iso: string) =>
  o.page.evaluate(
    (value) => new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(value)),
    iso,
  )

const noteIds = (rows: Locator) =>
  rows.evaluateAll((els) => els.map((el) => el.id.replace("note-", "")))

async function uploadShotNote(o: Opened): Promise<void> {
  const shot = await o.page.evaluate(
    async ({ path, header, token, bytes }) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { [header]: token, "content-type": "image/png" },
        body: new Uint8Array(bytes),
      })
      return (await response.json()) as { ref: string; width: number; height: number }
    },
    {
      path: OVERLAY_ROUTES.uploadScreenshot.path,
      header: TOKEN_HEADER,
      token: o.mock.token,
      bytes: [...PNG],
    },
  )
  const capture = { ...noteJson.capture, screenshot: shot }
  const created = await o.page.evaluate(
    async ({ path, header, token, body }) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { [header]: token, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      return response.status
    },
    {
      path: OVERLAY_ROUTES.createDraft.path,
      header: TOKEN_HEADER,
      token: o.mock.token,
      body: {
        intent: "fix",
        body: BODIES[0],
        target: headingTarget("overview-heading", "Overview"),
        anchorStatus: "anchored",
        capture,
      },
    },
  )
  expect(created).toBe(201)
  await o.page.reload()
  await until("the dock after the reload", () =>
    o.overlay.getByRole("button", { name: "Pick element" }).isVisible(),
  )
}

const sends = (o: Opened) =>
  o.mock
    .requests()
    .filter((request) => request.method === "POST" && request.path === OVERLAY_ROUTES.send.path)

const rowOrder = async (rows: Locator) =>
  (await rows.allInnerTexts()).map((text) => BODIES.findIndex((body) => text.includes(body)))

describe("round sheet: this round", () => {
  test("a double click on Send delivers one round", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE })
    const sheet = await openSheet(o)
    await sheet.getByRole("button", { name: "Send round" }).dblclick()
    await until("the round to arrive", () => o.mock.rounds().length === 1)
    await until("History to open", () =>
      sheet.getByRole("tabpanel", { name: "History" }).isVisible(),
    )
    await until("the sent round", () =>
      sheet.getByRole("heading", { name: "Round 1", exact: true }).isVisible(),
    )
    expect(sends(o)).toHaveLength(1)
    expect(o.mock.rounds()).toHaveLength(1)
    expect(o.mock.rounds()[0]?.notes).toHaveLength(3)
    expect(o.mock.draft()).toHaveLength(0)
    expect(await sheet.getByRole("tab", { name: /^This round/ }).innerText()).toContain("0")
  }, 30_000)

  test("dock Send and sheet Send pressed while the first is pending deliver one round under one key", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = 0
    await o.page.route(`**${OVERLAY_ROUTES.send.path}`, async (route) => {
      held += 1
      if (held === 1) await gate
      await route.continue()
    })

    try {
      await o.overlay.getByRole("button", { name: "Send", exact: true }).click()
      await until("the first send to be held", () => held === 1)
      const sheet = await openSheet(o)
      await sheet.getByRole("button", { name: "Send round" }).click()
      await o.page.evaluate(() => fetch("/after-both-clicks").catch(() => {}))
      await until("both clicks to be behind us", () =>
        o.mock.requests().some((request) => request.path === "/after-both-clicks"),
      )
      expect(sends(o)).toHaveLength(0)
      release()

      await until("the round to arrive", () => o.mock.rounds().length === 1)
      await until("History to open", () =>
        sheet.getByRole("tabpanel", { name: "History" }).isVisible(),
      )
      const keys = sends(o).map(
        (request) => (request.body as { idempotencyKey: string }).idempotencyKey,
      )
      expect(keys.length).toBeGreaterThan(0)
      expect(new Set(keys).size).toBe(1)
      expect(o.mock.rounds()).toHaveLength(1)
      expect(o.mock.draft()).toHaveLength(0)
    } finally {
      release()
    }
  }, 30_000)

  test("with no live pairing Send is disabled, says why, and makes no request", async () => {
    const o = await open({ pairing: null, liveSessions: [OTHER], pageState: THREE })
    const sheet = await openSheet(o)
    const send = sheet.getByRole("button", { name: "Send round" })
    expect(await send.isDisabled()).toBe(true)
    expect(await sheet.getByRole("heading", { name: "Not attached" }).isVisible()).toBe(true)
    await send.click({ force: true, timeout: 1000 }).catch(() => {})
    expect(sends(o)).toHaveLength(0)
    expect(o.mock.rounds()).toHaveLength(0)
  }, 30_000)

  test("a session that ended offers the live sessions and reattaches from a row", async () => {
    const o = await open({
      pairing: GONE,
      liveSessions: [GONE_SESSION, OTHER],
      pageState: THREE,
    })
    const sheet = await openSheet(o)
    expect(await sheet.getByRole("button", { name: "Send round" }).isDisabled()).toBe(true)
    expect(await sheet.getByRole("heading", { name: "Session ended" }).isVisible()).toBe(true)
    const row = sheet.getByRole("button", { name: "Attach to larkspur" })
    await until("the live session row", () => row.isVisible())
    await row.click()
    await until("Send to come back", () =>
      sheet.getByRole("button", { name: "Send round" }).isEnabled(),
    )
    const attaches = o.mock
      .requests()
      .filter((r) => r.method === "POST" && r.path === OVERLAY_ROUTES.attach.path)
    expect(attaches.map((request) => request.body)).toEqual([{ owner: OTHER.owner }])
    expect(sends(o)).toHaveLength(0)
  }, 30_000)

  test("a busy session relabels Send as Queue and says when the round delivers", async () => {
    const o = await open({ pairing: { ...LIVE, state: { status: "busy" } }, pageState: THREE })
    const sheet = await openSheet(o)
    expect(await sheet.getByRole("button", { name: "Queue round" }).isEnabled()).toBe(true)
    expect(await sheet.innerText()).toContain(
      "is mid-turn. This round delivers when its turn ends.",
    )
  }, 30_000)

  test("a note whose element left the page says Moved; the others do not", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: {
        drafts: [
          draft("N30", BODIES[0] as string),
          draft("N31", BODIES[1] as string, headingTarget("no-such-heading", "Gone")),
        ],
        rounds: [],
        agentNotes: [],
      },
    })
    const sheet = await openSheet(o)
    const rows = sheet.getByRole("listitem")
    await until("the moved chip", () => sheet.getByRole("status", { name: "Moved" }).isVisible())
    expect(await sheet.getByRole("status", { name: "Moved" }).count()).toBe(1)
    expect(await rows.nth(1).getByRole("status", { name: "Moved" }).isVisible()).toBe(true)
    expect(await rows.nth(0).getByRole("status", { name: "Moved" }).count()).toBe(0)
  }, 30_000)

  test("j, k and Alt+Arrow focus and reorder the notes, and the order is what is sent", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE })
    const sheet = await openSheet(o)
    const rows = sheet.getByRole("listitem")
    expect(await rowOrder(rows)).toEqual([0, 1, 2])

    await o.page.keyboard.press("j")
    await o.page.keyboard.press("j")
    await until(
      "the second row to take focus",
      async () => (await rows.nth(1).getAttribute("aria-current")) === "true",
    )
    await o.page.keyboard.press("Alt+ArrowUp")
    await until("the reorder", async () => (await rowOrder(rows)).join() === "1,0,2")
    expect(await rows.nth(0).getAttribute("aria-current")).toBe("true")

    await sheet.getByRole("button", { name: "Send round" }).click()
    await until("the round to arrive", () => o.mock.rounds().length === 1)
    expect(sends(o)[0]?.body).toMatchObject({ noteIds: ["N31", "N30", "N32"] })
  }, 30_000)

  test("dragging a note onto another moves it there", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE })
    const sheet = await openSheet(o)
    const rows = sheet.getByRole("listitem")
    await rows.nth(2).dragTo(rows.nth(0))
    await until("the reorder", async () => (await rowOrder(rows)).join() === "2,0,1")
  }, 30_000)

  test("deleting a note removes it from the service and offers undo", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE })
    const sheet = await openSheet(o)
    await sheet.getByRole("button", { name: "Delete note 2" }).click()
    await until("the row to go", async () => (await sheet.getByRole("listitem").count()) === 2)
    expect(o.mock.draft().map((note) => String(note.id))).toEqual(["N30", "N32"])
    expect(
      await o.overlay.getByRole("status").filter({ hasText: "Note 2 deleted" }).isVisible(),
    ).toBe(true)
  }, 30_000)

  test("a screenshot uploaded through the page is fetched with the page token and shown as a decoded blob image", async () => {
    const o = await open({ pairing: LIVE })
    await uploadShotNote(o)
    const sheet = await openSheet(o)
    const frame = sheet.getByRole("img", { name: "Screenshot of note 1" })
    await until("the screenshot", () => frame.isVisible())
    expect(await frame.getAttribute("src")).toMatch(/^blob:/)
    await until("the image to decode", () =>
      frame.evaluate((img) => img instanceof HTMLImageElement && img.naturalWidth === 1),
    )
    const fetched = o.mock
      .requests()
      .filter((request) => request.method === "GET" && request.path.includes("/screenshots/"))
    expect(fetched.length).toBeGreaterThan(0)
    expect(fetched.every((request) => request.headers[TOKEN_HEADER] === o.mock.token)).toBe(true)
  }, 30_000)

  test("the object URL is revoked when the sheet closes and when the tab changes", async () => {
    const o = await open({ pairing: LIVE })
    await o.page.addInitScript(() => {
      const revoked: string[] = []
      Object.assign(window, { revoked })
      const revoke = URL.revokeObjectURL.bind(URL)
      URL.revokeObjectURL = (url: string) => {
        revoked.push(url)
        revoke(url)
      }
    })
    await uploadShotNote(o)
    const sheet = await openSheet(o)
    const frame = sheet.getByRole("img", { name: "Screenshot of note 1" })
    await until("the screenshot", () => frame.isVisible())
    const first = (await frame.getAttribute("src")) ?? ""
    const revoked = () =>
      o.page.evaluate(() => (window as unknown as { revoked: string[] }).revoked)

    await sheet.getByRole("tab", { name: /^History/ }).click()
    await until("the tab change to revoke it", async () => (await revoked()).includes(first))

    await sheet.getByRole("tab", { name: /^This round/ }).click()
    const second = sheet.getByRole("img", { name: "Screenshot of note 1" })
    await until("the screenshot again", () => second.isVisible())
    const again = (await second.getAttribute("src")) ?? ""
    await o.overlay.getByRole("button", { name: "Close round sheet" }).click()
    await until("closing to revoke it", async () => (await revoked()).includes(again))
  }, 30_000)

  test("a screenshot that arrives after the sheet closed is never turned into an object URL", async () => {
    const o = await open({ pairing: LIVE })
    await uploadShotNote(o)
    await o.page.evaluate(() => {
      const made: string[] = []
      Object.assign(window, { made })
      const create = URL.createObjectURL.bind(URL)
      URL.createObjectURL = (blob: Blob | MediaSource) => {
        const url = create(blob)
        made.push(url)
        return url
      }
    })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let arrived = 0
    await o.page.route("**/screenshots/*", async (route) => {
      await gate
      await route.continue()
      arrived += 1
    })
    try {
      await openSheet(o)
      await o.overlay.getByRole("button", { name: "Close round sheet" }).click()
      release()
      await until("the late screenshot to arrive", () => arrived === 1)
      await o.page.evaluate(() => fetch("/after-the-late-screenshot").catch(() => {}))
      await until("the page to settle", () =>
        o.mock.requests().some((request) => request.path === "/after-the-late-screenshot"),
      )
      expect(await o.page.evaluate(() => (window as unknown as { made: string[] }).made)).toEqual(
        [],
      )
    } finally {
      release()
    }
  }, 30_000)
})

describe("round sheet: history", () => {
  test("pushed updates move the round through delivered, working and done, each chip on its own note", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: { drafts: [], rounds: [OPEN_ROUND], agentNotes: [] },
    })
    const sheet = await openSheet(o, "history")
    const fixed = sheet.getByRole("article").filter({ hasText: "The price wraps" })
    const band = sheet.getByRole("article").filter({ hasText: "Should this whole band collapse" })
    const state = (article: Locator, name: string) =>
      article.getByRole("status", { name, exact: true }).count()
    await until(
      "both notes queued",
      async () => (await state(fixed, "queued")) + (await state(band, "queued")) === 2,
    )
    expect(await sheet.getByRole("status", { name: "Queued", exact: true }).isVisible()).toBe(true)

    await pushUntil(
      o,
      { type: "round", round: ANNOUNCED },
      async () => (await state(fixed, "delivered")) === 1,
    )
    expect(await state(band, "delivered")).toBe(1)
    expect(await sheet.getByRole("status", { name: "Delivered", exact: true }).isVisible()).toBe(
      true,
    )
    const delivered = await clockTime(o, ANNOUNCED_AT)
    expect(await fixed.locator(".when").innerText()).toContain(`delivered ${delivered}`)

    await pushUntil(
      o,
      { type: "round", round: WORKING },
      async () => (await state(fixed, "working")) === 1,
    )
    expect(await state(band, "working")).toBe(1)
    expect(await sheet.getByRole("status", { name: "2 in progress" }).isVisible()).toBe(true)

    await pushUntil(
      o,
      { type: "round", round: FINISHED },
      async () => (await state(fixed, "done")) === 1,
    )
    expect(await state(fixed, "answered")).toBe(0)
    expect(await state(band, "answered")).toBe(1)
    expect(await state(band, "done")).toBe(0)
    expect(await sheet.getByRole("status", { name: "All 2 resolved" }).isVisible()).toBe(true)

    const reply = band.getByRole("region", { name: "Reply from Claude" })
    expect(await reply.innerText()).toContain(ANSWER_TEXT)
    const [sent, claimed, done, answered] = await Promise.all(
      [
        QUEUED_STATE.queuedAt,
        WORKING.state.stage === "claimed" ? WORKING.state.claimedAt : "",
        "2026-10-09T18:45:00.000Z",
        "2026-10-09T18:46:00.000Z",
      ].map((iso) => clockTime(o, iso)),
    )
    expect(await fixed.locator(".when").innerText()).toBe(
      `sent ${sent} · delivered ${delivered} · picked up ${claimed} · done ${done}`,
    )
    expect(await band.locator(".when").innerText()).toBe(
      `sent ${sent} · delivered ${delivered} · picked up ${claimed} · answered ${answered}`,
    )
    expect(await reply.innerText()).toContain(`answered ${answered}`)
  }, 30_000)

  test("a round pushed as orphaned turns into Not delivered with the sessions to attach", async () => {
    const o = await open({
      pairing: GONE,
      liveSessions: [GONE_SESSION, OTHER],
      pageState: { drafts: [], rounds: [QUEUED_ORPHAN], agentNotes: [] },
    })
    const sheet = await openSheet(o, "history")
    await until("the queued round", () =>
      sheet.getByRole("status", { name: "Queued", exact: true }).isVisible(),
    )
    expect(await sheet.getByRole("button", { name: "Attach to larkspur" }).count()).toBe(0)

    await pushUntil(o, { type: "round", round: ORPHANED }, () =>
      sheet.getByRole("status", { name: "Not delivered" }).isVisible(),
    )
    await until("the live session row", () =>
      sheet.getByRole("button", { name: "Attach to larkspur" }).isVisible(),
    )
  }, 30_000)

  test("an orphaned round shows as not delivered, with the live sessions to attach", async () => {
    const o = await open({
      pairing: GONE,
      liveSessions: [GONE_SESSION, OTHER],
      pageState: { drafts: [], rounds: [ORPHANED], agentNotes: [] },
    })
    const sheet = await openSheet(o, "history")
    await until("the outcome", () =>
      sheet.getByRole("status", { name: "Not delivered" }).isVisible(),
    )
    expect(await sheet.getByRole("status", { name: "failed", exact: true }).isVisible()).toBe(true)
    expect(
      await sheet
        .getByRole("status", { name: "Not delivered" })
        .getByText("Not delivered — larkspur ended before picking this up")
        .count(),
    ).toBe(1)

    const row = sheet.getByRole("button", { name: "Attach to larkspur" })
    await until("the live session row", () => row.isVisible())
    expect(await sheet.getByRole("button", { name: /Attach to .*larkspur.*/ }).count()).toBe(1)
    await row.click()
    await until("the attach request", () =>
      o.mock.requests().some((r) => r.method === "POST" && r.path === OVERLAY_ROUTES.attach.path),
    )
    expect(sends(o)).toHaveLength(0)
  }, 30_000)

  test("History counts every sent note and shows an empty state before any round", async () => {
    const empty = await open({ pairing: LIVE, pageState: ONE })
    const sheet = await openSheet(empty, "history")
    expect(await sheet.getByRole("tab", { name: /^History/ }).innerText()).toContain("0")
    expect(await sheet.innerText()).toContain("No rounds sent yet")
    await empty.close()
    opened = null

    const full = await open({
      pairing: LIVE,
      pageState: { drafts: [], rounds: [ANSWERED_ROUND], agentNotes: [] },
    })
    const history = await openSheet(full, "history")
    expect(await history.getByRole("tab", { name: /^History/ }).innerText()).toContain("2")
  }, 30_000)

  test("Before / after opens a slider the arrow keys move", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: { drafts: [], rounds: [ANSWERED_ROUND], agentNotes: [] },
    })
    await serveScreenshot(o)
    const sheet = await openSheet(o, "history")
    const toggle = sheet.getByRole("button", { name: "Before / after" })
    await toggle.click()
    expect(await sheet.getByRole("button", { name: "Hide compare" }).isVisible()).toBe(true)

    const slider = sheet.getByRole("slider", { name: "Compare before and after" })
    await slider.focus()
    expect(await slider.inputValue()).toBe("50")
    await slider.press("ArrowRight")
    expect(await slider.inputValue()).toBe("55")
    await slider.press("ArrowLeft")
    await slider.press("ArrowLeft")
    expect(await slider.inputValue()).toBe("45")

    await sheet.getByRole("button", { name: "Hide compare" }).click()
    expect(await slider.count()).toBe(0)
  }, 30_000)
})

describe("round sheet: header, summary and rows", () => {
  test("R opens the sheet: a 416 px panel, the header, the intent summary with its bars, and a close button", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE })
    const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
    expect(await sheet.count()).toBe(0)
    await o.page.keyboard.press("r")
    await until("the sheet", () => sheet.isVisible())

    expect(Math.round((await sheet.boundingBox())?.width ?? 0)).toBe(416)
    expect(await sheet.getByRole("heading", { name: "Round 1", exact: true }).isVisible()).toBe(
      true,
    )
    const header = await sheet.locator(".sh-h").innerText()
    expect(header).toContain("larkspur")
    expect(header).toContain("mock-machine")

    const summary = await sheet.locator(".sh-f .sum .txt").innerText()
    expect(summary).toContain("3 notes")
    expect(summary).toContain("2 fix · 1 change")
    const bars = await sheet
      .locator(".sh-f .bars i")
      .evaluateAll((els) => els.map((el) => [el.className, getComputedStyle(el).flexGrow]))
    expect(bars).toEqual([
      ["fix", "2"],
      ["change", "1"],
    ])

    await sheet.getByRole("button", { name: "Close round sheet" }).click()
    await until("the sheet to close", async () => !(await sheet.isVisible()))
  }, 30_000)

  test("the header and the empty state name the round the service will create next", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: { drafts: [], rounds: [ANSWERED_ROUND], agentNotes: [] },
    })
    const sheet = await openSheet(o)
    expect(await sheet.getByRole("heading", { name: "Round 13", exact: true }).isVisible()).toBe(
      true,
    )
    expect(await sheet.innerText()).toContain("Nothing in round 13 yet")
    expect(await o.overlay.locator(".dock .rl").innerText()).toBe("ROUND 13")
    expect(await sheet.innerText()).toContain("No notes yet")
    expect(await sheet.getByRole("button", { name: "Send round" }).isDisabled()).toBe(true)
  }, 30_000)

  test("the round that Send creates carries the number the header promised", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: { drafts: THREE.drafts, rounds: [ANSWERED_ROUND], agentNotes: [] },
    })
    const sheet = await openSheet(o)
    expect(await sheet.getByRole("heading", { name: "Round 13", exact: true }).isVisible()).toBe(
      true,
    )
    await sheet.getByRole("button", { name: "Send round" }).click()
    await until("the round to arrive", () => o.mock.rounds().length === 2)
    expect(String(o.mock.rounds()[1]?.id)).toBe("R13")
    await until("the sent round in History", () =>
      sheet.getByRole("heading", { name: "Round 13", exact: true }).isVisible(),
    )
  }, 30_000)

  test("a row shows its number, a 120x76 frame, the intent, the text, the target and an intent-coloured placeholder", async () => {
    const two = {
      drafts: [
        draft("N30", BODIES[0] as string, TARGETS[0], "fix"),
        draft(
          "N31",
          BODIES[1] as string,
          {
            kind: "elements" as const,
            anchors: [
              headingTarget("overview-heading", "Overview").anchor,
              headingTarget("details-heading", "Details").anchor,
            ],
          },
          "change",
        ),
      ],
      rounds: [],
      agentNotes: [],
    }
    const o = await open({ pairing: LIVE, pageState: two })
    const sheet = await openSheet(o)
    const rows = sheet.getByRole("listitem")
    const seededIntents = two.drafts.map((note) => note.intent)
    const facts = await rows.evaluateAll(
      (els, intents) =>
        els.map((el, i) => {
          const frame = el.querySelector(".frame") as HTMLElement
          const edge = el.querySelector(".frame .edge") as HTMLElement
          const probe = document.createElement("i")
          probe.style.background = `var(--${intents[i]})`
          frame.append(probe)
          const colour = getComputedStyle(probe).backgroundColor
          probe.remove()
          return {
            width: frame.offsetWidth,
            height: frame.offsetHeight,
            number: el.querySelector(".fn")?.textContent,
            multi: el.querySelector(".multi")?.textContent ?? null,
            intent: el.querySelector(".it")?.textContent,
            text: el.querySelector(".txt")?.textContent,
            target: el.querySelector(".tgt")?.textContent,
            edgeIsIntentColour: getComputedStyle(edge).backgroundColor === colour,
            colour,
          }
        }),
      seededIntents,
    )
    expect(facts.map(({ colour: _colour, ...rest }) => rest)).toEqual([
      {
        width: 120,
        height: 76,
        number: "01",
        multi: null,
        intent: "Fix",
        text: BODIES[0],
        target: "element “Overview”",
        edgeIsIntentColour: true,
      },
      {
        width: 120,
        height: 76,
        number: "02",
        multi: "×2",
        intent: "Change",
        text: BODIES[1],
        target: "element “Overview” ×2",
        edgeIsIntentColour: true,
      },
    ])
    expect(facts[0]?.colour).not.toBe(facts[1]?.colour)
  }, 30_000)

  test("Alt+ArrowUp at the top and Alt+ArrowDown at the bottom change nothing, and the sheet, the request and the round agree", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE })
    const sheet = await openSheet(o)
    const rows = sheet.getByRole("listitem")

    await o.page.keyboard.press("j")
    await o.page.keyboard.press("Alt+ArrowUp")
    await o.page.keyboard.press("Alt+ArrowDown")
    await until("N30 to move down", async () => (await noteIds(rows)).join() === "N31,N30,N32")
    await o.page.keyboard.press("Alt+ArrowDown")
    await until(
      "N30 to reach the bottom",
      async () => (await noteIds(rows)).join() === "N31,N32,N30",
    )
    await o.page.keyboard.press("Alt+ArrowDown")
    await o.page.keyboard.press("k")
    await until(
      "k to move focus up",
      async () => (await rows.nth(1).getAttribute("aria-current")) === "true",
    )
    expect(await noteIds(rows)).toEqual(["N31", "N32", "N30"])

    const shown = await noteIds(rows)
    await sheet.getByRole("button", { name: "Send round" }).click()
    await until("the round to arrive", () => o.mock.rounds().length === 1)
    expect(o.mock.rounds()[0]?.notes.map((note) => String(note.id))).toEqual(shown)
    expect(sends(o)[0]?.body).toMatchObject({ noteIds: shown })
  }, 30_000)

  test("j and k scroll the page to the element each note points at", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE })
    await o.page.addStyleTag({ content: "main section { min-height: 1400px }" })
    await openSheet(o)
    const viewport = o.page.viewportSize()
    if (!viewport) throw new Error("the page has no viewport")
    const centred = (selector: string) => async () => {
      const box = await o.page.locator(selector).boundingBox()
      return box !== null && Math.abs(box.y + box.height / 2 - viewport.height / 2) < 40
    }

    await o.page.keyboard.press("j")
    await o.page.keyboard.press("j")
    await until("the details heading centred", centred("#details-heading"))
    await o.page.keyboard.press("j")
    await until("the notes heading centred", centred("#notes-heading"))
    await o.page.keyboard.press("k")
    await until("the details heading centred again", centred("#details-heading"))
  }, 30_000)

  test("E, Enter and the Edit button open the right note for editing", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE })
    const sheet = await openSheet(o)
    const box = o.overlay.getByRole("textbox", { name: "Note" })

    await o.page.keyboard.press("j")
    await o.page.keyboard.press("j")
    await o.page.keyboard.press("e")
    await until("the composer on note 2", () => box.isVisible())
    expect(await box.inputValue()).toBe(BODIES[1] as string)
    await o.page.keyboard.press("Escape")
    await until("the composer to close", async () => !(await box.isVisible()))

    await o.page.evaluate(() => {
      const active = document.querySelector("iter8-overlay")?.shadowRoot?.activeElement
      if (active instanceof HTMLElement) active.blur()
    })
    await o.page.keyboard.press("Enter")
    await until("the composer on note 2 again", () => box.isVisible())
    expect(await box.inputValue()).toBe(BODIES[1] as string)
    await o.page.keyboard.press("Escape")
    await until("the composer to close again", async () => !(await box.isVisible()))

    await sheet.getByRole("button", { name: "Edit note 3" }).click()
    await until("the composer on note 3", () => box.isVisible())
    expect(await box.inputValue()).toBe(BODIES[2] as string)
  }, 30_000)

  test("Undo after a delete creates the note again with the same body, a new id and its old place", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE })
    const sheet = await openSheet(o)
    await sheet.getByRole("button", { name: "Delete note 2" }).click()
    await until("the row to go", async () => (await sheet.getByRole("listitem").count()) === 2)
    await o.overlay.getByRole("button", { name: "Undo" }).click()
    await until("the note to come back", () => o.mock.draft().length === 3)

    const restored = o.mock.draft().find((note) => note.body === BODIES[1])
    expect(restored).toBeDefined()
    expect(restored?.id).not.toBe("N31")
    expect(restored?.intent).toBe("fix")
    expect(restored?.target).toEqual(draft("N31", "", TARGETS[1]).target)
    const created = o.mock
      .requests()
      .filter(
        (request) => request.method === "POST" && request.path === OVERLAY_ROUTES.createDraft.path,
      )
    expect(created.map((request) => (request.body as { body: string }).body)).toEqual([
      BODIES[1] as string,
    ])
    await until(
      "the row back in its place",
      async () => (await rowOrder(sheet.getByRole("listitem"))).join() === "0,1,2",
    )
  }, 30_000)

  test("the footer says whether Send wakes the session now or waits for the next prompt", async () => {
    const armed = await open({ pairing: LIVE, pageState: THREE })
    const first = await openSheet(armed)
    expect(await first.locator(".sh-f").innerText()).toContain("Wakes larkspur now")
    await armed.close()
    opened = null

    const waiting = await open({ pairing: { ...LIVE, listener: "none" }, pageState: THREE })
    const second = await openSheet(waiting)
    expect(await second.locator(".sh-f").innerText()).toContain(
      "Queued until your next prompt in larkspur",
    )
  }, 30_000)

  test("a session that ends while the sheet is open disables Send at once, and a new pairing enables it", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE })
    const sheet = await openSheet(o)
    const send = sheet.getByRole("button", { name: "Send round" })
    expect(await send.isEnabled()).toBe(true)

    await pushUntil(o, { type: "pairing", pairing: GONE }, () =>
      sheet.getByRole("heading", { name: "Session ended" }).isVisible(),
    )
    expect(await send.isDisabled()).toBe(true)
    await send.click({ force: true, timeout: 1000 }).catch(() => {})

    await pushUntil(o, { type: "pairing", pairing: null }, () =>
      sheet.getByRole("heading", { name: "Not attached" }).isVisible(),
    )
    expect(await send.isDisabled()).toBe(true)
    await send.click({ force: true, timeout: 1000 }).catch(() => {})
    expect(sends(o)).toHaveLength(0)

    await pushUntil(
      o,
      { type: "pairing", pairing: Pairing.parse({ ...pairingJson, generation: 3 }) },
      () => send.isEnabled(),
    )
    expect(sends(o)).toHaveLength(0)
  }, 30_000)
})

const CODEX = LiveSession.parse({
  ...liveSessionJson,
  owner: "own_codex0001",
  agent: "codex",
  cwd: "/home/biruk/dev/orchid",
  state: { status: "live" },
})
const renumbered = (round: Round, id: string, owner: string | null, first: number) =>
  Round.parse({
    ...round,
    id,
    owner,
    notes: round.notes.map((note, i) => ({ ...note, id: `N${first + i}` })),
  })
const OLDEST = renumbered(FINISHED, "R3", CODEX.owner, 40)
const STRANGER = renumbered(ORPHANED, "R11", "own_stranger01", 50)
const NEWEST = renumbered(FINISHED, "R12", LIVE.owner, 60)
const COMPARABLE = Round.parse({
  ...FINISHED,
  notes: FINISHED.notes.map((note, i) =>
    i === 0 ? { ...note, target: headingTarget("overview-heading", "Overview") } : note,
  ),
})

describe("round sheet: history in detail", () => {
  test("rounds sit newest first, each headed by its own owner, outcome, ticks and send time", async () => {
    const o = await open({
      pairing: LIVE,
      liveSessions: [CODEX],
      pageState: { drafts: [], rounds: [OLDEST, STRANGER, NEWEST], agentNotes: [] },
    })
    const sheet = await openSheet(o, "history")
    const headers = await sheet.locator(".round").evaluateAll((els) =>
      els.map((el) => ({
        title: el.querySelector("h3")?.textContent,
        outcome: el.querySelector(".out")?.getAttribute("aria-label"),
        ticks: [...el.querySelectorAll(".ticks i")].map((tick) => tick.className),
        name: el.querySelector(".rh2 b")?.textContent,
        where: [...el.querySelectorAll(".rh2 > span:not(.av):not(.mono)")].map(
          (span) => span.textContent,
        ),
        time: el.querySelector(".rh2 .mono")?.textContent,
        avatar: el.querySelector(".rh2 .av")?.className,
      })),
    )
    const sentAt = await clockTime(o, "2026-10-09T18:34:00.000Z")
    const strangerAt = await clockTime(o, "2026-10-09T18:20:00.000Z")
    expect(headers).toEqual([
      {
        title: "Round 12",
        outcome: "All 2 resolved",
        ticks: ["done", "answered"],
        name: "Claude",
        where: ["in larkspur"],
        time: `· ${sentAt}`,
        avatar: "av claude",
      },
      {
        title: "Round 11",
        outcome: "Not delivered",
        ticks: ["failed"],
        name: "Agent",
        where: [],
        time: `· ${strangerAt}`,
        avatar: "av agent",
      },
      {
        title: "Round 3",
        outcome: "All 2 resolved",
        ticks: ["done", "answered"],
        name: "codex",
        where: ["in orchid"],
        time: `· ${sentAt}`,
        avatar: "av agent",
      },
    ])
    const sections = await sheet
      .locator(".round")
      .evaluateAll((els) => els.map((el) => el.querySelectorAll("article").length))
    expect(sections).toEqual([2, 1, 2])
  }, 30_000)

  test("each note names its target, adds the resolved source file, and leaves it out when there is none", async () => {
    const [first, second] = FINISHED.notes
    if (!first || !second?.capture) throw new Error("the fixture round changed")
    const unresolved = {
      ...second,
      id: "N14",
      capture: { ...second.capture, sourceLead: { confidence: "none", reason: "no-framework" } },
    }
    const round = Round.parse({ ...FINISHED, notes: [first, second, unresolved] })
    const o = await open({
      pairing: LIVE,
      pageState: { drafts: [], rounds: [round], agentNotes: [] },
    })
    const sheet = await openSheet(o, "history")
    const prov = await sheet
      .locator("article .prov")
      .evaluateAll((els) => els.map((el) => el.textContent))
    expect(prov).toEqual([
      "article “Pro plan”·PricingCard.tsx",
      "region 1440×320·PlanCard.vue",
      "region 1440×320",
    ])
  }, 30_000)

  test("a film-strip frame scrolls History to its note", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: { drafts: [], rounds: [FINISHED], agentNotes: [] },
    })
    await o.page.setViewportSize({ width: 1280, height: 330 })
    const sheet = await openSheet(o, "history")
    const body = sheet.locator(".sh-b")
    const second = sheet.locator("#hn-R12-N13")
    const inView = async () => {
      const [outer, inner] = [await body.boundingBox(), await second.boundingBox()]
      if (!outer || !inner) return false
      const visible =
        Math.min(outer.y + outer.height, inner.y + inner.height) - Math.max(outer.y, inner.y)
      return visible >= 40
    }
    expect(await inView()).toBe(false)
    await sheet.getByRole("button", { name: "Note 2" }).click()
    await until("note 2 to scroll into view", inView)
  }, 30_000)

  test("Before / after is offered only for a finished note that has a screenshot", async () => {
    const queued = await open({
      pairing: LIVE,
      pageState: { drafts: [], rounds: [OPEN_ROUND], agentNotes: [] },
    })
    const waiting = await openSheet(queued, "history")
    await until("the round", () => waiting.getByRole("article").first().isVisible())
    expect(await waiting.getByRole("button", { name: "Before / after" }).count()).toBe(0)
    await queued.close()
    opened = null

    const finished = await open({
      pairing: LIVE,
      pageState: { drafts: [], rounds: [FINISHED], agentNotes: [] },
    })
    const done = await openSheet(finished, "history")
    await until("the round", () => done.getByRole("article").first().isVisible())
    const buttons = done.getByRole("button", { name: "Before / after" })
    expect(await buttons.count()).toBe(1)
    expect(
      await done
        .getByRole("article")
        .filter({ hasText: "The price wraps" })
        .getByRole("button", { name: "Before / after" })
        .count(),
    ).toBe(1)
  }, 30_000)

  test("the comparison shows the stored shot as Before and a fresh crop of the element as After", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: { drafts: [], rounds: [COMPARABLE], agentNotes: [] },
    })
    await serveScreenshot(o)
    const sheet = await openSheet(o, "history")
    const toggle = sheet.getByRole("button", { name: "Before / after" })
    const size = (layer: string) =>
      sheet
        .locator(`.compare .lay.${layer} img`)
        .evaluate((img) =>
          img instanceof HTMLImageElement ? [img.naturalWidth, img.naturalHeight] : [],
        )

    await toggle.click()
    await until("both images", async () => {
      const [before, after] = [
        await size("before").catch(() => []),
        await size("after").catch(() => []),
      ]
      return before.length === 2 && before[0] === 1 && after.length === 2 && (after[0] ?? 0) > 1
    })
    const first = await size("after")
    expect(await sheet.locator(".compare .lay.before img").getAttribute("src")).toMatch(/^blob:/)

    await sheet.getByRole("button", { name: "Hide compare" }).click()
    await o.page.evaluate(() => {
      const heading = document.querySelector("#overview-heading") as HTMLElement
      heading.style.fontSize = "64px"
    })
    await toggle.click()
    await until("a new crop of the changed element", async () => {
      const again = await size("after").catch(() => [])
      return again.length === 2 && again[1] !== first[1]
    })
  }, 30_000)

  test("a note whose element is gone says so in the comparison", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: { drafts: [], rounds: [FINISHED], agentNotes: [] },
    })
    await serveScreenshot(o)
    const sheet = await openSheet(o, "history")
    await sheet.getByRole("button", { name: "Before / after" }).click()
    await until("the lost-element copy", () =>
      sheet.locator(".compare .lay.after").getByText("Element not on the page").isVisible(),
    )
  }, 30_000)

  test("the slider stops at both ends, and the split follows it and a click", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: { drafts: [], rounds: [FINISHED], agentNotes: [] },
    })
    await serveScreenshot(o)
    const sheet = await openSheet(o, "history")
    await sheet.getByRole("button", { name: "Before / after" }).click()
    const slider = sheet.getByRole("slider", { name: "Compare before and after" })
    const compare = sheet.locator(".compare")
    const split = async () => {
      const [frame, bar] = [
        await compare.boundingBox(),
        await sheet.locator(".compare .bar").boundingBox(),
      ]
      if (!frame || !bar) return Number.NaN
      return (bar.x + bar.width / 2 - frame.x) / frame.width
    }

    await slider.focus()
    expect(await split()).toBeCloseTo(0.5, 1)
    await slider.press("ArrowRight")
    await until("the split to move right", async () => Math.abs((await split()) - 0.55) < 0.01)
    for (let i = 0; i < 25; i++) await slider.press("ArrowRight")
    expect(await slider.inputValue()).toBe("100")
    await until("the split at the right end", async () => Math.abs((await split()) - 1) < 0.01)
    for (let i = 0; i < 25; i++) await slider.press("ArrowLeft")
    expect(await slider.inputValue()).toBe("0")
    await until("the split at the left end", async () => Math.abs(await split()) < 0.01)

    const frame = await compare.boundingBox()
    if (!frame) throw new Error("no compare box")
    await o.page.mouse.click(frame.x + frame.width * 0.25, frame.y + frame.height / 2)
    await until("a click to set the split", async () => Math.abs((await split()) - 0.25) < 0.05)
  }, 30_000)
})
