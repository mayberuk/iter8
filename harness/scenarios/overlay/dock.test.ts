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
import type { Browser, Locator, Route } from "playwright"
import liveSessionJson from "../../../packages/protocol/fixtures/LiveSession.json"
import noteJson from "../../../packages/protocol/fixtures/Note.json"
import goneJson from "../../../packages/protocol/fixtures/Pairing.gone.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import orphanedJson from "../../../packages/protocol/fixtures/Round.orphaned.json"
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
const SEEDED = { drafts: [DRAFT], rounds: [], agentNotes: [] }
const THREE_DRAFTS = {
  drafts: ["N21", "N22", "N23"].map((id) =>
    Note.parse({ ...noteJson, id, pageId: "mockpage", body: `Body of ${id}` }),
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
  return opened
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
    expect(await dock(o.overlay).locator(".stword").innerText()).toBe("ended")
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
    expect(await dock(overlay).locator(".stword").innerText()).toBe("ended")
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
    expect(await dock(overlay).locator(".stword").innerText()).toBe("ended")
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

  test("keys typed into a page field are left to the page", async () => {
    const { overlay, page } = await open({ pairing: LIVE })
    await page.locator("#title").focus()
    await page.keyboard.type("cp")
    expect(await page.locator("#title").inputValue()).toBe("cp")
    expect(await pickPressed(overlay)).toBe("false")
    expect(await overlay.getByRole("status").filter({ hasText: "Pins" }).count()).toBe(0)
  }, 30_000)
})
