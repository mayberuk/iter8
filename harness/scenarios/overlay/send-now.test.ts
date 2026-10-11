import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Note, OVERLAY_ROUTES, OverlayPrefs, Pairing, Round, SendNowResult } from "@iter8/protocol"
import type { Browser, Locator, Route } from "playwright"
import noteJson from "../../../packages/protocol/fixtures/Note.json"
import goneJson from "../../../packages/protocol/fixtures/Pairing.gone.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import roundJson from "../../../packages/protocol/fixtures/Round.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const PAGE = "mockpage"
const LIVE = Pairing.parse(pairingJson)
const GONE = Pairing.parse(goneJson)
const BUSY = Pairing.parse({ ...pairingJson, state: { status: "busy" } })
const SESSION = "larkspur"
const BUSY_LINE = "is mid-turn. This round delivers when its turn ends."
const NOW_LINE = `Send now reaches ${SESSION} after its current step.`
const SENT_NOW_LINE = `Sent now · reaches ${SESSION} after its current step`
const SENT_NOW_AT = "2026-10-09T18:35:00.000Z"
const TOUR_DONE = OverlayPrefs.parse({
  theme: "auto",
  dock: "br",
  collapsed: false,
  pinsVisible: true,
  coachDone: true,
})

const drafts = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    Note.parse({ ...noteJson, id: `N4${i}`, pageId: PAGE, body: `Draft ${i}`, capture: undefined }),
  )
const seed = (count: number) => ({ drafts: drafts(count), rounds: [], agentNotes: [] })

const QUEUED = Round.parse({
  ...roundJson,
  id: "R5",
  pageId: PAGE,
  state: { stage: "queued", queuedAt: "2026-10-09T18:34:00.000Z", idempotencyKey: "send-queued-5" },
  notes: roundJson.notes.map((note) => ({
    ...note,
    pageId: PAGE,
    resolution: { status: "open" },
  })),
})
const roundIn = (id: string, state: object) =>
  Round.parse({
    ...QUEUED,
    id,
    state: { ...QUEUED.state, idempotencyKey: `send-round-${id}`, ...state },
  })
const ANNOUNCED = roundIn("R6", {
  stage: "announced",
  announcedAt: "2026-10-09T18:35:00.000Z",
  generation: 2,
})
const CLAIMED_SENT_NOW = roundIn("R7", {
  stage: "claimed",
  announcedAt: "2026-10-09T18:35:00.000Z",
  generation: 2,
  claimedAt: "2026-10-09T18:36:00.000Z",
  sendNowAt: SENT_NOW_AT,
})
const ANNOUNCED_SENT_NOW = roundIn("R8", {
  stage: "announced",
  announcedAt: "2026-10-09T18:35:00.000Z",
  generation: 2,
  sendNowAt: SENT_NOW_AT,
})
const QUEUED_SENT_NOW = roundIn("R9", { sendNowAt: SENT_NOW_AT })
const QUEUED_TEN = roundIn("R10", {})

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

async function open(mock: NonNullable<Parameters<typeof openOverlay>[0]["mock"]>) {
  opened = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: STATIC,
    mock: { prefs: TOUR_DONE, ...mock },
    browser,
  })
  await until("the dock to be ready", () =>
    opened ? opened.overlay.getByRole("button", { name: "Pick element" }).isVisible() : false,
  )
  return opened
}
type Opened = Awaited<ReturnType<typeof open>>

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

const sheetOf = (o: Opened) => o.overlay.getByRole("complementary", { name: "Round sheet" })

async function openSheet(o: Opened, tab: "round" | "history" = "round"): Promise<Locator> {
  const sheet = sheetOf(o)
  await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
  await until("the round sheet", () => sheet.isVisible())
  if (tab === "history") await sheet.getByRole("tab", { name: /^History/ }).click()
  return sheet
}

const sendRequests = (o: Opened) =>
  o.mock.requests().filter((r) => r.method === "POST" && r.path === OVERLAY_ROUTES.send.path)
const nowPath = (roundId: string) => OVERLAY_ROUTES.sendNow.path.replace(":roundId", roundId)
const nowRequests = (o: Opened) =>
  o.mock.requests().filter((r) => r.method === "POST" && /\/rounds\/R\d+\/now$/.test(r.path))
const toast = (o: Opened, text: RegExp | string) =>
  o.overlay.getByRole("status").filter({ hasText: text })
const outcomeOf = (sheet: Locator, round: string) =>
  sheet.getByRole("region", { name: `Round ${round}` }).locator(".rh .out")
const openPalette = async (o: Opened) => {
  await o.page.keyboard.press("ControlOrMeta+K")
  await until("the palette", () =>
    o.overlay.getByRole("dialog", { name: "Command palette" }).isVisible(),
  )
}
const paletteLabels = (o: Opened) =>
  o.overlay
    .getByRole("dialog", { name: "Command palette" })
    .locator(".pal-i .lb")
    .evaluateAll((els) => els.map((el) => el.firstChild?.textContent ?? ""))

// The mock applies a send-now and pushes the round on arrival, which would remove the button, so
// a held request is parked in the browser, before it reaches the mock.
async function holdNow(o: Opened, roundId: string) {
  const parked: Route[] = []
  await o.page.route(`**${nowPath(roundId)}`, (route) => {
    parked.push(route)
  })
  return {
    parked: () => parked.length,
    release: () => Promise.all(parked.splice(0).map((route) => route.continue().catch(() => {}))),
  }
}

async function answerNow(o: Opened, roundId: string, result: SendNowResult) {
  const body = JSON.stringify(SendNowResult.parse(result))
  const answered = { count: 0 }
  await o.page.route(`**${nowPath(roundId)}`, (route) => {
    answered.count += 1
    return route.fulfill({ status: 200, contentType: "application/json", body })
  })
  return answered
}

async function failNowOnce(o: Opened, roundId: string) {
  const attempts = { count: 0 }
  await o.page.route(`**${nowPath(roundId)}`, (route) => {
    attempts.count += 1
    return attempts.count === 1 ? route.abort() : route.continue()
  })
  return attempts
}

// Playwright reports requests in the order the page issued them, so once the probe is seen
// every request the page made before it has been seen too.
async function settled(o: Opened) {
  await o.page.route("**/__settled", (route) => route.fulfill({ status: 204 }))
  await o.page.evaluate(() => fetch("/__settled"))
}

describe("send now: the round footer", () => {
  test("a busy session with drafts offers Send now beside Queue round, and pressing it sends one round and asks for it now", async () => {
    const o = await open({ pairing: BUSY, pageState: seed(2) })
    const sheet = await openSheet(o)
    const text = await sheet.innerText()
    expect(text).toContain(BUSY_LINE)
    expect(text).toContain(NOW_LINE)
    expect(await sheet.getByRole("button", { name: "Queue round" }).isEnabled()).toBe(true)

    await sheet.getByRole("button", { name: "Send now", exact: true }).click()
    await until("the send-now request", () => nowRequests(o).length === 1)

    expect(sendRequests(o)).toHaveLength(1)
    const [round] = o.mock.rounds()
    expect(o.mock.rounds()).toHaveLength(1)
    expect(nowRequests(o).map((r) => r.path)).toEqual([nowPath(round?.id ?? "")])
    expect(round?.state).toHaveProperty("sendNowAt")
    expect(round?.notes).toHaveLength(2)

    await until("History to say sent now", async () =>
      (await sheet.innerText()).includes(SENT_NOW_LINE),
    )
    expect(await o.overlay.getByRole("button", { name: "Send now", exact: true }).count()).toBe(0)
    expect(sendRequests(o)).toHaveLength(1)
    expect(nowRequests(o)).toHaveLength(1)
  }, 30_000)

  test("Queue round stays the plain queue: one send and no send-now request", async () => {
    const o = await open({ pairing: BUSY, pageState: seed(2) })
    const sheet = await openSheet(o)
    await sheet.getByRole("button", { name: "Queue round" }).click()
    await until("the round", () => o.mock.rounds().length === 1)
    expect(nowRequests(o)).toHaveLength(0)
    expect(o.mock.rounds()[0]?.state).not.toHaveProperty("sendNowAt")
  }, 30_000)

  test("a busy session with no drafts offers no Send now", async () => {
    const o = await open({ pairing: BUSY, pageState: seed(0) })
    const sheet = await openSheet(o)
    expect(await sheet.innerText()).not.toContain(NOW_LINE)
    expect(await sheet.getByRole("button", { name: "Send now", exact: true }).count()).toBe(0)
  }, 30_000)

  test("a session that turns busy and then idle gains and loses the footer's Send now", async () => {
    const o = await open({ pairing: LIVE, pageState: seed(1) })
    const sheet = await openSheet(o)
    const button = sheet.getByRole("button", { name: "Send now", exact: true })
    expect(await button.count()).toBe(0)

    o.mock.setPairing(BUSY)
    await waitFor(
      "Send now to appear",
      async () => {
        o.mock.push({ type: "pairing", pairing: BUSY })
        return (await button.count()) === 1 ? true : null
      },
      { timeoutMs: 5000, everyMs: 100 },
    )

    o.mock.setPairing(LIVE)
    await waitFor(
      "Send now to leave",
      async () => {
        o.mock.push({ type: "pairing", pairing: LIVE })
        return (await button.count()) === 0 ? true : null
      },
      { timeoutMs: 5000, everyMs: 100 },
    )
  }, 30_000)

  test("when the send lands but the send-now request cannot reach the service, the round stays queued and the toast says so", async () => {
    const o = await open({ pairing: BUSY, pageState: seed(1) })
    await o.page.route(`**${nowPath("*")}`, (route) => route.abort())
    const sheet = await openSheet(o)
    await sheet.getByRole("button", { name: "Send now", exact: true }).click()
    await until("the round", () => o.mock.rounds().length === 1)
    const id = o.mock.rounds()[0]?.id ?? ""
    await until("the failure toast", () =>
      toast(o, `Round ${id.slice(1)} queued — couldn't send it now`).isVisible(),
    )
    expect(o.mock.rounds()[0]?.state).toMatchObject({ stage: "queued" })
    expect(o.mock.rounds()[0]?.state).not.toHaveProperty("sendNowAt")
    expect(sendRequests(o)).toHaveLength(1)
    expect(await outcomeOf(sheet, id.slice(1)).innerText()).toBe("Queued")
  }, 30_000)

  test("when the send itself is refused, no send-now request is made", async () => {
    const o = await open({ pairing: BUSY, pageState: seed(1) })
    o.mock.failNextSend({ outcome: "refused", reason: "session-gone", pairing: BUSY })
    const sheet = await openSheet(o)
    await sheet.getByRole("button", { name: "Send now", exact: true }).click()
    await until("the refusal toast", () => toast(o, /ended — attach this page/).isVisible())
    expect(nowRequests(o)).toHaveLength(0)
    expect(o.mock.rounds()).toHaveLength(0)
  }, 30_000)

  test("a send-now the service refuses as not-waiting says the round was already handed over", async () => {
    const o = await open({ pairing: BUSY, pageState: seed(1) })
    o.mock.failNextSendNow("not-waiting")
    const sheet = await openSheet(o)
    await sheet.getByRole("button", { name: "Send now", exact: true }).click()
    await until("the refusal toast", () => toast(o, /already handed to the session/).isVisible())
    expect(o.mock.rounds()[0]?.state).not.toHaveProperty("sendNowAt")
    const id = o.mock.rounds()[0]?.id ?? ""
    expect(await outcomeOf(sheet, id.slice(1)).innerText()).toBe("Queued")
  }, 30_000)

  test("pressing Send now twice in a row makes one round and one send-now request", async () => {
    const o = await open({ pairing: BUSY, pageState: seed(2) })
    const sheet = await openSheet(o)
    const button = sheet.getByRole("button", { name: "Send now", exact: true })
    await button.dblclick()
    await until("the send-now request", () => nowRequests(o).length >= 1)
    expect(sendRequests(o)).toHaveLength(1)
    expect(nowRequests(o)).toHaveLength(1)
    expect(o.mock.rounds()).toHaveLength(1)
  }, 30_000)
})

describe("send now: queued rounds in History", () => {
  test("a queued round while busy shows Send round N now; pressing it sends one request and the button goes away", async () => {
    const o = await open({
      pairing: BUSY,
      pageState: { drafts: [], rounds: [QUEUED], agentNotes: [] },
    })
    const sheet = await openSheet(o, "history")
    const button = sheet.getByRole("button", { name: "Send round 5 now" })
    await until("the History button", () => button.isVisible())
    expect(await sheet.getByRole("button", { name: /Send round \d+ now/ }).count()).toBe(1)

    await button.click()
    await until("the send-now request", () => nowRequests(o).length === 1)
    expect(nowRequests(o).map((r) => r.path)).toEqual([nowPath("R5")])
    expect(sendRequests(o)).toHaveLength(0)
    await until("the button to go away", async () => (await button.count()) === 0)
    expect(await outcomeOf(sheet, "5").innerText()).toBe(SENT_NOW_LINE)
    expect(nowRequests(o)).toHaveLength(1)
  }, 30_000)

  test("the button goes away on the live round update alone", async () => {
    const o = await open({
      pairing: BUSY,
      pageState: { drafts: [], rounds: [QUEUED], agentNotes: [] },
    })
    const sheet = await openSheet(o, "history")
    const button = sheet.getByRole("button", { name: "Send round 5 now" })
    await until("the History button", () => button.isVisible())
    await waitFor(
      "the live update to land",
      async () => {
        o.mock.push({ type: "round", round: roundIn("R5", { sendNowAt: SENT_NOW_AT }) })
        return (await button.count()) === 0 ? true : null
      },
      { timeoutMs: 5000, everyMs: 100 },
    )
    expect(nowRequests(o)).toHaveLength(0)
  }, 30_000)

  test("a failed nudge says so and keeps the button for another try", async () => {
    const o = await open({
      pairing: BUSY,
      pageState: { drafts: [], rounds: [QUEUED], agentNotes: [] },
    })
    await o.page.route(`**${nowPath("R5")}`, (route) => route.abort())
    const sheet = await openSheet(o, "history")
    const button = sheet.getByRole("button", { name: "Send round 5 now" })
    await button.click()
    await until("the failure toast", () => toast(o, "Couldn't send round 5 now").isVisible())
    expect(await button.count()).toBe(1)
    expect(await outcomeOf(sheet, "5").innerText()).toBe("Queued")
  }, 30_000)

  test("pressing a held round's History button again sends no second request", async () => {
    const o = await open({
      pairing: BUSY,
      pageState: { drafts: [], rounds: [QUEUED], agentNotes: [] },
    })
    const held = await holdNow(o, "R5")
    const sheet = await openSheet(o, "history")
    const button = sheet.getByRole("button", { name: "Send round 5 now" })
    await button.click()
    await until("the first send-now request", () => held.parked() === 1)

    await button.click()
    await button.click()
    await settled(o)
    expect(held.parked()).toBe(1)
    expect(nowRequests(o)).toHaveLength(0)

    await held.release()
    await until("the button to go away", async () => (await button.count()) === 0)
    await settled(o)
    expect(nowRequests(o)).toHaveLength(1)
  }, 30_000)

  test("a nudge held for one round does not block another queued round's nudge", async () => {
    const o = await open({
      pairing: BUSY,
      pageState: { drafts: [], rounds: [QUEUED, QUEUED_TEN], agentNotes: [] },
    })
    const heldFive = await holdNow(o, "R5")
    const heldTen = await holdNow(o, "R10")
    const sheet = await openSheet(o, "history")
    const five = sheet.getByRole("button", { name: "Send round 5 now" })
    const ten = sheet.getByRole("button", { name: "Send round 10 now" })
    await five.click()
    await until("round 5's request", () => heldFive.parked() === 1)

    await ten.click()
    await until("round 10's request", () => heldTen.parked() === 1)
    expect(nowRequests(o)).toHaveLength(0)

    await heldFive.release()
    await heldTen.release()
    await until(
      "both buttons to go away",
      async () => (await sheet.getByRole("button", { name: /Send round \d+ now/ }).count()) === 0,
    )
    expect(
      nowRequests(o)
        .map((r) => r.path)
        .sort(),
    ).toEqual([nowPath("R10"), nowPath("R5")].sort())
  }, 30_000)

  test("after a failed nudge the same round's button sends again and the retry lands", async () => {
    const o = await open({
      pairing: BUSY,
      pageState: { drafts: [], rounds: [QUEUED], agentNotes: [] },
    })
    const attempts = await failNowOnce(o, "R5")
    const sheet = await openSheet(o, "history")
    const button = sheet.getByRole("button", { name: "Send round 5 now" })
    await button.click()
    await until("the failure toast", () => toast(o, "Couldn't send round 5 now").isVisible())
    expect(attempts.count).toBe(1)
    expect(nowRequests(o)).toHaveLength(0)

    await button.click()
    await until("the retry to reach the service", () => nowRequests(o).length === 1)
    expect(attempts.count).toBe(2)
    await until("the button to go away", async () => (await button.count()) === 0)
    expect(await outcomeOf(sheet, "5").innerText()).toBe(SENT_NOW_LINE)
    expect(o.mock.rounds()[0]?.state).toHaveProperty("sendNowAt")
  }, 30_000)

  test("a refused nudge also releases the round's guard", async () => {
    const o = await open({
      pairing: BUSY,
      pageState: { drafts: [], rounds: [QUEUED], agentNotes: [] },
    })
    o.mock.failNextSendNow("not-waiting")
    const sheet = await openSheet(o, "history")
    const button = sheet.getByRole("button", { name: "Send round 5 now" })
    await button.click()
    await until("the refusal toast", () => toast(o, /already handed to the session/).isVisible())
    expect(nowRequests(o)).toHaveLength(1)

    await button.click()
    await until("the second request", () => nowRequests(o).length === 2)
    await until("the button to go away", async () => (await button.count()) === 0)
  }, 30_000)

  test("a refused nudge reports the round the service holds", async () => {
    const o = await open({
      pairing: BUSY,
      pageState: { drafts: [], rounds: [QUEUED], agentNotes: [] },
    })
    o.mock.failNextSendNow("not-waiting")
    const sheet = await openSheet(o, "history")
    await sheet.getByRole("button", { name: "Send round 5 now" }).click()
    await until("the refusal toast", () => toast(o, /already handed to the session/).isVisible())
    expect(await outcomeOf(sheet, "5").innerText()).toBe("Queued")
  }, 30_000)

  test("the response's round alone marks the round sent now, with no live push", async () => {
    const o = await open({
      pairing: BUSY,
      pageState: { drafts: [], rounds: [QUEUED], agentNotes: [] },
    })
    const answered = await answerNow(o, "R5", {
      outcome: "accepted",
      round: roundIn("R5", { sendNowAt: SENT_NOW_AT }),
    })
    const sheet = await openSheet(o, "history")
    const button = sheet.getByRole("button", { name: "Send round 5 now" })
    await button.click()
    await until("the response to be applied", async () => (await button.count()) === 0)
    expect(answered.count).toBe(1)
    expect(await outcomeOf(sheet, "5").innerText()).toBe(SENT_NOW_LINE)
    await until("the success toast", () => toast(o, /Round 5 sent now/).isVisible())
    expect(nowRequests(o)).toHaveLength(0)
    expect(o.mock.rounds()[0]?.state).toMatchObject({ stage: "queued" })
    expect(o.mock.rounds()[0]?.state).not.toHaveProperty("sendNowAt")
  }, 30_000)

  test.each([
    { stage: "announced", state: ANNOUNCED.state, outcome: "Delivered" },
    { stage: "claimed", state: CLAIMED_SENT_NOW.state, outcome: "2 in progress" },
  ])(
    "a not-waiting refusal that reports the round as $stage shows that round and the toast",
    async ({ state, outcome }) => {
      const o = await open({
        pairing: BUSY,
        pageState: { drafts: [], rounds: [QUEUED], agentNotes: [] },
      })
      const answered = await answerNow(o, "R5", {
        outcome: "refused",
        reason: "not-waiting",
        round: roundIn("R5", state),
      })
      const sheet = await openSheet(o, "history")
      const button = sheet.getByRole("button", { name: "Send round 5 now" })
      await button.click()
      await until("the refusal toast", () => toast(o, /already handed to the session/).isVisible())
      await until(
        "the reported round",
        async () => (await outcomeOf(sheet, "5").innerText()) === outcome,
      )
      expect(answered.count).toBe(1)
      expect(await button.count()).toBe(0)
      expect(nowRequests(o)).toHaveLength(0)
      expect(o.mock.rounds()[0]?.state).toMatchObject({ stage: "queued" })
    },
    30_000,
  )

  test("only the queued round not yet sent now gets a button, among several rounds", async () => {
    const o = await open({
      pairing: BUSY,
      pageState: {
        drafts: [],
        rounds: [QUEUED, ANNOUNCED, CLAIMED_SENT_NOW, ANNOUNCED_SENT_NOW, QUEUED_SENT_NOW],
        agentNotes: [],
      },
    })
    const sheet = await openSheet(o, "history")
    await until("the History rounds", async () => (await sheet.locator(".round").count()) === 5)
    const names = await sheet
      .getByRole("button", { name: /Send round \d+ now/ })
      .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))
    expect(names).toEqual(["Send round 5 now"])
  }, 30_000)

  test("announced and claimed rounds show no Send now; a claimed round keeps its normal outcome", async () => {
    const o = await open({
      pairing: BUSY,
      pageState: {
        drafts: [],
        rounds: [ANNOUNCED, CLAIMED_SENT_NOW, ANNOUNCED_SENT_NOW],
        agentNotes: [],
      },
    })
    const sheet = await openSheet(o, "history")
    await until("the History rounds", async () => (await sheet.locator(".round").count()) === 3)
    expect(await sheet.getByRole("button", { name: /Send round \d+ now/ }).count()).toBe(0)
    expect(await outcomeOf(sheet, "6").innerText()).toBe("Delivered")
    expect(await outcomeOf(sheet, "7").innerText()).toBe("2 in progress")
    expect(await outcomeOf(sheet, "7").innerText()).not.toContain("Sent now")
    expect(await outcomeOf(sheet, "8").innerText()).toBe(SENT_NOW_LINE)
  }, 30_000)

  test("a requeued round that no longer carries sendNowAt reads Queued and offers the button again", async () => {
    const requeued = roundIn("R5", { requeuedAt: "2026-10-09T18:40:00.000Z" })
    const o = await open({
      pairing: BUSY,
      pageState: { drafts: [], rounds: [requeued], agentNotes: [] },
    })
    const sheet = await openSheet(o, "history")
    await until("the History button", () =>
      sheet.getByRole("button", { name: "Send round 5 now" }).isVisible(),
    )
    expect(await outcomeOf(sheet, "5").innerText()).toBe("Queued")
  }, 30_000)
})

describe("send now: the palette", () => {
  test("a busy session with drafts lists Send round N now after the send command, and running it sends once and nudges once", async () => {
    const o = await open({ pairing: BUSY, pageState: seed(2) })
    await openPalette(o)
    const labels = await paletteLabels(o)
    const queue = labels.indexOf("Queue round 1")
    expect(queue).toBeGreaterThanOrEqual(0)
    expect(labels[queue + 1]).toBe("Send round 1 now")

    await o.page.keyboard.type("Send round 1 now")
    await o.page.keyboard.press("Enter")
    await until("the send-now request", () => nowRequests(o).length === 1)
    expect(sendRequests(o)).toHaveLength(1)
    expect(o.mock.rounds()).toHaveLength(1)
    expect(nowRequests(o).map((r) => r.path)).toEqual([nowPath(o.mock.rounds()[0]?.id ?? "")])
  }, 30_000)

  test("a busy session with no drafts lists no Send now", async () => {
    const o = await open({ pairing: BUSY, pageState: seed(0) })
    await openPalette(o)
    expect((await paletteLabels(o)).filter((label) => label.includes("now"))).toEqual([])
  }, 30_000)
})

describe("send now: a session that is not busy", () => {
  test("a live session shows no Send now in the footer, History or palette", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: { drafts: drafts(2), rounds: [QUEUED], agentNotes: [] },
    })
    const sheet = await openSheet(o)
    expect(await sheet.getByRole("button", { name: "Send round" }).count()).toBe(1)
    expect(await sheet.getByRole("button", { name: /now/i }).count()).toBe(0)
    expect(await sheet.innerText()).not.toContain("Send now")

    await sheet.getByRole("tab", { name: /^History/ }).click()
    await until("the History round", () =>
      sheet.getByRole("region", { name: "Round 5" }).isVisible(),
    )
    expect(await sheet.getByRole("button", { name: /now/i }).count()).toBe(0)

    await openPalette(o)
    expect((await paletteLabels(o)).filter((label) => /\bnow\b/i.test(label))).toEqual([])
    expect(nowRequests(o)).toHaveLength(0)
  }, 30_000)

  test("a page with no session shows no Send now", async () => {
    const o = await open({
      pairing: null,
      pageState: { drafts: drafts(1), rounds: [QUEUED], agentNotes: [] },
    })
    const sheet = await openSheet(o)
    expect(await sheet.innerText()).not.toContain("Send now")
    await sheet.getByRole("tab", { name: /^History/ }).click()
    await until("the History round", () =>
      sheet.getByRole("region", { name: "Round 5" }).isVisible(),
    )
    expect(await sheet.getByRole("button", { name: /Send round \d+ now/ }).count()).toBe(0)
  }, 30_000)

  test("a session that has ended shows no Send now on a queued round", async () => {
    const o = await open({
      pairing: GONE,
      pageState: { drafts: drafts(1), rounds: [QUEUED], agentNotes: [] },
    })
    const sheet = await openSheet(o, "history")
    await until("the History round", () =>
      sheet.getByRole("region", { name: "Round 5" }).isVisible(),
    )
    expect(await sheet.getByRole("button", { name: /Send round \d+ now/ }).count()).toBe(0)
  }, 30_000)
})
