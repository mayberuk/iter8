import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { LiveSession, Note, OVERLAY_ROUTES, OverlayPrefs, Pairing, Round } from "@iter8/protocol"
import type { Browser, Locator } from "playwright"
import liveSessionJson from "../../../packages/protocol/fixtures/LiveSession.json"
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
const LIVE = Pairing.parse(pairingJson)
const GONE = Pairing.parse(goneJson)
const OTHER = LiveSession.parse({ ...liveSessionJson, state: { status: "live" } })
const DEAD = {
  owner: GONE.owner,
  agent: GONE.agent,
  process: GONE.process,
  cwd: GONE.cwd,
  state: GONE.state,
}
const ORCHID = LiveSession.parse({
  ...liveSessionJson,
  owner: "own_orchid01",
  cwd: "/home/biruk/dev/orchid",
  state: { status: "live" },
})
const TULIP = LiveSession.parse({
  ...liveSessionJson,
  owner: "own_tulip002",
  cwd: "/home/biruk/dev/tulip",
  state: { status: "live" },
})
const CURRENT = {
  owner: LIVE.owner,
  agent: LIVE.agent,
  process: LIVE.process,
  cwd: LIVE.cwd,
  state: LIVE.state,
}
const DRAFT = Note.parse({ ...noteJson, pageId: "mockpage" })
const TWO_DRAFTS = ["N21", "N22"].map((id) =>
  Note.parse({ ...noteJson, id, pageId: "mockpage", body: `Body of ${id}` }),
)
const seed = (drafts: Note[]) => ({ drafts, rounds: [], agentNotes: [] })
const TOUR_DONE = OverlayPrefs.parse({
  theme: "auto",
  dock: "br",
  collapsed: false,
  pinsVisible: true,
  coachDone: true,
})
const TOUR_PENDING = OverlayPrefs.parse({ ...TOUR_DONE, coachDone: false })

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
  opened = await openOverlay({ overlayDir: overlayBuild.path, folder: STATIC, mock, browser })
  await until("the dock to be ready", () =>
    opened ? opened.overlay.getByRole("button", { name: "Pick element" }).isVisible() : false,
  )
  return opened
}
type Opened = Awaited<ReturnType<typeof open>>

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

const palette = (overlay: Locator) => overlay.getByRole("dialog", { name: "Command palette" })
const commandInput = (overlay: Locator) =>
  palette(overlay).getByRole("textbox", { name: "Command" })
const theme = (overlay: Locator) => overlay.locator(".root").getAttribute("data-theme")
const dock = (overlay: Locator) => overlay.getByRole("toolbar", { name: "iter8 annotation tools" })
const coach = (overlay: Locator) => overlay.getByRole("dialog", { name: "Getting started" })
const requestsTo = (o: Opened, method: string, path: string) =>
  o.mock.requests().filter((request) => request.method === method && request.path === path)

const rows = (o: Opened) =>
  palette(o.overlay)
    .locator(".pal-i")
    .evaluateAll((els) =>
      els.map((el) => ({
        label: el.querySelector(".lb")?.firstChild?.textContent ?? "",
        keys: [...el.querySelectorAll(".ks kbd")].map((kbd) => kbd.textContent),
      })),
    )
const labels = async (o: Opened) => (await rows(o)).map((row) => row.label)
const selected = (o: Opened) =>
  palette(o.overlay)
    .locator('.pal-i[aria-current="true"] .lb')
    .evaluate((el) => el.firstChild?.textContent)
const groupAndIcon = (o: Opened) =>
  palette(o.overlay)
    .locator(".pal-i")
    .evaluateAll((els) =>
      els.map((el) => {
        let heading = el.previousElementSibling
        while (heading && !heading.classList.contains("pal-g"))
          heading = heading.previousElementSibling
        return {
          label: el.querySelector(".lb")?.firstChild?.textContent ?? "",
          group: heading?.textContent ?? "",
          icon: [...el.querySelectorAll("svg path")]
            .map((path) => path.getAttribute("d"))
            .join("|"),
        }
      }),
    )
const groupsOf = (o: Opened) =>
  palette(o.overlay)
    .locator(".pal-g")
    .evaluateAll((els) => els.map((el) => el.textContent))

async function emulatePlatform(o: Opened, platform: string) {
  await o.page.addInitScript((value) => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => value, configurable: true })
  }, platform)
  await o.page.reload()
  await until("the dock after the reload", () => dock(o.overlay).isVisible())
  const reported: string = await o.page.evaluate(() => navigator.platform)
  expect(reported).toBe(platform)
}

async function openPalette(o: Opened) {
  await o.page.keyboard.press("ControlOrMeta+K")
  await until("the palette", () => palette(o.overlay).isVisible())
}

async function runCommand(o: Opened, query: string) {
  await openPalette(o)
  await commandInput(o.overlay).fill(query)
  await commandInput(o.overlay).press("Enter")
  await until("the palette to close", async () => !(await palette(o.overlay).isVisible()))
}

describe("command palette", () => {
  test("Mod+K opens it with the input focused, grouped, and Esc closes it", async () => {
    const o = await open({
      pairing: LIVE,
      liveSessions: [OTHER],
      pageState: seed([DRAFT]),
      prefs: TOUR_DONE,
    })
    expect(await palette(o.overlay).count()).toBe(0)
    await openPalette(o)

    const focused = await commandInput(o.overlay).evaluate((input) => {
      const root = input.getRootNode()
      return root instanceof ShadowRoot && root.activeElement === input
    })
    expect(focused).toBe(true)

    const groups = await palette(o.overlay)
      .locator(".pal-g")
      .evaluateAll((els) => els.map((el) => el.textContent))
    expect(groups).toEqual(["Actions", "View", "Appearance", "Notes", "Sessions"])
    expect(await palette(o.overlay).innerText()).toContain("iter8 0.0.0-mock")

    await o.page.keyboard.press("Escape")
    await until("the palette to close", async () => !(await palette(o.overlay).isVisible()))
  }, 30_000)

  test("typing 'theme dark' and Enter switches to the dark theme and saves it", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_DONE })
    expect(await theme(o.overlay)).toBe("auto")
    await runCommand(o, "theme dark")
    await until("the dark theme", async () => (await theme(o.overlay)) === "dark")
    await until("the theme to be saved", () => o.mock.prefs().theme === "dark")
  }, 30_000)

  test("the arrow keys move the selection before Enter runs it", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_DONE })
    await openPalette(o)
    await commandInput(o.overlay).fill("theme")
    for (const key of ["ArrowDown", "ArrowDown", "ArrowUp", "Enter"])
      await commandInput(o.overlay).press(key)
    await until("the light theme", async () => (await theme(o.overlay)) === "light")
  }, 30_000)

  test("a query nothing matches says so", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_DONE })
    await openPalette(o)
    await commandInput(o.overlay).fill("zzz")
    const empty = palette(o.overlay).getByText("No command matches “zzz”")
    await until("the empty copy", () => empty.isVisible())
    expect(await palette(o.overlay).getByRole("button").count()).toBe(0)
  }, 30_000)

  test("a seeded draft appears under Notes and Enter opens the sheet on it", async () => {
    const o = await open({ pairing: LIVE, pageState: seed(TWO_DRAFTS), prefs: TOUR_DONE })
    // The dock springs to its place, so a box read mid-slide is not where it rests.
    await dock(o.overlay).evaluate((el) =>
      Promise.all(el.getAnimations().map((animation) => animation.finished)),
    )
    const before = await dock(o.overlay).boundingBox()
    await openPalette(o)
    await commandInput(o.overlay).fill("n22")

    const row = palette(o.overlay).getByRole("button")
    await until("one matching note", async () => (await row.count()) === 1)
    const text = await row.innerText()
    expect(text).toContain("02")
    expect(text).toContain("Body of N22")
    const groups = await palette(o.overlay)
      .locator(".pal-g")
      .evaluateAll((els) => els.map((el) => el.textContent))
    expect(groups).toEqual(["Notes"])

    await commandInput(o.overlay).press("Enter")
    await until("the palette to close", async () => !(await palette(o.overlay).isVisible()))
    let after: Awaited<ReturnType<Locator["boundingBox"]>> = null
    await until("the dock to make room for the sheet", async () => {
      after = await dock(o.overlay).boundingBox()
      return before !== null && after !== null && after.x < before.x - 100
    }).catch((error: Error) => {
      throw new Error(
        `${error.message}; dock before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`,
      )
    })

    await o.page.keyboard.press("Backspace")
    const deleted = OVERLAY_ROUTES.deleteDraft.path.replace(":noteId", "N22")
    await until("the focused note to be deleted", () => requestsTo(o, "DELETE", deleted).length > 0)
    expect(o.mock.requests().filter((request) => request.method === "DELETE")).toHaveLength(1)
  }, 30_000)

  test("with the session gone there is no Send row, and an Attach row attaches this page", async () => {
    const o = await open({
      pairing: GONE,
      liveSessions: [DEAD, OTHER],
      pageState: seed([DRAFT]),
      prefs: TOUR_DONE,
    })
    await openPalette(o)
    const attach = palette(o.overlay).getByRole("button", { name: "Attach to larkspur" })
    await until("the attach row", () => attach.isVisible())
    expect(
      await palette(o.overlay)
        .getByRole("button", { name: /^(Send|Queue) round/ })
        .count(),
    ).toBe(0)

    await commandInput(o.overlay).fill("attach")
    await commandInput(o.overlay).press("Enter")
    await until(
      "the attach request",
      () => requestsTo(o, "POST", OVERLAY_ROUTES.attach.path).length > 0,
    )
    expect(
      requestsTo(o, "POST", OVERLAY_ROUTES.attach.path).map((request) => request.body),
    ).toEqual([{ owner: OTHER.owner }])
    expect(requestsTo(o, "POST", OVERLAY_ROUTES.send.path)).toHaveLength(0)
  }, 30_000)

  test("the Send row sends the round the way the dock's Send does", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([DRAFT]), prefs: TOUR_DONE })
    await openPalette(o)
    await commandInput(o.overlay).fill("send round")
    const row = palette(o.overlay).getByRole("button")
    await until("the send row", async () => (await row.count()) === 1)
    const text = await row.innerText()
    expect(text).toContain("Send round 1")
    expect(text).toContain("1 note: 1 fix")

    await commandInput(o.overlay).press("Enter")
    await until(
      "the send request",
      () => requestsTo(o, "POST", OVERLAY_ROUTES.send.path).length > 0,
    )
    const [sent] = requestsTo(o, "POST", OVERLAY_ROUTES.send.path)
    expect(sent?.body).toMatchObject({ noteIds: [DRAFT.id], generation: LIVE.generation })
  }, 30_000)

  test("Pick an element does what the C key does", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_DONE })
    const pick = o.overlay.getByRole("button", { name: "Pick element" })
    expect(await pick.getAttribute("aria-pressed")).toBe("false")
    await runCommand(o, "pick an element")
    await until("pick mode", async () => (await pick.getAttribute("aria-pressed")) === "true")
    await o.page.keyboard.press("c")
    await until(
      "pick mode to end",
      async () => (await pick.getAttribute("aria-pressed")) === "false",
    )
  }, 30_000)

  test("Hide pins does what the P key does", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_DONE })
    await runCommand(o, "hide pins")
    await until("pins to be saved hidden", () => !o.mock.prefs().pinsVisible)
    await openPalette(o)
    await commandInput(o.overlay).fill("pins")
    const row = palette(o.overlay).getByRole("button")
    await until("the row to flip", async () => (await row.innerText()).includes("Show pins"))
    await o.page.keyboard.press("Escape")
    await o.page.keyboard.press("p")
    await until("pins to be saved shown", () => o.mock.prefs().pinsVisible)
  }, 30_000)
})

describe("command palette: opening", () => {
  test("Mod+K opens it while a text field on the page has focus", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_DONE })
    await o.page.locator("#title").focus()
    await o.page.keyboard.press("ControlOrMeta+K")
    await until("the palette over a focused page field", () => palette(o.overlay).isVisible())
    expect(
      await commandInput(o.overlay).evaluate((input) => {
        const root = input.getRootNode()
        return root instanceof ShadowRoot && root.activeElement === input
      }),
    ).toBe(true)
    await o.page.keyboard.press("Escape")
    await until("the palette to close", async () => !(await palette(o.overlay).isVisible()))
    expect(await o.page.locator("#title").inputValue()).toBe("")
  }, 30_000)

  test("only Mod+K gets through a focused page text field; typed letters stay in the field", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_DONE })
    await o.page.locator("#title").focus()
    await o.page.keyboard.type("crsp?")
    await o.page.keyboard.press("ControlOrMeta+K")
    await until("the palette", () => palette(o.overlay).isVisible())
    await o.page.keyboard.press("Escape")
    expect(await o.page.locator("#title").inputValue()).toBe("crsp?")
    expect(
      await o.overlay.getByRole("button", { name: "Pick element" }).getAttribute("aria-pressed"),
    ).toBe("false")
    expect(await o.overlay.getByRole("complementary", { name: "Round sheet" }).count()).toBe(0)
    expect(await o.overlay.getByRole("dialog", { name: "Keyboard shortcuts" }).count()).toBe(0)
  }, 30_000)

  test("Mod+K opens it with the dock collapsed", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: seed([]),
      prefs: { ...TOUR_DONE, collapsed: true },
    })
    await o.page.keyboard.press("ControlOrMeta+K")
    await until("the palette", () => palette(o.overlay).isVisible())
  }, 30_000)

  test("Esc still closes it after a click on its header, and the arrows still move the selection", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_DONE })
    await openPalette(o)
    await commandInput(o.overlay).fill("theme")
    await palette(o.overlay).locator(".pal-f .ver").click()
    await o.page.keyboard.press("ArrowDown")
    await until("the second theme row", async () => (await selected(o)) === "Theme: Light")
    await palette(o.overlay).locator(".pal-in kbd").click()
    await o.page.keyboard.press("Escape")
    await until("the palette to close", async () => !(await palette(o.overlay).isVisible()))
  }, 30_000)
})

describe("command palette: rows", () => {
  test("lists exactly the sketch's commands and keys, plus one Attach row per other live session", async () => {
    const o = await open({
      pairing: LIVE,
      liveSessions: [CURRENT, DEAD, ORCHID],
      pageState: seed([DRAFT]),
      prefs: TOUR_DONE,
    })
    await openPalette(o)
    await until("the attach row", async () => (await labels(o)).includes("Attach to orchid"))

    expect(await groupsOf(o)).toEqual(["Actions", "View", "Appearance", "Notes", "Sessions"])
    expect(await rows(o)).toEqual([
      { label: "Pick an element", keys: ["C"] },
      { label: "Draw a region", keys: [] },
      { label: "Take a screenshot", keys: ["S"] },
      { label: "Open round sheet", keys: ["R"] },
      { label: "Show history", keys: [] },
      { label: "Show conversation", keys: [] },
      { label: "Send round 1", keys: [] },
      { label: "Hide pins", keys: ["P"] },
      { label: "Collapse dock", keys: [] },
      { label: "Keyboard shortcuts", keys: ["?"] },
      { label: "Theme: Auto", keys: [] },
      { label: "Theme: Light", keys: [] },
      { label: "Theme: Dark", keys: [] },
      { label: `01 ${DRAFT.body}`, keys: [] },
      { label: "Attach to orchid", keys: [] },
    ])
  }, 30_000)

  test("Show conversation sits in the same group as Show history and carries the history icon", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([DRAFT]), prefs: TOUR_DONE })
    await openPalette(o)
    const all = await groupAndIcon(o)
    const named = (label: string) => all.find((row) => row.label === label)
    const history = named("Show history")
    const conversation = named("Show conversation")
    const roundSheet = named("Open round sheet")
    expect(history?.group).toBe("Actions")
    expect(history?.icon).not.toBe("")
    expect(roundSheet?.icon).not.toBe(history?.icon)
    expect(conversation?.group).toBe(history?.group)
    expect(conversation?.icon).toBe(history?.icon)
  }, 30_000)

  test("rows that cannot run are hidden: Send with no notes, a session that ended, the one attached", async () => {
    const o = await open({
      pairing: LIVE,
      liveSessions: [CURRENT, DEAD, ORCHID],
      pageState: seed([]),
      prefs: TOUR_DONE,
    })
    await openPalette(o)
    await until("the attach row", async () => (await labels(o)).includes("Attach to orchid"))
    const all = await labels(o)
    expect(all.some((label) => /^(Send|Queue) round/.test(label))).toBe(false)
    expect(all.filter((label) => label.startsWith("Attach to"))).toEqual(["Attach to orchid"])
    expect(all.some((label) => /^\d\d /.test(label))).toBe(false)
  }, 30_000)

  test("with several live sessions the Attach row for the one typed attaches that one", async () => {
    const o = await open({
      pairing: LIVE,
      liveSessions: [CURRENT, ORCHID, TULIP],
      pageState: seed([]),
      prefs: TOUR_DONE,
    })
    await openPalette(o)
    await until("both attach rows", async () => (await labels(o)).includes("Attach to tulip"))
    expect((await labels(o)).filter((label) => label.startsWith("Attach to"))).toEqual([
      "Attach to orchid",
      "Attach to tulip",
    ])
    await commandInput(o.overlay).fill("attach to tulip")
    await commandInput(o.overlay).press("Enter")
    await until(
      "the attach request",
      () => requestsTo(o, "POST", OVERLAY_ROUTES.attach.path).length > 0,
    )
    expect(
      requestsTo(o, "POST", OVERLAY_ROUTES.attach.path).map((request) => request.body),
    ).toEqual([{ owner: TULIP.owner }])
  }, 30_000)

  test("a busy session relabels the Send row as Queue", async () => {
    const o = await open({
      pairing: { ...LIVE, state: { status: "busy" } },
      pageState: seed([DRAFT]),
      prefs: TOUR_DONE,
    })
    await openPalette(o)
    expect(await labels(o)).toContain("Queue round 1")
  }, 30_000)

  test("the Send row names the round the service will create, not the count of rounds", async () => {
    const sent = Round.parse({ ...roundJson, pageId: "mockpage" })
    const o = await open({
      pairing: LIVE,
      pageState: { drafts: [DRAFT], rounds: [sent], agentNotes: [] },
      prefs: TOUR_DONE,
    })
    await openPalette(o)
    expect(await labels(o)).toContain("Send round 13")
  }, 30_000)

  test("the footer names the service version the service reported", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_DONE })
    await o.page.route(`**${OVERLAY_ROUTES.hello.path}`, async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      await route.fulfill({ response, json: { ...body, serviceVersion: "7.4.1-test" } })
    })
    await o.page.reload()
    await until("the dock after the reload", () => dock(o.overlay).isVisible())
    await openPalette(o)
    expect(await palette(o.overlay).locator(".pal-f .ver").innerText()).toBe("iter8 7.4.1-test")
  }, 30_000)
})

describe("command palette: filtering and keys", () => {
  test("matches a substring of the label, the small text or the group, and nothing out of order", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: seed([]),
      prefs: { ...TOUR_DONE, theme: "dark" },
    })
    await openPalette(o)
    const input = commandInput(o.overlay)

    await input.fill("theme: dark")
    await until("one theme", async () => (await labels(o)).join() === "Theme: Dark")
    await input.fill("follows the system")
    await until("the sub-only match", async () => (await labels(o)).join() === "Theme: Auto")
    await input.fill("appearance")
    await until(
      "the group-only match",
      async () => (await labels(o)).join() === "Theme: Auto,Theme: Light,Theme: Dark",
    )
    await input.fill("  theme  ")
    await until("the trimmed query", async () => (await labels(o)).length === 3)

    for (const miss of ["dark theme", "thdark", "pick element"]) {
      await input.fill(miss)
      await until(`no match for ${miss}`, async () => (await labels(o)).length === 0)
    }
  }, 30_000)

  test("the selection stops at both ends, resets when the query changes, and Enter on nothing keeps the palette open", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: seed([]),
      prefs: { ...TOUR_DONE, theme: "dark" },
    })
    await openPalette(o)
    const input = commandInput(o.overlay)
    await input.fill("theme")
    await until("three themes", async () => (await labels(o)).length === 3)

    await input.press("ArrowUp")
    expect(await selected(o)).toBe("Theme: Auto")
    for (let i = 0; i < 5; i++) await input.press("ArrowDown")
    expect(await selected(o)).toBe("Theme: Dark")

    await input.fill("theme:")
    await until(
      "the selection to return to the top",
      async () => (await selected(o)) === "Theme: Auto",
    )

    await input.fill("zzz")
    await until("the empty state", () => palette(o.overlay).locator(".pal-empty").isVisible())
    await input.press("Enter")
    expect(await palette(o.overlay).isVisible()).toBe(true)
    expect(await theme(o.overlay)).toBe("dark")

    await input.fill("theme:")
    await input.press("Enter")
    await until("the first row to run", async () => (await theme(o.overlay)) === "auto")
  }, 30_000)

  test("ArrowUp, ArrowDown, Enter and Esc in the palette never reach the page", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_DONE })
    await o.page.evaluate(() => {
      const seen: string[] = []
      Object.assign(window, { seenKeys: seen })
      window.addEventListener("keydown", (event) => seen.push(event.key))
    })
    await openPalette(o)
    const input = commandInput(o.overlay)
    await input.fill("pins")
    await input.press("ArrowDown")
    await input.press("ArrowUp")
    await input.press("Enter")
    await until("the palette to close", async () => !(await palette(o.overlay).isVisible()))
    await openPalette(o)
    await o.page.keyboard.press("Escape")
    await until("the palette to close again", async () => !(await palette(o.overlay).isVisible()))
    const seen = await o.page.evaluate(() => (window as unknown as { seenKeys: string[] }).seenKeys)
    expect(seen.filter((key) => ["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(key))).toEqual(
      [],
    )
  }, 30_000)
})

describe("command palette: commands do what their keys do", () => {
  test("Take a screenshot, Draw a region, Open round sheet, Show history, Show conversation, Collapse and Expand dock", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([DRAFT]), prefs: TOUR_DONE })
    const shot = o.overlay.getByRole("button", { name: "Screenshot" })
    const region = o.overlay.getByRole("button", { name: "Draw region" })
    const pressed = async (button: Locator) =>
      (await button.getAttribute("aria-pressed")) === "true"

    await o.page.keyboard.press("s")
    await until("S to start a screenshot", () => pressed(shot))
    await o.page.keyboard.press("s")
    await until("S to end it", async () => !(await pressed(shot)))
    await runCommand(o, "take a screenshot")
    await until("the command to start a screenshot", () => pressed(shot))
    await o.page.keyboard.press("Escape")
    await until("the screenshot to end", async () => !(await pressed(shot)))

    await runCommand(o, "draw a region")
    await until("region mode", () => pressed(region))
    await o.page.keyboard.press("Escape")

    const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
    await o.page.keyboard.press("r")
    await until("R to open the sheet", () => sheet.isVisible())
    await o.page.keyboard.press("r")
    await until("R to close the sheet", async () => !(await sheet.isVisible()))
    await runCommand(o, "open round sheet")
    await until("the command to open the sheet", () => sheet.isVisible())
    expect(
      await sheet.getByRole("tab", { name: /^This round/ }).getAttribute("aria-selected"),
    ).toBe("true")

    await runCommand(o, "show history")
    await until(
      "the History tab",
      async () =>
        (await sheet.getByRole("tab", { name: /^History/ }).getAttribute("aria-selected")) ===
        "true",
    )
    await runCommand(o, "show conversation")
    await until(
      "the Conversation tab",
      async () =>
        (await sheet.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected")) ===
        "true",
    )

    const expand = o.overlay.getByRole("button", { name: "Expand iter8 dock" })
    await runCommand(o, "collapse dock")
    const inert = () => o.overlay.locator(".dock").evaluate((el) => el.hasAttribute("inert"))
    await until("the collapsed dock", inert)
    await until("the expand button", () => expand.isVisible())
    await until("collapsed to be saved", () => o.mock.prefs().collapsed)
    await runCommand(o, "expand dock")
    await until("the dock back", async () => !(await inert()))
    await until("expanded to be saved", () => !o.mock.prefs().collapsed)
  }, 60_000)

  test("Theme: Auto and Theme: Light switch the theme and save it", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: seed([]),
      prefs: { ...TOUR_DONE, theme: "dark" },
    })
    await runCommand(o, "theme: light")
    await until("light", async () => (await theme(o.overlay)) === "light")
    await until("light saved", () => o.mock.prefs().theme === "light")
    await runCommand(o, "theme: auto")
    await until("auto", async () => (await theme(o.overlay)) === "auto")
    await until("auto saved", () => o.mock.prefs().theme === "auto")
  }, 30_000)
})

describe("shortcut sheet", () => {
  test("? lists the four sections, and the palette opens it too", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_DONE })
    const sheet = o.overlay.getByRole("dialog", { name: "Keyboard shortcuts" })

    await o.page.keyboard.press("?")
    await until("the sheet", () => sheet.isVisible())
    for (const section of ["Pick", "Note", "Round", "Everywhere"])
      expect(await sheet.getByRole("heading", { name: section }).count()).toBe(1)

    await o.page.keyboard.press("Escape")
    await until("the sheet to close", async () => !(await sheet.isVisible()))

    await runCommand(o, "keyboard shortcuts")
    await until("the sheet again", () => sheet.isVisible())
  }, 30_000)

  test("every row of the four sections is there with its keys", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_DONE })
    await emulatePlatform(o, "Win32")
    const sheet = o.overlay.getByRole("dialog", { name: "Keyboard shortcuts" })
    await o.page.keyboard.press("?")
    await until("the sheet", () => sheet.isVisible())

    const sections = await sheet.locator(".kgrid > div").evaluateAll((cells) =>
      cells.map((cell) => ({
        title: cell.querySelector("h5")?.textContent,
        rows: [...cell.querySelectorAll(".krow")].map((row) => [
          row.children[0]?.textContent,
          row.children[1]?.textContent?.replace(/\s+/g, " ").trim(),
        ]),
      })),
    )
    expect(sections).toEqual([
      {
        title: "Pick",
        rows: [
          ["Pick mode", "C or ⌥⇧A"],
          ["Parent / child", "↑↓"],
          ["Add to selection", "⇧ click"],
          ["Region", "drag on the page"],
          ["Annotate selection", "↵"],
        ],
      },
      {
        title: "Note",
        rows: [
          ["Fix · Change · Question · Keep", "1234"],
          ["Save", "Ctrl↵"],
          ["Cancel", "Esc"],
          ["Screenshot", "S"],
          ["Full viewport (in screenshot)", "↵"],
        ],
      },
      {
        title: "Round",
        rows: [
          ["Round sheet", "R"],
          ["Next / previous note", "JK"],
          ["Move note", "⌥↑↓"],
          ["Edit / delete note", "E ⌫"],
        ],
      },
      {
        title: "Everywhere",
        rows: [
          ["Command palette", "CtrlK"],
          ["Peek at the page", "hold Space"],
          ["Show or hide pins", "P"],
          ["This sheet", "?"],
        ],
      },
    ])
  }, 30_000)
})

describe("platform modifier", () => {
  const PLATFORMS = [
    { platform: "MacIntel", mod: "⌘", key: "Meta" },
    { platform: "iPhone", mod: "⌘", key: "Meta" },
    { platform: "Win32", mod: "Ctrl", key: "Control" },
    { platform: "Linux x86_64", mod: "Ctrl", key: "Control" },
  ]
  for (const { platform, mod, key } of PLATFORMS) {
    test(`on ${platform} the palette opens with ${key}+K and the shortcut sheet names ${mod}`, async () => {
      const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_DONE })
      await emulatePlatform(o, platform)

      await o.page.keyboard.press(`${key}+K`)
      await until("the palette", () => palette(o.overlay).isVisible())
      await o.page.keyboard.press("Escape")
      await until("the palette to close", async () => !(await palette(o.overlay).isVisible()))

      const sheet = o.overlay.getByRole("dialog", { name: "Keyboard shortcuts" })
      await o.page.keyboard.press("?")
      await until("the sheet", () => sheet.isVisible())
      const keysOf = async (label: string) =>
        sheet.locator(".krow").filter({ hasText: label }).locator("kbd").allInnerTexts()
      expect(await keysOf("Command palette")).toEqual([mod, "K"])
      expect(await keysOf("Save")).toEqual([mod, "↵"])
    }, 30_000)
  }
})

describe("coach marks", () => {
  test("the tour advances on its triggers and Got it saves it as done", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_PENDING })
    await until("the tour", () => coach(o.overlay).isVisible())
    expect(await coach(o.overlay).innerText()).toContain("1 of 3")
    expect(await coach(o.overlay).getByRole("heading").innerText()).toBe("Point at anything")

    await o.page.keyboard.press("c")
    await until("the second step", async () =>
      (await coach(o.overlay).innerText()).includes("2 of 3"),
    )
    await o.page.keyboard.press("Escape")
    expect(await coach(o.overlay).getByRole("heading").innerText()).toBe(
      "Notes collect into a round",
    )

    await coach(o.overlay).getByRole("button", { name: "Next" }).click()
    await until("the last step", async () =>
      (await coach(o.overlay).innerText()).includes("3 of 3"),
    )
    expect(await coach(o.overlay).getByRole("heading").innerText()).toBe("Every shortcut, one key")
    expect(o.mock.prefs().coachDone).toBe(false)

    await coach(o.overlay).getByRole("button", { name: "Got it" }).click()
    await until("the tour to end", async () => !(await coach(o.overlay).isVisible()))
    await until("the tour to be saved as done", () => o.mock.prefs().coachDone)
  }, 30_000)

  test("Skip tour is remembered, so a reloaded page shows no tour", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_PENDING })
    await until("the tour", () => coach(o.overlay).isVisible())
    await coach(o.overlay).getByRole("button", { name: "Skip tour" }).click()
    await until("the tour to be saved as done", () => o.mock.prefs().coachDone)

    await o.page.reload()
    await until("the dock after the reload", () => dock(o.overlay).isVisible())
    expect(await o.overlay.locator(".coach").count()).toBe(0)
  }, 30_000)

  test("collapsing the dock hides the tour and expanding brings it back", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_PENDING })
    await until("the tour", () => coach(o.overlay).isVisible())

    await dock(o.overlay).getByRole("button", { name: "Collapse dock" }).click()
    await until("the tour to hide", async () => !(await coach(o.overlay).isVisible()))

    await o.overlay.getByRole("button", { name: "Expand iter8 dock" }).click()
    await until("the tour to return", () => coach(o.overlay).isVisible())
    expect(await coach(o.overlay).innerText()).toContain("1 of 3")
  }, 30_000)

  test("it shows 500 ms after the overlay mounts, not sooner", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_PENDING })
    await o.page.addInitScript(() => {
      const times: { mounted?: number; shown?: number } = {}
      Object.assign(window, { coachTimes: times })
      new MutationObserver(() => {
        const host = document.querySelector("iter8-overlay")
        if (!host || times.mounted !== undefined) return
        times.mounted = performance.now()
        const root = host.shadowRoot
        if (!root) return
        const look = () => {
          if (root.querySelector(".coach.on")) times.shown ??= performance.now()
        }
        new MutationObserver(look).observe(root, {
          subtree: true,
          attributes: true,
          childList: true,
        })
        look()
      }).observe(document, { subtree: true, childList: true })
    })
    await o.page.reload()
    const times = await waitFor(
      "the tour times",
      async () => {
        const seen = await o.page.evaluate(
          () =>
            (window as unknown as { coachTimes: { mounted?: number; shown?: number } }).coachTimes,
        )
        return seen.mounted !== undefined && seen.shown !== undefined
          ? { mounted: seen.mounted, shown: seen.shown }
          : null
      },
      { timeoutMs: 15_000 },
    )
    expect(times.shown - times.mounted).toBeGreaterThanOrEqual(500)
    expect(times.shown - times.mounted).toBeLessThan(10_000)
  }, 30_000)

  test("a dock that mounts collapsed shows no tour until it is expanded", async () => {
    const o = await open({
      pairing: LIVE,
      pageState: seed([]),
      prefs: { ...TOUR_PENDING, collapsed: true },
    })
    await o.page.addInitScript(() => {
      const times: { mounted?: number; shown?: number } = {}
      Object.assign(window, { coachTimes: times })
      const look = () => {
        const root = document.querySelector("iter8-overlay")?.shadowRoot
        if (root) times.mounted ??= performance.now()
        if (root?.querySelector(".coach.on")) times.shown ??= performance.now()
        requestAnimationFrame(look)
      }
      requestAnimationFrame(look)
    })
    await o.page.reload()
    const expand = o.overlay.getByRole("button", { name: "Expand iter8 dock" })
    await until("the expand button", () => expand.isVisible())
    await until("twice the tour delay to pass", () =>
      o.page.evaluate(() => {
        const times = (window as unknown as { coachTimes: { mounted?: number } }).coachTimes
        return times.mounted !== undefined && performance.now() - times.mounted > 1000
      }),
    )
    expect(
      await o.page.evaluate(
        () => (window as unknown as { coachTimes: { shown?: number } }).coachTimes.shown,
      ),
    ).toBeUndefined()

    await expand.click()
    await until("the tour", () => coach(o.overlay).isVisible())
    expect(await coach(o.overlay).innerText()).toContain("1 of 3")
  }, 30_000)

  test("each step sits beside its own target", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_PENDING })
    await until("the tour", () => coach(o.overlay).isVisible())
    const viewport = o.page.viewportSize()
    if (!viewport) throw new Error("the page has no viewport")
    const targets = [
      dock(o.overlay).getByRole("button", { name: "Pick element" }),
      o.overlay.locator(".dock .send"),
      o.overlay.locator(".dock .idn"),
    ]
    for (const [step, target] of targets.entries()) {
      if (step > 0) await coach(o.overlay).getByRole("button", { name: "Next" }).click()
      await until(`step ${step + 1} beside its target`, async () => {
        const placed = await coach(o.overlay).boundingBox()
        const aimed = await target.boundingBox()
        if (!placed || !aimed) return false
        const above = aimed.y > viewport.height / 2
        const top = above ? aimed.y - placed.height - 14 : aimed.y + aimed.height + 14
        const left = Math.min(
          Math.max(aimed.x + aimed.width / 2 - placed.width / 2, 12),
          viewport.width - placed.width - 12,
        )
        return Math.abs(placed.y - top) < 2 && Math.abs(placed.x - left) < 2
      })
    }
  }, 30_000)

  test("saving the first note moves the tour from Send to the shortcuts step", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_PENDING })
    await until("the tour", () => coach(o.overlay).isVisible())
    await o.page.keyboard.press("c")
    await until("the second step", async () =>
      (await coach(o.overlay).innerText()).includes("2 of 3"),
    )
    await o.page.locator("[data-source-target=card]").click()
    const note = o.overlay.getByRole("textbox", { name: "Note" })
    await until("the composer", () => note.isVisible())
    await note.fill("Tighten this card")
    await o.overlay.getByRole("button", { name: "Save note" }).click()
    await until("the third step", async () =>
      (await coach(o.overlay).innerText()).includes("3 of 3"),
    )
  }, 30_000)

  test("opening the shortcuts on the last step ends the tour and saves it", async () => {
    const o = await open({ pairing: LIVE, pageState: seed([]), prefs: TOUR_PENDING })
    await until("the tour", () => coach(o.overlay).isVisible())
    await coach(o.overlay).getByRole("button", { name: "Next" }).click()
    await coach(o.overlay).getByRole("button", { name: "Next" }).click()
    await until("the last step", async () =>
      (await coach(o.overlay).innerText()).includes("3 of 3"),
    )
    await o.page.keyboard.press("?")
    await until("the tour to be saved as done", () => o.mock.prefs().coachDone)
    await o.page.keyboard.press("Escape")
    await until(
      "the shortcut sheet to close",
      async () =>
        !(await o.overlay.getByRole("dialog", { name: "Keyboard shortcuts" }).isVisible()),
    )
    expect(await coach(o.overlay).isVisible()).toBe(false)
  }, 30_000)

  test("Skip tour on a later step and Esc both save it, and neither touches the other preferences", async () => {
    const seeded = { ...TOUR_PENDING, theme: "dark", pinsVisible: false } as const
    const first = await open({ pairing: LIVE, pageState: seed([]), prefs: seeded })
    await until("the tour", () => coach(first.overlay).isVisible())
    await coach(first.overlay).getByRole("button", { name: "Next" }).click()
    await coach(first.overlay).getByRole("button", { name: "Skip tour" }).click()
    await until("Skip to be saved", () => first.mock.prefs().coachDone)
    expect(first.mock.prefs()).toEqual({ ...seeded, coachDone: true })
    await first.close()
    opened = null

    const second = await open({ pairing: LIVE, pageState: seed([]), prefs: seeded })
    await until("the tour again", () => coach(second.overlay).isVisible())
    await second.page.keyboard.press("Escape")
    await until("Esc to be saved", () => second.mock.prefs().coachDone)
    expect(second.mock.prefs()).toEqual({ ...seeded, coachDone: true })
    expect(await coach(second.overlay).isVisible()).toBe(false)
  }, 30_000)
})
