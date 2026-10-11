import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import {
  ASSET_PREFIX,
  LIVE_PATH,
  LiveSession,
  Note,
  OVERLAY_PREFIX,
  OVERLAY_ROUTES,
  Pairing,
  PROTOCOL_VERSION,
  Round,
  TOKEN_HEADER,
} from "@iter8/protocol"
import type { Browser, Locator, Page, Route } from "playwright"
import liveSessionJson from "../../../packages/protocol/fixtures/LiveSession.json"
import noteJson from "../../../packages/protocol/fixtures/Note.json"
import goneJson from "../../../packages/protocol/fixtures/Pairing.gone.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import orphanedJson from "../../../packages/protocol/fixtures/Round.orphaned.json"
import queuedJson from "../../../packages/protocol/fixtures/Round.queued.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const LIVE = Pairing.parse(pairingJson)
const GONE = Pairing.parse(goneJson)
const OTHER = LiveSession.parse({ ...liveSessionJson, state: { status: "live" } })
const DRAFT = Note.parse({ ...noteJson, pageId: "mockpage" })
const ORPHANED = Round.parse({
  ...orphanedJson,
  pageId: "mockpage",
  notes: orphanedJson.notes.map((note) => ({ ...note, pageId: "mockpage" })),
})
const QUEUED = Round.parse({
  ...queuedJson,
  pageId: "mockpage",
  notes: queuedJson.notes.map((note) => ({ ...note, pageId: "mockpage" })),
})
const QUEUED_THEN_ORPHANED = Round.parse({ ...QUEUED, state: orphanedJson.state })
const SEEDED = { drafts: [DRAFT], rounds: [], agentNotes: [] }
const FIXTURE_HEADINGS = [
  { id: "overview-heading", text: "Overview" },
  { id: "details-heading", text: "Details" },
  { id: "notes-heading", text: "Notes" },
]
const THREE_DRAFTS = {
  drafts: ["N21", "N22", "N23"].map((id, i) =>
    Note.parse({
      ...noteJson,
      id,
      pageId: "mockpage",
      body: `Body of ${id}`,
      target: {
        kind: "element",
        anchor: {
          selector: [`#${FIXTURE_HEADINGS[i]?.id}`],
          role: "heading",
          text: FIXTURE_HEADINGS[i]?.text,
          box: { x: 0, y: 0, width: 100, height: 30 },
          renderGeneration: 0,
        },
      },
      capture: undefined,
    }),
  ),
  rounds: [],
  agentNotes: [],
}
const PUT_DRAFT = new RegExp(`${OVERLAY_ROUTES.putDraft.path.replace(":noteId", "[^/]+")}$`)

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
  await dockAtRest(opened.page)
  return opened
}

/** Playwright's stability check passes on the first frames of a compositor animation, which still show the old box. */
function dockAtRest(page: Page) {
  return waitFor(
    "the dock to come to rest",
    () =>
      page.evaluate(() => {
        const root = document.querySelector("iter8-overlay")?.shadowRoot
        const moving = [root?.querySelector(".dock"), root?.querySelector(".iter8btn")].some(
          (el) => !el || el.getAnimations().some((a) => a.playState !== "finished"),
        )
        return moving ? null : true
      }),
    { timeoutMs: 5000, everyMs: 100 },
  )
}

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

const PROBE_FAILURE = {
  type: "upstream-failure",
  port: 5173,
  url: "http://localhost:5173/src/main.tsx",
} as const
const probeNotice = (overlay: Locator) =>
  overlay.getByRole("status").filter({
    hasText: "A request to port 5173 failed — that port isn't reachable from this page",
  })

/** A pushed message reaches only an open socket, so push one with a visible effect until it lands. */
async function socketOpen(o: Awaited<ReturnType<typeof open>>) {
  await waitFor(
    "the live socket",
    async () => {
      o.mock.push(PROBE_FAILURE)
      return (await probeNotice(o.overlay).isVisible()) ? true : null
    },
    { timeoutMs: 5000, everyMs: 100 },
  )
}

const dock = (overlay: Locator) => overlay.getByRole("toolbar", { name: "iter8 annotation tools" })
const sendButton = (overlay: Locator) =>
  dock(overlay).getByRole("button", { name: /^(Send|Queue)$/ })
const draftCount = (overlay: Locator) => dock(overlay).locator(".counter .n").innerText()

describe("dock session states", () => {
  test("a live session shows its name and where, and Send is enabled", async () => {
    const { overlay, mock } = await open({ pairing: LIVE, pageState: SEEDED })
    const text = await dock(overlay).innerText()
    expect(text).toContain("larkspur")
    expect(text).toContain(`mock-machine:${mock.port}`)
    expect(await sendButton(overlay).innerText()).toBe("Send")
    expect(await sendButton(overlay).isEnabled()).toBe(true)
  }, 30_000)

  test("a busy session queues instead of sending and shows the busy chip", async () => {
    const { overlay } = await open({
      pairing: { ...LIVE, state: { status: "busy" } },
      pageState: SEEDED,
    })
    expect(await sendButton(overlay).innerText()).toBe("Queue")
    expect(await sendButton(overlay).isEnabled()).toBe(true)
    expect(await dock(overlay).locator(".stword").innerText()).toBe("busy")
  }, 30_000)

  test("a session that turns busy relabels Send as Queue and says when it delivers", async () => {
    const o = await open({ pairing: LIVE, pageState: SEEDED })
    expect(await sendButton(o.overlay).innerText()).toBe("Send")
    await socketOpen(o)
    const busy = { ...LIVE, state: { status: "busy" } } as const
    o.mock.setPairing(busy)
    o.mock.push({ type: "pairing", pairing: busy })
    await until(
      "the Queue label",
      async () => (await sendButton(o.overlay).innerText()) === "Queue",
    )
    expect(await dock(o.overlay).locator(".stword").innerText()).toBe("busy")
    await dockAtRest(o.page)
    await sendButton(o.overlay).hover()
    const tip = o.overlay.getByRole("tooltip")
    await until("the queue tooltip", () => tip.isVisible())
    expect(await tip.innerText()).toBe("Delivers when larkspur’s turn ends")
  }, 30_000)

  test("a session that ends while the page is open disables Send before any Send is tried", async () => {
    const o = await open({ pairing: LIVE, liveSessions: [OTHER], pageState: SEEDED })
    expect(await sendButton(o.overlay).isEnabled()).toBe(true)
    await socketOpen(o)
    o.mock.setPairing(GONE)
    o.mock.push({ type: "pairing", pairing: GONE })
    await until("Send to be disabled", () => sendButton(o.overlay).isDisabled())
    expect(await dock(o.overlay).locator(".stword").innerText()).toBe("crashed")
    await until("the session-ended dialog", () =>
      o.overlay.getByRole("dialog", { name: "Session ended" }).isVisible(),
    )
    expect(await draftCount(o.overlay)).toBe("1")
    expect(o.mock.requests().some((request) => request.path === OVERLAY_ROUTES.send.path)).toBe(
      false,
    )
  }, 30_000)

  test("a session with no listener says the round waits for the next prompt", async () => {
    const { overlay } = await open({ pairing: { ...LIVE, listener: "none" }, pageState: SEEDED })
    await sendButton(overlay).hover()
    const tip = overlay.getByRole("tooltip")
    await until("the send tooltip", () => tip.isVisible())
    expect(await tip.innerText()).toBe("Queued until your next prompt in larkspur")
  }, 30_000)

  test("a gone session says ended, offers the other sessions, and reattaches from a row", async () => {
    const { overlay, mock } = await open({
      pairing: GONE,
      liveSessions: [
        {
          owner: GONE.owner,
          agent: GONE.agent,
          process: GONE.process,
          cwd: GONE.cwd,
          state: GONE.state,
        },
        OTHER,
      ],
      pageState: SEEDED,
    })
    expect(await dock(overlay).locator(".stword").innerText()).toBe("crashed")
    expect(await sendButton(overlay).isDisabled()).toBe(true)
    expect(mock.requests().some((request) => request.path === OVERLAY_ROUTES.send.path)).toBe(false)

    const menu = overlay.getByRole("dialog", { name: "Session ended" })
    await until("the session menu to open by itself", () => menu.isVisible())
    const rows = menu.getByRole("button", { name: /^Attach to / })
    await until("the live session rows", async () => (await rows.count()) === 1)
    expect(await rows.getAttribute("aria-label")).toBe("Attach to larkspur")

    await rows.click({ timeout: 5000 })
    await until("Send to come back", () => sendButton(overlay).isEnabled())
    const attaches = mock
      .requests()
      .filter((request) => request.method === "POST" && request.path === OVERLAY_ROUTES.attach.path)
    expect(attaches.map((request) => request.body)).toEqual([{ owner: OTHER.owner }])
    const toast = overlay.getByRole("status").filter({ hasText: /^Attached to larkspur/ })
    await until("the attached toast", () => toast.isVisible())
    expect(await menu.isVisible()).toBe(false)
  }, 30_000)

  test("a refused attach replaces the rows with the service's current list", async () => {
    const { overlay, mock, page } = await open({
      pairing: GONE,
      liveSessions: [OTHER],
      pageState: SEEDED,
    })
    const menu = overlay.getByRole("dialog", { name: "Session ended" })
    const row = menu.getByRole("button", { name: "Attach to larkspur" })
    await until("the row", () => row.isVisible())

    await until("the menu's own session list to arrive", () =>
      page.evaluate(
        (path) =>
          performance
            .getEntriesByType("resource")
            .some((entry) => new URL(entry.name).pathname === path),
        OVERLAY_ROUTES.listSessions.path,
      ),
    )
    mock.setLiveSessions([])
    await row.click({ timeout: 5000 })
    await until("the row to go", async () => (await row.count()) === 0)
    expect(await menu.innerText()).toContain("No other session is running on mock-machine")
    expect(await sendButton(overlay).isDisabled()).toBe(true)
  }, 30_000)

  test("opening the session menu lists the sessions running now", async () => {
    const { overlay, mock } = await open({
      pairing: LIVE,
      liveSessions: [OTHER],
      pageState: SEEDED,
    })
    const started = { ...OTHER, owner: "own_newcomer1", cwd: "/home/biruk/dev/newcomer" }
    mock.setLiveSessions([OTHER, started])
    await dock(overlay)
      .getByRole("button", { name: /^Session larkspur/ })
      .click()
    const menu = overlay.getByRole("dialog", { name: "Send rounds to" })
    await until("the new session's row", () =>
      menu.getByRole("button", { name: "Attach to newcomer" }).isVisible(),
    )
  }, 30_000)

  test("a page with no pairing says not attached and cannot send", async () => {
    const { overlay } = await open({ pairing: null, pageState: SEEDED })
    expect(await dock(overlay).locator(".stword").innerText()).toBe("not attached")
    expect(await sendButton(overlay).isDisabled()).toBe(true)
    const menu = overlay.getByRole("dialog", { name: "Attach this page to a session" })
    await until("the attach menu", () => menu.isVisible())
  }, 30_000)
})

describe("sending a round", () => {
  test("a send refused because the session is gone keeps the drafts and shows gone", async () => {
    const { overlay, mock } = await open({ pairing: LIVE, pageState: SEEDED })
    mock.failNextSend({ outcome: "refused", reason: "session-gone", pairing: GONE })
    await sendButton(overlay).click()
    await until(
      "the gone state",
      async () => (await dock(overlay).locator(".stword").count()) === 1,
    )
    expect(await dock(overlay).locator(".stword").innerText()).toBe("crashed")
    expect(await sendButton(overlay).isDisabled()).toBe(true)
    const why = overlay.getByRole("status").filter({ hasText: /ended/ })
    await until("the reason to be given", () => why.first().isVisible())
    await until("the session menu to open", () =>
      overlay.getByRole("dialog", { name: "Session ended" }).isVisible(),
    )
    expect(mock.draft().map((note) => note.id)).toEqual([DRAFT.id])
    expect(mock.rounds()).toEqual([])
    expect(await draftCount(overlay)).toBe("1")
  }, 30_000)

  test("an accepted send makes one round and empties the draft", async () => {
    const { overlay, mock } = await open({ pairing: LIVE, pageState: SEEDED })
    expect(await draftCount(overlay)).toBe("1")
    await sendButton(overlay).click()
    await until("the draft to empty", async () => (await draftCount(overlay)) === "0")
    expect(mock.rounds().map((round) => round.notes.map((note) => note.id))).toEqual([[DRAFT.id]])
    expect(mock.draft()).toEqual([])
    expect(await dock(overlay).locator(".counter .rl").innerText()).toBe("ROUND 2")
    const delivered = overlay
      .getByRole("status")
      .filter({ hasText: /^Round 1 delivered to larkspur/ })
    await until("the delivered toast", () => delivered.isVisible())
  }, 30_000)

  test("a second press while a send is in flight sends nothing more", async () => {
    const { overlay, mock, page } = await open({ pairing: LIVE, pageState: SEEDED })
    const sends: { idempotencyKey: string }[] = []
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(`**${OVERLAY_ROUTES.send.path}`, async (route) => {
      sends.push(route.request().postDataJSON())
      await held
      await route.continue()
    })
    await sendButton(overlay).click()
    await until("the first request", () => sends.length === 1)
    await sendButton(overlay).click()
    release()
    await until("the round", () => mock.rounds().length === 1)
    await until("the draft to empty", async () => (await draftCount(overlay)) === "0")
    expect(sends.length).toBe(1)
  }, 30_000)

  test("sending again after a lost reply reuses the idempotency key", async () => {
    const { overlay, mock, page } = await open({ pairing: LIVE, pageState: SEEDED })
    const keys: string[] = []
    await page.route(`**${OVERLAY_ROUTES.send.path}`, async (route) => {
      keys.push(route.request().postDataJSON().idempotencyKey)
      if (keys.length === 1) await route.abort()
      else await route.continue()
    })
    await sendButton(overlay).click()
    const failed = overlay.getByRole("status").filter({ hasText: /Couldn.t reach iter8/ })
    await until("the failure to be said", () => failed.isVisible())
    expect(mock.rounds()).toEqual([])
    expect(await draftCount(overlay)).toBe("1")
    await sendButton(overlay).click()
    await until("the round", () => mock.rounds().length === 1)
    expect(keys.length).toBe(2)
    expect(keys[1]).toBe(keys[0])
    const stored = mock
      .rounds()
      .map((round) => ("idempotencyKey" in round.state ? String(round.state.idempotencyKey) : ""))
    expect(stored).toEqual([keys[0] ?? ""])
  }, 30_000)

  test("a round that was never delivered shows a notice", async () => {
    const { overlay } = await open({
      pairing: LIVE,
      pageState: { drafts: [], rounds: [ORPHANED], agentNotes: [] },
    })
    const notice = overlay.getByRole("status").filter({ hasText: "Round 11 wasn't delivered" })
    await until("the not-delivered notice", () => notice.isVisible())
  }, 30_000)

  test("a round that turns orphaned is shown as not delivered, with the live sessions to attach", async () => {
    const o = await open({
      pairing: LIVE,
      liveSessions: [OTHER],
      pageState: { drafts: [], rounds: [], agentNotes: [] },
    })
    await socketOpen(o)
    const notice = o.overlay.getByRole("status").filter({ hasText: "Round 11 wasn't delivered" })
    expect(await notice.count()).toBe(0)
    o.mock.push({ type: "round", round: ORPHANED })
    await until("the not-delivered notice", () => notice.isVisible())
    const toast = o.overlay.getByRole("status").filter({ hasText: /^Round 11 not delivered/ })
    await until("the not-delivered toast", () => toast.isVisible())
    await notice.getByRole("button", { name: "Attach to larkspur" }).click({ timeout: 5000 })
    await until(
      "the attach request",
      () =>
        o.mock
          .requests()
          .filter(
            (request) => request.path === OVERLAY_ROUTES.attach.path && request.method === "POST",
          ).length === 1,
    )
    expect(
      o.mock.requests().find((request) => request.path === OVERLAY_ROUTES.attach.path)?.body,
    ).toEqual({ owner: OTHER.owner })
  }, 30_000)

  test("every overlay request carries the page's token", async () => {
    const { overlay, mock } = await open({ pairing: LIVE, pageState: SEEDED })
    await sendButton(overlay).click()
    await until("the round", () => mock.rounds().length === 1)
    const calls = mock
      .requests()
      .filter(
        (request) =>
          request.path.startsWith(OVERLAY_PREFIX) &&
          !request.path.startsWith(ASSET_PREFIX) &&
          request.path !== LIVE_PATH,
      )
    expect(calls.map((request) => request.path)).toContain(OVERLAY_ROUTES.send.path)
    for (const request of calls) expect(request.headers[TOKEN_HEADER]).toBe(mock.token)
  }, 30_000)
})

describe("connection notices", () => {
  for (const [reason, copy] of [
    [
      "wrong-machine",
      (port: number) =>
        `Port ${port} on this machine isn't the iter8 service that opened this page`,
    ],
    [
      "unknown-page",
      (port: number) =>
        `Port ${port} on this machine isn't the iter8 service that opened this page`,
    ],
    [
      "bad-token",
      (port: number) =>
        `Port ${port} on this machine isn't the iter8 service that opened this page`,
    ],
    ["version-mismatch", () => "iter8 was updated — reload this page"],
  ] as const) {
    test(`a ${reason} hello shows its notice`, async () => {
      const { overlay, mock, page } = await open({ pairing: LIVE })
      await page.route("**/__iter8/hello", (route) =>
        route.fulfill({
          json: {
            outcome: "refused",
            reason,
            expected: { protocolVersion: PROTOCOL_VERSION, machineId: mock.machineId },
          },
        }),
      )
      await page.reload()
      const notice = overlay.getByRole("status").filter({ hasText: copy(mock.port) })
      await until("the refusal notice", () => notice.isVisible())
      if (reason === "version-mismatch") {
        expect(await notice.getByRole("button", { name: "Reload" }).isVisible()).toBe(true)
      }
    }, 30_000)
  }

  test("a draining service is reconnected to with a second hello", async () => {
    const o = await open({ pairing: LIVE })
    await socketOpen(o)
    const hellos = () =>
      o.mock.requests().filter((request) => request.path === OVERLAY_ROUTES.hello.path).length
    expect(hellos()).toBe(1)
    const restarting = o.overlay
      .getByRole("status")
      .filter({ hasText: "iter8 is restarting — reconnecting" })
    o.mock.push({ type: "draining" })
    await until("the restart notice", () => restarting.isVisible())
    await until("a second hello", () => hellos() === 2, 5000)
    await until("the restart notice to clear", async () => (await restarting.count()) === 0)
  }, 30_000)

  test("after a draining reconnect the new socket carries a pairing update to the dock", async () => {
    const o = await open({ pairing: LIVE, pageState: SEEDED })
    await socketOpen(o)
    const hellos = () =>
      o.mock.requests().filter((request) => request.path === OVERLAY_ROUTES.hello.path).length
    o.mock.push({ type: "draining" })
    await until("a second hello", () => hellos() === 2, 5000)
    const busy = { ...LIVE, state: { status: "busy" } } as const
    o.mock.setPairing(busy)
    await waitFor(
      "the pairing update on the new socket",
      async () => {
        o.mock.push({ type: "pairing", pairing: busy })
        return (await sendButton(o.overlay).innerText()) === "Queue" ? true : null
      },
      { timeoutMs: 8000, everyMs: 100 },
    )
    expect(await dock(o.overlay).locator(".stword").innerText()).toBe("busy")
  }, 30_000)

  test("an upstream failure names the port that failed, until dismissed", async () => {
    const o = await open({ pairing: LIVE })
    await socketOpen(o)
    await probeNotice(o.overlay).getByRole("button", { name: "Dismiss" }).click()
    await until("the notice to go", async () => (await probeNotice(o.overlay).count()) === 0)
  }, 30_000)
})

describe("preferences and reload", () => {
  test("choosing a theme applies it and saves it", async () => {
    const { overlay, mock } = await open({ pairing: LIVE })
    await dock(overlay).getByRole("button", { name: "More options" }).click()
    const themes = overlay.getByRole("radiogroup", { name: "Theme" })
    expect(await themes.getByRole("radio").evaluateAll((radios) => radios.length)).toBe(3)
    for (const name of ["Auto", "Light", "Dark"]) {
      expect(await themes.getByRole("radio", { name }).count()).toBe(1)
    }
    expect(await themes.getByRole("radio", { name: "Auto" }).isChecked()).toBe(true)
    await themes.locator("label").filter({ hasText: "Dark" }).click()
    expect(await themes.getByRole("radio", { name: "Dark" }).isChecked()).toBe(true)
    await until(
      "the dark theme",
      async () => (await overlay.locator(".root").getAttribute("data-theme")) === "dark",
    )
    await until("the saved theme", () => mock.prefs().theme === "dark")
  }, 30_000)

  test("dragging the dock to the top right saves that anchor", async () => {
    const { overlay, mock, page } = await open({ pairing: LIVE })
    const grip = dock(overlay).getByRole("button", { name: /^Session larkspur/ })
    const box = await grip.boundingBox()
    const viewport = page.viewportSize()
    if (!box || !viewport) throw new Error("the grip has no box")
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(viewport.width - 200, 40, { steps: 12 })
    await page.mouse.up()
    await until("the saved anchor", () => mock.prefs().dock === "tr")
    expect(mock.requests().some((request) => request.path === OVERLAY_ROUTES.attach.path)).toBe(
      false,
    )
  }, 30_000)

  test("a reload message while idle reloads the page and keeps the drafts", async () => {
    const o = await open({ pairing: LIVE, pageState: SEEDED })
    await socketOpen(o)
    await o.page.evaluate(() => document.body.setAttribute("data-before-reload", ""))
    const loaded = o.page.waitForEvent("load", { timeout: 5000 })
    o.mock.push({ type: "reload" })
    await loaded
    await until("the dock after reload", () =>
      o.overlay.getByRole("button", { name: "Pick element" }).isVisible(),
    )
    expect(await o.page.evaluate(() => document.body.hasAttribute("data-before-reload"))).toBe(
      false,
    )
    expect(await draftCount(o.overlay)).toBe("1")
  }, 30_000)
})

describe("reload with unsaved draft writes", () => {
  /** Opens the round sheet, focuses the second draft, switches its intent to Change and saves it. */
  async function editSecondDraft(o: Awaited<ReturnType<typeof open>>) {
    await o.page.keyboard.press("r")
    await o.page.keyboard.press("j")
    await o.page.keyboard.press("j")
    await o.page.keyboard.press("e")
    await o.page.keyboard.press("2")
    await o.page.keyboard.press("Control+Enter")
  }

  async function reloadWhileWriteHeld(
    o: Awaited<ReturnType<typeof open>>,
    answer: (route: Route, release: Promise<void>) => Promise<void>,
  ) {
    await socketOpen(o)
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const writes: string[] = []
    await o.page.route(PUT_DRAFT, async (route) => {
      writes.push(new URL(route.request().url()).pathname)
      await answer(route, released)
    })
    let loads = 0
    o.page.on("load", () => {
      loads += 1
    })
    await o.page.evaluate(() => document.body.setAttribute("data-before-reload", ""))
    await editSecondDraft(o)
    await until("the held write", () => writes.length === 1)
    o.mock.push({ type: "reload" })
    o.mock.push({ type: "upstream-failure", port: 4321, url: "http://localhost:4321/" })
    const after = o.overlay.getByRole("status").filter({ hasText: "A request to port 4321 failed" })
    await until("the message after reload to arrive", () => after.isVisible())
    return { release, writes, loads: () => loads }
  }

  const intents = (mock: Awaited<ReturnType<typeof open>>["mock"]) =>
    mock.draft().map((note) => [String(note.id), String(note.intent)])

  test("a reload waits for a held draft write and the reloaded page has every draft as edited", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE_DRAFTS })
    expect(await draftCount(o.overlay)).toBe("3")
    const held = await reloadWhileWriteHeld(o, async (route, released) => {
      await released
      await route.continue()
    })
    expect(held.writes).toEqual([`${OVERLAY_PREFIX}/drafts/N22`])
    expect(held.loads()).toBe(0)
    expect(await o.page.evaluate(() => document.body.hasAttribute("data-before-reload"))).toBe(true)
    expect(intents(o.mock)).toEqual([
      ["N21", "fix"],
      ["N22", "fix"],
      ["N23", "fix"],
    ])

    const loaded = o.page.waitForEvent("load", { timeout: 5000 })
    held.release()
    await loaded
    expect(intents(o.mock)).toEqual([
      ["N21", "fix"],
      ["N22", "change"],
      ["N23", "fix"],
    ])
    await until("the dock after reload", () =>
      o.overlay.getByRole("button", { name: "Pick element" }).isVisible(),
    )
    expect(await o.page.evaluate(() => document.body.hasAttribute("data-before-reload"))).toBe(
      false,
    )
    expect(await draftCount(o.overlay)).toBe("3")
    expect(o.mock.draft().map((note) => note.body)).toEqual([
      "Body of N21",
      "Body of N22",
      "Body of N23",
    ])
  }, 30_000)

  test("a draft write that fails keeps the page, the drafts and says so instead of reloading", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE_DRAFTS })
    const held = await reloadWhileWriteHeld(o, async (route, released) => {
      await released
      await route.fulfill({ status: 500 })
    })
    expect(held.loads()).toBe(0)
    held.release()
    const why = o.overlay.getByRole("status").filter({ hasText: /didn.t save/ })
    await until("the failure to be said", () => why.isVisible())
    expect(held.loads()).toBe(0)
    expect(await o.page.evaluate(() => document.body.hasAttribute("data-before-reload"))).toBe(true)
    expect(await draftCount(o.overlay)).toBe("3")
    expect(o.mock.draft().length).toBe(3)
  }, 30_000)
})

describe("refused sends", () => {
  const DRAFT_IDS = THREE_DRAFTS.drafts.map((note) => note.id)

  test("a stale-generation refusal keeps every draft in order, says why, and the next send uses the new generation", async () => {
    const { overlay, mock } = await open({ pairing: LIVE, pageState: THREE_DRAFTS })
    const moved = { ...LIVE, generation: LIVE.generation + 1 }
    mock.setPairing(moved)
    mock.failNextSend({ outcome: "refused", reason: "stale-generation", pairing: moved })
    await sendButton(overlay).click()
    const why = overlay.getByRole("status").filter({ hasText: /attached to another session/ })
    await until("the reason", () => why.isVisible())
    expect(mock.rounds()).toEqual([])
    expect(mock.draft().map((note) => note.id)).toEqual(DRAFT_IDS)
    expect(mock.draft().map((note) => note.body)).toEqual(THREE_DRAFTS.drafts.map((n) => n.body))
    expect(await draftCount(overlay)).toBe("3")
    expect(await sendButton(overlay).isEnabled()).toBe(true)

    await sendButton(overlay).click()
    await until("the round", () => mock.rounds().length === 1)
    const sends = mock.requests().filter((request) => request.path === OVERLAY_ROUTES.send.path)
    expect(sends.at(-1)?.body).toMatchObject({ noteIds: DRAFT_IDS, generation: moved.generation })
  }, 30_000)

  test("a no-pairing refusal keeps every draft in order, says why, and asks for a session", async () => {
    const { overlay, mock } = await open({
      pairing: LIVE,
      liveSessions: [OTHER],
      pageState: THREE_DRAFTS,
    })
    mock.setPairing(null)
    await sendButton(overlay).click()
    const why = overlay.getByRole("status").filter({ hasText: /isn.t attached to a session/ })
    await until("the reason", () => why.isVisible())
    expect(await dock(overlay).locator(".stword").innerText()).toBe("not attached")
    expect(await sendButton(overlay).isDisabled()).toBe(true)
    await until("the attach dialog", () =>
      overlay.getByRole("dialog", { name: "Attach this page to a session" }).isVisible(),
    )
    expect(mock.rounds()).toEqual([])
    expect(mock.draft().map((note) => note.id)).toEqual(DRAFT_IDS)
    expect(mock.draft().map((note) => note.body)).toEqual(THREE_DRAFTS.drafts.map((n) => n.body))
    expect(await draftCount(overlay)).toBe("3")
  }, 30_000)
})

describe("rounds that change after the page loaded", () => {
  test("a queued round updated to orphaned in place becomes not delivered without a second round", async () => {
    const o = await open({
      pairing: LIVE,
      liveSessions: [OTHER],
      pageState: { drafts: [], rounds: [QUEUED], agentNotes: [] },
    })
    expect(await dock(o.overlay).locator(".counter .rl").innerText()).toBe("ROUND 14")
    const notice = o.overlay.getByRole("status").filter({ hasText: "Round 13 wasn't delivered" })
    expect(await notice.count()).toBe(0)
    await socketOpen(o)
    o.mock.push({ type: "round", round: QUEUED_THEN_ORPHANED })
    await until("the not-delivered notice", () => notice.isVisible())
    await until("the not-delivered toast", () =>
      o.overlay
        .getByRole("status")
        .filter({ hasText: /^Round 13 not delivered/ })
        .isVisible(),
    )
    expect(await dock(o.overlay).locator(".counter .rl").innerText()).toBe("ROUND 14")
    expect(await notice.count()).toBe(1)
  }, 30_000)
})

describe("the connecting and unreachable dock", () => {
  const HELLO = new RegExp(`${OVERLAY_ROUTES.hello.path}$`)

  test("a slow hello shows the connecting dock, then the full dock", async () => {
    const o = await open({ pairing: LIVE, pageState: SEEDED })
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    await o.page.route(HELLO, async (route) => {
      await released
      await route.continue()
    })
    await o.page.reload()
    await until("the connecting dock", () => dock(o.overlay).isVisible())
    expect(await dock(o.overlay).innerText()).toContain(`mock-machine:${o.mock.port}`)
    expect(await dock(o.overlay).getByRole("button", { name: "Pick element" }).count()).toBe(0)
    expect(await sendButton(o.overlay).count()).toBe(0)
    release()
    await until("the full dock", () =>
      dock(o.overlay).getByRole("button", { name: "Pick element" }).isVisible(),
    )
  }, 30_000)

  test("an unreachable first hello says so and recovers on its own", async () => {
    const o = await open({ pairing: LIVE, pageState: SEEDED })
    let attempts = 0
    await o.page.route(HELLO, async (route) => {
      attempts += 1
      if (attempts === 1) await route.abort()
      else await route.continue()
    })
    await o.page.reload()
    const notice = o.overlay
      .getByRole("status")
      .filter({ hasText: "Can't reach the iter8 service — retrying" })
    await until("the unreachable notice", () => notice.isVisible())
    await waitFor(
      "the dock after the retry",
      async () =>
        (await dock(o.overlay).getByRole("button", { name: "Pick element" }).isVisible())
          ? true
          : null,
      { timeoutMs: 10_000 },
    )
    expect(attempts).toBe(2)
    expect(await notice.count()).toBe(0)
  }, 30_000)
})

describe("a reload deferred behind an open note", () => {
  async function openEditor(o: Awaited<ReturnType<typeof open>>) {
    await socketOpen(o)
    await o.page.keyboard.press("r")
    await o.page.keyboard.press("j")
    await o.page.keyboard.press("e")
    await o.page.keyboard.press("2")
    o.mock.push({ type: "reload" })
    const notice = o.overlay.getByRole("status").filter({
      hasText: "This page changed — it reloads when you save or cancel this note",
    })
    await until("the deferral notice", () => notice.isVisible())
  }

  test("cancelling the note reloads the page with the draft untouched", async () => {
    const o = await open({ pairing: LIVE, pageState: SEEDED })
    let loads = 0
    o.page.on("load", () => {
      loads += 1
    })
    await openEditor(o)
    expect(loads).toBe(0)
    const loaded = o.page.waitForEvent("load", { timeout: 5000 })
    await o.page.keyboard.press("Escape")
    await loaded
    await until("the dock after reload", () =>
      o.overlay.getByRole("button", { name: "Pick element" }).isVisible(),
    )
    expect(o.mock.draft().map((note) => note.intent)).toEqual([DRAFT.intent])
    expect(await draftCount(o.overlay)).toBe("1")
  }, 30_000)

  test("saving the note reloads the page only after its write landed", async () => {
    const o = await open({ pairing: LIVE, pageState: SEEDED })
    await openEditor(o)
    const loaded = o.page.waitForEvent("load", { timeout: 5000 })
    await o.page.keyboard.press("Control+Enter")
    await loaded
    expect(o.mock.draft().map((note) => note.intent)).toEqual(["change"])
    await until("the dock after reload", () =>
      o.overlay.getByRole("button", { name: "Pick element" }).isVisible(),
    )
    expect(await draftCount(o.overlay)).toBe("1")
  }, 30_000)
})

describe("session rows and state chips", () => {
  test("rows show avatar, name and process label, disambiguate equal names, and attach the row clicked", async () => {
    const second = {
      ...OTHER,
      owner: "own_second01",
      process: { ...OTHER.process, pid: 51008, label: "second-process-label" },
    }
    const third = {
      ...OTHER,
      owner: "own_third001",
      agent: "codex",
      cwd: "/home/biruk/dev/ledger",
      process: { ...OTHER.process, pid: 51009, label: "third-process-label" },
    }
    const { overlay, mock } = await open({
      pairing: GONE,
      liveSessions: [OTHER, second, third],
      pageState: SEEDED,
    })
    const menu = overlay.getByRole("dialog", { name: "Session ended" })
    const rows = menu.getByRole("button", { name: /^Attach to / })
    await until("three rows", async () => (await rows.count()) === 3)
    const names = await rows.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))
    expect(names).toEqual([
      `Attach to larkspur · ${OTHER.process.label}`,
      "Attach to larkspur · second-process-label",
      "Attach to ledger",
    ])
    expect(await rows.nth(1).innerText()).toContain("second-process-label")
    expect(await rows.nth(0).getByRole("img", { name: "Claude" }).count()).toBe(1)
    expect(await rows.nth(2).getByRole("img", { name: "codex" }).count()).toBe(1)

    await menu.getByRole("button", { name: "Attach to larkspur · second-process-label" }).click()
    await until("Send to come back", () => sendButton(overlay).isEnabled())
    const attaches = mock
      .requests()
      .filter((request) => request.method === "POST" && request.path === OVERLAY_ROUTES.attach.path)
    expect(attaches.map((request) => request.body)).toEqual([{ owner: second.owner }])
  }, 30_000)

  for (const reason of ["ended", "exited", "crashed", "replaced"] as const) {
    test(`a session that is gone because it ${reason} says ${reason}`, async () => {
      const { overlay } = await open({
        pairing: { ...GONE, state: { status: "gone", reason } },
        pageState: SEEDED,
      })
      expect(await dock(overlay).locator(".stword .w").innerText()).toBe(reason)
      expect(await sendButton(overlay).isDisabled()).toBe(true)
    }, 30_000)
  }
})

describe("send tooltips and queued rounds", () => {
  async function tipFor(o: Awaited<ReturnType<typeof open>>) {
    await sendButton(o.overlay).hover()
    const tip = o.overlay.getByRole("tooltip")
    await until("the tooltip", () => tip.isVisible())
    return tip.innerText()
  }

  test("a live session with a listener says it wakes now", async () => {
    const o = await open({ pairing: LIVE, pageState: SEEDED })
    expect(await tipFor(o)).toBe("Wakes larkspur now")
  }, 30_000)

  test("an empty round disables Send and says there is nothing in it yet", async () => {
    const o = await open({ pairing: LIVE })
    expect(await sendButton(o.overlay).isDisabled()).toBe(true)
    expect(await tipFor(o)).toBe("Nothing in this round yet")
  }, 30_000)

  test("a gone session's Send says to reattach", async () => {
    const o = await open({ pairing: GONE, pageState: SEEDED })
    expect(await tipFor(o)).toBe("Session ended — reattach first")
  }, 30_000)

  test("a page with no session's Send says to attach first", async () => {
    const o = await open({ pairing: null, pageState: SEEDED })
    expect(await tipFor(o)).toBe("Attach this page to a session first")
  }, 30_000)

  test("sending to a busy session queues the round and says when it delivers", async () => {
    const o = await open({
      pairing: { ...LIVE, state: { status: "busy" } },
      pageState: SEEDED,
    })
    await sendButton(o.overlay).click()
    await until("the round", () => o.mock.rounds().length === 1)
    const toast = o.overlay
      .getByRole("status")
      .filter({ hasText: /^Round 1 queued.*delivers when larkspur’s turn ends/ })
    await until("the queued toast", () => toast.isVisible())
    expect(await draftCount(o.overlay)).toBe("0")
  }, 30_000)

  test("sending to a session with no listener says it waits for the next prompt", async () => {
    const o = await open({ pairing: { ...LIVE, listener: "none" }, pageState: SEEDED })
    await sendButton(o.overlay).click()
    const toast = o.overlay
      .getByRole("status")
      .filter({ hasText: /^Round 1 queued.*until your next prompt in larkspur/ })
    await until("the queued toast", () => toast.isVisible())
  }, 30_000)

  test("sending again after the drafts changed uses a new idempotency key", async () => {
    const o = await open({ pairing: LIVE, pageState: THREE_DRAFTS })
    const keys: string[] = []
    await o.page.route(`**${OVERLAY_ROUTES.send.path}`, async (route) => {
      keys.push(route.request().postDataJSON().idempotencyKey)
      if (keys.length < 3) await route.abort()
      else await route.continue()
    })
    const failed = o.overlay.getByRole("status").filter({ hasText: /Couldn.t reach iter8/ })
    await sendButton(o.overlay).click()
    await until("the first failure", () => failed.first().isVisible())
    await sendButton(o.overlay).click()
    await until("the second request", () => keys.length === 2)
    expect(keys[1]).toBe(keys[0])
    await o.page.keyboard.press("r")
    await o.page.keyboard.press("j")
    await o.page.keyboard.press("e")
    await o.page.keyboard.press("2")
    await o.page.keyboard.press("Control+Enter")
    await until("the edit to be saved", () => o.mock.draft()[0]?.intent === "change")
    await o.page.keyboard.press("r")
    await sendButton(o.overlay).click()
    await until("the round", () => o.mock.rounds().length === 1)
    expect(keys.length).toBe(3)
    expect(keys[2]).not.toBe(keys[0])
  }, 30_000)
})

describe("the more menu, collapsing and moving the dock", () => {
  const more = (overlay: Locator) => dock(overlay).getByRole("button", { name: "More options" })

  test("choosing Light then Auto applies each theme and saves it", async () => {
    const { overlay, mock } = await open({ pairing: LIVE })
    await more(overlay).click()
    for (const [name, saved] of [
      ["Light", "light"],
      ["Auto", "auto"],
    ] as const) {
      await overlay
        .getByRole("radiogroup", { name: "Theme" })
        .locator("label")
        .filter({ hasText: name })
        .click()
      await until(`the ${saved} theme`, async () => {
        return (
          (await overlay.locator(".root").getAttribute("data-theme")) === saved &&
          mock.prefs().theme === saved
        )
      })
    }
  }, 30_000)

  test("the menu hides and shows the pins and saves the choice", async () => {
    const { overlay, mock } = await open({ pairing: LIVE })
    await more(overlay).click()
    await overlay.getByRole("menuitem", { name: /Hide pins/ }).click()
    await until("pins hidden", () => mock.prefs().pinsVisible === false)
    await more(overlay).click()
    await overlay.getByRole("menuitem", { name: /Show pins/ }).click()
    await until("pins shown", () => mock.prefs().pinsVisible === true)
  }, 30_000)

  test("collapsing leaves a button with the draft count, and expanding restores the dock", async () => {
    const { overlay, mock } = await open({ pairing: LIVE, pageState: THREE_DRAFTS })
    await dock(overlay).getByRole("button", { name: "Collapse dock" }).click()
    await until("the collapsed preference", () => mock.prefs().collapsed === true)
    const expand = overlay.getByRole("button", { name: "Expand iter8 dock" })
    await until("the expand button", () => expand.isVisible())
    expect(await expand.innerText()).toContain("3")
    expect(await dock(overlay).evaluate((el) => (el as HTMLElement).inert)).toBe(true)
    await expand.click()
    await until("the dock", () => dock(overlay).isVisible())
    await until("the expanded preference", () => mock.prefs().collapsed === false)
  }, 30_000)

  async function dragDockBy(
    o: Awaited<ReturnType<typeof open>>,
    to: (
      box: { x: number; y: number; width: number; height: number },
      vw: number,
      vh: number,
    ) => [number, number],
  ) {
    const grip = dock(o.overlay).getByRole("button", { name: /^Session larkspur/ })
    const box = await dock(o.overlay).boundingBox()
    const viewport = o.page.viewportSize()
    if (!box || !viewport) throw new Error("no dock box")
    const [x, y] = to(box, viewport.width, viewport.height)
    const from = await grip.boundingBox()
    if (!from) throw new Error("no grip box")
    const startX = from.x + from.width / 2
    const startY = from.y + from.height / 2
    await o.page.mouse.move(startX, startY)
    await o.page.mouse.down()
    await o.page.mouse.move(startX + (x - box.x), startY + (y - box.y), { steps: 12 })
    await o.page.mouse.up()
    return { x, y, box }
  }

  for (const [anchor, place] of [
    ["tl", (_b: { width: number; height: number }, _w: number, _h: number) => [16, 16]],
    ["tc", (b: { width: number; height: number }, w: number) => [(w - b.width) / 2, 16]],
    [
      "bl",
      (b: { width: number; height: number }, _w: number, h: number) => [16, h - b.height - 16],
    ],
    [
      "ml",
      (b: { width: number; height: number }, _w: number, h: number) => [16, (h - b.height) / 2],
    ],
    [
      "mr",
      (b: { width: number; height: number }, w: number, h: number) => [
        w - b.width - 16,
        (h - b.height) / 2,
      ],
    ],
  ] as const) {
    test(`dragging the dock onto the ${anchor} anchor saves it and settles there`, async () => {
      const o = await open({ pairing: LIVE })
      const { x, y, box } = await dragDockBy(o, (b, w, h) => {
        const [px, py] = place(b, w, h)
        return [px ?? 0, py ?? 0]
      })
      await until("the saved anchor", () => o.mock.prefs().dock === anchor)
      await waitFor(
        "the dock to settle",
        async () => {
          const at = await dock(o.overlay).boundingBox()
          return at && Math.abs(at.x - x) < 2 && Math.abs(at.y - y) < 2 ? true : null
        },
        { timeoutMs: 5000 },
      )
      expect((await dock(o.overlay).boundingBox())?.width).toBeCloseTo(box.width, 0)
    }, 30_000)
  }

  test("a press that moves under the threshold is a click that opens the session menu", async () => {
    const { overlay, mock, page } = await open({ pairing: LIVE })
    const grip = dock(overlay).getByRole("button", { name: /^Session larkspur/ })
    const box = await grip.boundingBox()
    if (!box) throw new Error("no grip box")
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2, { steps: 3 })
    await page.mouse.up()
    await until("the session menu", () =>
      overlay.getByRole("dialog", { name: "Send rounds to" }).isVisible(),
    )
    expect(mock.prefs().dock).toBe("br")
  }, 30_000)

  test("a short drag past the threshold moves nothing and does not open the menu", async () => {
    const { overlay, mock, page } = await open({ pairing: LIVE })
    const grip = dock(overlay).getByRole("button", { name: /^Session larkspur/ })
    const box = await grip.boundingBox()
    if (!box) throw new Error("no grip box")
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2 - 20, { steps: 6 })
    await page.mouse.up()
    await until("the anchor to be saved", () => mock.prefs().dock === "br")
    expect(await overlay.getByRole("dialog", { name: "Send rounds to" }).count()).toBe(0)
  }, 30_000)
})

describe("keyboard shortcuts", () => {
  const pickPressed = (overlay: Locator) =>
    dock(overlay).getByRole("button", { name: "Pick element" }).getAttribute("aria-pressed")

  test("C toggles the pick tool and Escape leaves it", async () => {
    const { overlay, page } = await open({ pairing: LIVE })
    expect(await pickPressed(overlay)).toBe("false")
    await page.keyboard.press("c")
    await until("pick to be on", async () => (await pickPressed(overlay)) === "true")
    await page.keyboard.press("Escape")
    await until("pick to be off", async () => (await pickPressed(overlay)) === "false")
    await page.keyboard.press("c")
    await until("pick to be on again", async () => (await pickPressed(overlay)) === "true")
    await page.keyboard.press("c")
    await until("pick to be off again", async () => (await pickPressed(overlay)) === "false")
  }, 30_000)

  test("P hides the pins and saves that choice", async () => {
    const { overlay, mock, page } = await open({ pairing: LIVE })
    expect(mock.prefs().pinsVisible).toBe(true)
    await page.keyboard.press("p")
    await until("the pins preference", () => mock.prefs().pinsVisible === false)
    const toast = overlay.getByRole("status").filter({ hasText: "Pins hidden" })
    await until("the pins toast", () => toast.isVisible())
  }, 30_000)

  test("S toggles the screenshot tool", async () => {
    const { overlay, page } = await open({ pairing: LIVE })
    const shot = dock(overlay).getByRole("button", { name: "Screenshot" })
    await page.keyboard.press("s")
    await until(
      "screenshot to be on",
      async () => (await shot.getAttribute("aria-pressed")) === "true",
    )
    await page.keyboard.press("s")
    await until(
      "screenshot to be off",
      async () => (await shot.getAttribute("aria-pressed")) === "false",
    )
  }, 30_000)

  test("holding Space peeks and releasing it, or leaving the window, ends the peek", async () => {
    const { overlay, page } = await open({ pairing: LIVE })
    const root = overlay.locator(".root")
    expect((await root.getAttribute("class"))?.split(" ")).not.toContain("peek")
    await page.keyboard.down(" ")
    await until("the peek", async () => ((await root.getAttribute("class")) ?? "").includes("peek"))
    await page.keyboard.up(" ")
    await until(
      "the peek to end",
      async () => !((await root.getAttribute("class")) ?? "").includes("peek"),
    )
    await page.keyboard.down(" ")
    await until("the second peek", async () =>
      ((await root.getAttribute("class")) ?? "").includes("peek"),
    )
    await page.evaluate(() => window.dispatchEvent(new Event("blur")))
    await until(
      "the peek to end on blur",
      async () => !((await root.getAttribute("class")) ?? "").includes("peek"),
    )
  }, 30_000)

  test("keys the overlay does not act on reach the page untouched", async () => {
    const { page } = await open({ pairing: LIVE })
    await page.evaluate(() => {
      window.addEventListener("keydown", (event) => {
        const seen = JSON.parse(document.body.dataset.seen ?? "[]")
        seen.push({ key: event.key, ctrl: event.ctrlKey, prevented: event.defaultPrevented })
        document.body.dataset.seen = JSON.stringify(seen)
      })
    })
    await page.keyboard.press("Control+c")
    await page.keyboard.press("x")
    const seen = (await page.evaluate(() => JSON.parse(document.body.dataset.seen ?? "[]"))) as {
      key: string
      ctrl: boolean
      prevented: boolean
    }[]
    const letters = seen.filter((entry) => entry.key.length === 1)
    expect(letters).toEqual([
      { key: "c", ctrl: true, prevented: false },
      { key: "x", ctrl: false, prevented: false },
    ])
  }, 30_000)

  test("keys typed into a page textarea are left to the page", async () => {
    const { overlay, page } = await open({ pairing: LIVE })
    await page.locator("#notes").focus()
    await page.keyboard.type("sc")
    expect(await page.locator("#notes").inputValue()).toBe("sc")
    expect(
      await dock(overlay).getByRole("button", { name: "Screenshot" }).getAttribute("aria-pressed"),
    ).toBe("false")
    expect(
      await dock(overlay)
        .getByRole("button", { name: "Pick element" })
        .getAttribute("aria-pressed"),
    ).toBe("false")
  }, 30_000)

  test("keys typed into a page field are left to the page", async () => {
    const { overlay, page } = await open({ pairing: LIVE })
    await page.locator("#title").focus()
    await page.keyboard.type("cp")
    expect(await page.locator("#title").inputValue()).toBe("cp")
    expect(await pickPressed(overlay)).toBe("false")
    expect(await overlay.getByRole("status").filter({ hasText: "Pins" }).count()).toBe(0)
  }, 30_000)
})
