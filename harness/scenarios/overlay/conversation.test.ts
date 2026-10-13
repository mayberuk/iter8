import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import {
  ConversationMessage,
  LiveSession,
  MESSAGE_MAX_CHARS,
  MessageId,
  OVERLAY_ROUTES,
  Pairing,
  Round,
} from "@iter8/protocol"
import type { Browser, Locator, Route } from "playwright"
import failedJson from "../../../packages/protocol/fixtures/ConversationMessage.failed.json"
import agentJson from "../../../packages/protocol/fixtures/ConversationMessage.json"
import pageJson from "../../../packages/protocol/fixtures/ConversationMessage.page.json"
import userJson from "../../../packages/protocol/fixtures/ConversationMessage.user.json"
import liveSessionJson from "../../../packages/protocol/fixtures/LiveSession.json"
import goneJson from "../../../packages/protocol/fixtures/Pairing.gone.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import roundJson from "../../../packages/protocol/fixtures/Round.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { throttleCpu } from "../../rig/throttle"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const PAGE = "mockpage"
const NAME = "larkspur"
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
const MESSAGES_PATH = OVERLAY_ROUTES.listMessages.path
const CHAT_PATH = OVERLAY_ROUTES.getChat.path
const XSS = `<img src=x onerror="window.__xss=1">`
const firstPage = (url: URL) => url.pathname === MESSAGES_PATH && !url.searchParams.has("before")
const earlierPage = (url: URL) => url.pathname === MESSAGES_PATH && url.searchParams.has("before")
const messagesRoute = (url: URL) => url.pathname === MESSAGES_PATH
const chatRoute = (url: URL) => url.pathname === CHAT_PATH

const at = (n: number) =>
  `2026-10-09T${String(10 + Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00.000Z`

function agentMessage(n: number, extra: Partial<ConversationMessage> = {}) {
  return ConversationMessage.parse({
    ...agentJson,
    id: `M${n}`,
    pageId: PAGE,
    roundId: null,
    author: { ...agentJson.author, name: NAME },
    text: `Agent message ${n}`,
    at: at(n),
    ...extra,
  })
}

function userMessage(n: number) {
  return ConversationMessage.parse({
    ...userJson,
    id: `M${n}`,
    pageId: PAGE,
    roundId: null,
    text: `Terminal message ${n}`,
    at: at(n),
  })
}

function pageMessage(n: number) {
  return ConversationMessage.parse({
    ...pageJson,
    id: `M${n}`,
    pageId: PAGE,
    author: { ...pageJson.author, idempotencyKey: `chat-seed-${n}` },
    text: `Page message ${n}`,
    at: at(n),
  })
}

/** Rotates agent, terminal and page authors so every label shows up in a page. */
function seeded(count: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1
    return [agentMessage, userMessage, pageMessage][n % 3]?.(n) ?? agentMessage(n)
  })
}

function authorLabel(message: ConversationMessage): string {
  switch (message.author.kind) {
    case "agent":
      return `Claude · ${NAME}`
    case "user":
      return "You, in the terminal"
    case "page":
      return "You, from this page"
  }
}

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
  opened = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: STATIC,
    mock: { pairing: LIVE, ...mock },
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

async function openConversation(o: Opened): Promise<Locator> {
  const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
  await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
  await until("the round sheet", () => sheet.isVisible())
  await sheet.getByRole("tab", { name: "Conversation" }).click()
  const panel = sheet.getByRole("tabpanel", { name: "Conversation" })
  await until("the conversation panel", () => panel.isVisible())
  return panel
}

const log = (panel: Locator) => panel.getByRole("log")
const articles = (panel: Locator) => log(panel).getByRole("article")
const input = (panel: Locator) => panel.getByRole("textbox", { name: `Message ${NAME}` })

async function deliveryLines(row: Locator): Promise<string[]> {
  return row.locator(".cv-state").evaluateAll((els) => els.map((el) => el.textContent ?? ""))
}

async function texts(panel: Locator): Promise<string[]> {
  return articles(panel).evaluateAll((els) =>
    els.map((el) => el.querySelector(".cv-text")?.textContent ?? ""),
  )
}

async function untilCount(
  panel: Locator,
  count: number,
  label = `${count} messages`,
  timeoutMs = 5000,
) {
  await until(label, async () => (await articles(panel).count()) === count, timeoutMs)
}

const clockTime = (o: Opened, iso: string) =>
  o.page.evaluate(
    (value) => new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(value)),
    iso,
  )

const listScroll = (panel: Locator) =>
  log(panel).evaluate((el) => ({
    top: el.scrollTop,
    gap: el.scrollHeight - el.scrollTop - el.clientHeight,
  }))

/** Rows size themselves over several frames, so a position counts once it holds for five. */
async function settledTop(row: Locator): Promise<number> {
  return row.evaluate(
    (el) =>
      new Promise<number>((resolve, reject) => {
        let last = Number.NaN
        let still = 0
        let frames = 0
        const tick = () => {
          const top = el.getBoundingClientRect().top
          still = top === last ? still + 1 : 0
          last = top
          if (still >= 5) resolve(top)
          else if (++frames > 300) reject(new Error("the row never held still"))
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
}

async function scrollListTo(panel: Locator, gapFromBottom: number | "top") {
  await log(panel).evaluate(
    (el, gap) =>
      new Promise<void>((resolve) => {
        const target = gap === "top" ? 0 : el.scrollHeight - el.clientHeight - gap
        if (el.scrollTop === target) return resolve()
        el.addEventListener("scroll", () => resolve(), { once: true })
        el.scrollTop = target
      }),
    gapFromBottom,
  )
}

/** Scrolls the list top to bottom so every row has its real height and none resizes later. */
async function sizeEveryRow(panel: Locator) {
  await log(panel).evaluate(async (el) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const settle = async () => {
      let last = -1
      let still = 0
      for (let frames = 0; still < 3 && frames < 300; frames++) {
        await frame()
        still = el.scrollHeight === last ? still + 1 : 0
        last = el.scrollHeight
      }
    }
    for (let top = 0; top < el.scrollHeight; top += el.clientHeight / 2) {
      el.scrollTop = top
      await settle()
    }
    el.scrollTop = el.scrollHeight
    await settle()
  })
}

const isFocused = (field: Locator) =>
  field.evaluate((el) => (el.getRootNode() as ShadowRoot).activeElement === el)

/** A live push reaches only an open socket; re-storing the same id is idempotent. */
async function pushUntil(o: Opened, message: ConversationMessage, landed: () => Promise<boolean>) {
  await waitFor(
    "the pushed message to show",
    async () => {
      o.mock.pushMessage(message)
      return (await landed()) ? true : null
    },
    { timeoutMs: 5000, everyMs: 150 },
  )
}

const posts = (o: Opened) =>
  o.mock.requests().filter((request) => request.method === "POST" && request.path === MESSAGES_PATH)

const pageMessages = (o: Opened) => o.mock.messages().filter((m) => m.author.kind === "page")

describe("conversation: finished messages", () => {
  test("shows the newest 30 of 45 oldest first with author and time, then the earlier 15 above without moving the view", async () => {
    const all = seeded(45)
    const o = await open({ messages: all })
    const panel = await openConversation(o)
    await untilCount(panel, 30)

    const newest = all.slice(-30)
    expect(await texts(panel)).toEqual(newest.map((m) => m.text))
    for (const message of newest.slice(0, 3)) {
      const name = `${authorLabel(message)}, ${await clockTime(o, message.at)}`
      expect(await log(panel).getByRole("article", { name, exact: true }).count()).toBe(1)
    }
    expect(await articles(panel).first().textContent()).toContain(
      authorLabel(newest[0] as ConversationMessage),
    )
    const heads = log(panel).locator(".cv-meta")
    expect(await heads.count()).toBeGreaterThan(0)
    expect(await heads.first().locator(".cv-who").textContent()).toBe("Claude")
    expect(await heads.first().locator(".cv-sess").textContent()).toBe(NAME)
    expect((await listScroll(panel)).gap).toBeLessThanOrEqual(1)

    await scrollListTo(panel, "top")
    const more = panel.getByRole("button", { name: "Show earlier messages" })
    await until("the earlier button", () => more.isVisible())
    const topText = newest[0]?.text as string
    const topRow = log(panel).getByRole("article").filter({ hasText: topText })
    const before = await settledTop(topRow)
    await more.click()
    await untilCount(panel, 45)
    await until("the earlier button to go", async () => (await more.count()) === 0)
    expect(await texts(panel)).toEqual(all.map((m) => m.text))
    expect(Math.abs((await settledTop(topRow)) - before)).toBeLessThanOrEqual(2)
  }, 30_000)

  test("earlier messages of unequal heights hold the view once every row settles, on a slowed CPU", async () => {
    const all = Array.from({ length: 45 }, (_, i) =>
      agentMessage(i + 1, { text: `Uneven ${i + 1}${"\nmore".repeat((i * 7) % 5)}` }),
    )
    const o = await open({ messages: all })
    const panel = await openConversation(o)
    await untilCount(panel, 30)
    const throttle = await throttleCpu(o.page, 6)
    try {
      await scrollListTo(panel, "top")
      const more = panel.getByRole("button", { name: "Show earlier messages" })
      await until("the earlier button", () => more.isVisible())
      const topRow = articles(panel).filter({ hasText: "Uneven 16" })
      expect((await texts(panel))[0]).toBe(all[15]?.text as string)
      const before = await settledTop(topRow)
      await more.click()
      await untilCount(panel, 45, "all 45 messages", 15_000)
      await until("the earlier button to go", async () => (await more.count()) === 0)
      expect(Math.abs((await settledTop(topRow)) - before)).toBeLessThanOrEqual(2)
    } finally {
      await throttle.restore()
    }
  }, 60_000)

  for (const rate of [1, 4]) {
    test(`a long jump up through rows never shown before holds the top row once they settle, at ${rate}× CPU`, async () => {
      const all = Array.from({ length: 30 }, (_, i) =>
        agentMessage(i + 1, { text: `Uneven ${i + 1}${"\nmore".repeat((i * 7) % 5)}` }),
      )
      const o = await open({ messages: all })
      const panel = await openConversation(o)
      await untilCount(panel, 30)
      await until("the list at the bottom", async () => (await listScroll(panel)).gap <= 1)
      const throttle = rate > 1 ? await throttleCpu(o.page, rate) : null
      try {
        const jumped = await log(panel).evaluate((el) => {
          el.scrollTop = 240
          const edge = el.getBoundingClientRect().top
          const rows = [...el.querySelectorAll("article")]
          const index = rows.findIndex((row) => row.getBoundingClientRect().bottom > edge)
          return { index, top: rows[index]?.getBoundingClientRect().top as number }
        })
        expect(jumped.index).toBeGreaterThan(1)
        const settled = await settledTop(articles(panel).nth(jumped.index))
        expect(Math.abs(settled - jumped.top)).toBeLessThanOrEqual(2)
      } finally {
        await throttle?.restore()
      }
    }, 60_000)
  }

  test("a live message that lands while earlier messages load leaves the view where it was", async () => {
    const all = seeded(45)
    const o = await open({ messages: all })
    const panel = await openConversation(o)
    await untilCount(panel, 30)
    const held: Route[] = []
    await o.page.route(earlierPage, (route) => {
      held.push(route)
    })
    await scrollListTo(panel, "top")
    const topRow = articles(panel).filter({ hasText: all[15]?.text as string })
    const before = await settledTop(topRow)
    await panel.getByRole("button", { name: "Show earlier messages" }).click()
    await until("the earlier request to be held", () => held.length === 1)
    await until("the loading line", () => panel.getByText("Loading…").isVisible())

    const live = agentMessage(46, { text: "Arrived mid-load" })
    await pushUntil(o, live, async () => (await articles(panel).count()) === 31)
    expect(Math.abs((await settledTop(topRow)) - before)).toBeLessThanOrEqual(2)

    await held[0]?.continue()
    await untilCount(panel, 46)
    await until(
      "the loading line to go",
      async () => (await panel.getByText("Loading…").count()) === 0,
    )
    expect(await texts(panel)).toEqual([...all, live].map((m) => m.text))
    expect(Math.abs((await settledTop(topRow)) - before)).toBeLessThanOrEqual(2)
  }, 30_000)

  test("exactly one page of messages offers no earlier button; one more does, and keeps offering it while older remain", async () => {
    const exact = await open({ messages: seeded(30) })
    const exactPanel = await openConversation(exact)
    await untilCount(exactPanel, 30)
    expect(await exactPanel.getByRole("button", { name: "Show earlier messages" }).count()).toBe(0)
    await exact.close()
    opened = null

    const o = await open({ messages: seeded(61) })
    const panel = await openConversation(o)
    await untilCount(panel, 30)
    const more = panel.getByRole("button", { name: "Show earlier messages" })
    await more.click()
    await untilCount(panel, 60)
    expect(await more.isVisible()).toBe(true)
    await more.click()
    await untilCount(panel, 61)
    expect(await more.count()).toBe(0)
  }, 30_000)

  test("no messages shows the empty state", async () => {
    const o = await open({ messages: [] })
    const panel = await openConversation(o)
    await until("the empty state", () => panel.getByText("No messages yet").isVisible())
    expect(await panel.getByText(`Finished messages from ${NAME} show here`).isVisible()).toBe(true)
    expect(await articles(panel).count()).toBe(0)
  }, 30_000)

  test("a failed first load says so and Retry loads the messages", async () => {
    const o = await open({ messages: seeded(3) })
    await o.page.route(firstPage, (route) =>
      route.request().method() === "GET" ? route.fulfill({ status: 500 }) : route.fallback(),
    )
    const panel = await openConversation(o)
    await until("the load failure", () => panel.getByText("Couldn't load messages").isVisible())
    expect(await articles(panel).count()).toBe(0)
    await o.page.unroute(firstPage)
    await panel.getByRole("button", { name: "Retry" }).click()
    await untilCount(panel, 3)
    expect(await panel.getByText("Couldn't load messages").count()).toBe(0)
  }, 30_000)

  test("a failed earlier page keeps the shown messages and still offers the button", async () => {
    const all = seeded(40)
    const o = await open({ messages: all })
    const panel = await openConversation(o)
    await untilCount(panel, 30)
    await o.page.route(earlierPage, (route) => route.fulfill({ status: 500 }))
    const more = panel.getByRole("button", { name: "Show earlier messages" })
    await more.click()
    await until("a failure toast", () =>
      o.overlay.getByText("Couldn't load earlier messages — try again").isVisible(),
    )
    await until("the button back", () => more.isVisible())
    expect(await texts(panel)).toEqual(all.slice(-30).map((m) => m.text))
    await o.page.unroute(earlierPage)
    await more.click()
    await untilCount(panel, 40)
  }, 30_000)

  test("page messages show their delivery under the text", async () => {
    const queued = pageMessage(1)
    const delivered = ConversationMessage.parse({
      ...pageMessage(2),
      author: {
        kind: "page",
        idempotencyKey: "chat-seed-2",
        delivery: { status: "delivered", at: at(3) },
      },
    })
    const failed = ConversationMessage.parse({
      ...failedJson,
      id: "M3",
      pageId: PAGE,
      text: "Page message 3",
    })
    const o = await open({ messages: [queued, delivered, failed] })
    const panel = await openConversation(o)
    await untilCount(panel, 3)
    const rows = articles(panel)
    expect(await deliveryLines(rows.nth(0))).toEqual([`Waiting for ${NAME} to take it`])
    expect(await deliveryLines(rows.nth(1))).toEqual([`Taken by ${NAME}`])
    expect(await deliveryLines(rows.nth(2))).toEqual([
      `Not delivered — ${NAME} ended before taking it`,
    ])
    const [waitingText, takenText, failedText] = await Promise.all(
      [0, 1, 2].map(async (i) => (await rows.nth(i).textContent()) ?? ""),
    )
    expect(waitingText).not.toContain("Taken by")
    expect(waitingText).not.toContain("Not delivered")
    expect(takenText).not.toContain("Waiting for")
    expect(takenText).not.toContain("Not delivered")
    expect(failedText).not.toContain("Waiting for")
    expect(failedText).not.toContain("Taken by")
  }, 30_000)

  test("a divider marks each change into a round, and one switches to History scrolled to its round", async () => {
    const rounds = Array.from({ length: 8 }, (_, i) =>
      Round.parse({
        ...roundJson,
        id: `R${i + 1}`,
        pageId: PAGE,
        notes: roundJson.notes.map((note, n) => ({ ...note, id: `N${i + 1}${n}`, pageId: PAGE })),
      }),
    )
    const [first, second] = rounds as [Round, Round]
    const o = await open({
      pageState: { drafts: [], rounds, agentNotes: [] },
      messages: [
        agentMessage(1),
        agentMessage(2, { roundId: first.id }),
        agentMessage(3, { roundId: first.id }),
        agentMessage(4),
        agentMessage(5, { roundId: first.id }),
        agentMessage(6, { roundId: second.id }),
        agentMessage(7, { roundId: second.id }),
      ],
    })
    const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
    const panel = await openConversation(o)
    await untilCount(panel, 7)
    const sequence = await log(panel).evaluate((el) =>
      [...el.querySelectorAll(".cv-body > article, .cv-body > .cv-round")].map((node) =>
        node.tagName === "BUTTON"
          ? (node.textContent ?? "")
          : (node.querySelector(".cv-text")?.textContent ?? ""),
      ),
    )
    expect(sequence).toEqual([
      "Agent message 1",
      "Round 1 · done",
      "Agent message 2",
      "Agent message 3",
      "Agent message 4",
      "Round 1 · done",
      "Agent message 5",
      "Round 2 · done",
      "Agent message 6",
      "Agent message 7",
    ])

    const history = sheet.getByRole("tabpanel", { name: "History" })
    const section = sheet.getByRole("region", { name: "Round 1", exact: true })
    const inView = async () => {
      const box = await section.boundingBox()
      const panelBox = await history.boundingBox()
      return !!box && !!panelBox && box.y >= panelBox.y - 1 && box.y < panelBox.y + panelBox.height
    }
    await sheet.getByRole("tab", { name: /^History/ }).click()
    await until("the History panel", () => history.isVisible())
    expect(await inView()).toBe(false)
    await sheet.getByRole("tab", { name: "Conversation" }).click()
    await untilCount(panel, 7)

    await panel.getByRole("button", { name: "Round 1" }).first().click()
    await until(
      "the History tab",
      async () =>
        (await sheet.getByRole("tab", { name: /^History/ }).getAttribute("aria-selected")) ===
        "true",
    )
    await until("the round section in view", inView)
    expect(await section.getAttribute("id")).toBe(`round-${first.id}`)
  }, 30_000)

  test("an agent other than Claude is labelled with its kind", async () => {
    const message = ConversationMessage.parse({
      ...agentMessage(1),
      author: { ...agentJson.author, agent: "codex", name: NAME },
    })
    const o = await open({ messages: [message] })
    const panel = await openConversation(o)
    await untilCount(panel, 1)
    const name = `codex · ${NAME}, ${await clockTime(o, message.at)}`
    expect(await log(panel).getByRole("article", { name, exact: true }).count()).toBe(1)
    expect(await log(panel).getByText("Claude").count()).toBe(0)
  }, 30_000)

  test("the tabs run This round, Conversation, History, and only This round has the footer", async () => {
    const o = await open()
    const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
    await openConversation(o)
    const names = await sheet
      .getByRole("tab")
      .evaluateAll((tabs) => tabs.map((tab) => tab.textContent?.replace(/\s*\d+$/, "").trim()))
    expect(names).toEqual(["This round", "Conversation", "History"])
    const footer = () => sheet.getByRole("button", { name: /^\w+ round$/ })
    expect(await footer().count()).toBe(0)
    await sheet.getByRole("tab", { name: /^History/ }).click()
    await until("the History panel", () =>
      sheet.getByRole("tabpanel", { name: "History" }).isVisible(),
    )
    expect(await footer().count()).toBe(0)
    await sheet.getByRole("tab", { name: /^This round/ }).click()
    await until("the round footer", async () => (await footer().count()) === 1)
  }, 30_000)

  test("a reconnect to another session while the tab stays open replaces the list with the newest page", async () => {
    const all = seeded(45)
    const o = await open({ messages: all, liveSessions: [OTHER] })
    const panel = await openConversation(o)
    await untilCount(panel, 30)
    await panel.getByRole("button", { name: "Show earlier messages" }).click()
    await untilCount(panel, 45)

    const juniper = Pairing.parse({
      ...LIVE,
      owner: OTHER.owner,
      cwd: "/home/biruk/dev/juniper",
      generation: LIVE.generation + 1,
    })
    o.mock.setPairing(juniper)
    o.mock.dropSockets()
    const latest = agentMessage(46, { text: "Stored after the switch" })
    o.mock.pushMessage(latest)
    await until(
      "the newest page for the new session",
      async () => (await texts(panel)).at(-1) === latest.text,
      10_000,
    )
    expect(await texts(panel)).toEqual([...all, latest].slice(-30).map((m) => m.text))
    await until("the input for the new session", () =>
      panel.getByRole("textbox", { name: "Message juniper" }).isVisible(),
    )
  }, 30_000)

  test("markup in a message is shown as text and never runs", async () => {
    const o = await open({ messages: [agentMessage(1, { text: XSS })] })
    const panel = await openConversation(o)
    await untilCount(panel, 1)
    expect(await texts(panel)).toEqual([XSS])
    expect(await o.overlay.locator("img").count()).toBe(0)

    const release = o.mock.holdPosts()
    try {
      await input(panel).fill(XSS)
      await input(panel).press("Enter")
      await until("the pending markup", async () => (await articles(panel).count()) === 2)
      expect((await texts(panel)).at(-1)).toBe(XSS)
      expect(await o.overlay.locator("img").count()).toBe(0)
    } finally {
      release()
    }
    await until("the stored markup", () => pageMessages(o).length === 1)
    await until("it settles", async () =>
      ((await articles(panel).last().textContent()) ?? "").includes(`Waiting for ${NAME}`),
    )
    expect(await o.page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined()
    expect(await o.page.locator("img[src=x]").count()).toBe(0)
  }, 30_000)
})

describe("conversation: live messages", () => {
  test("a pushed message shows without a reload and keeps the list at the bottom, once", async () => {
    const o = await open({ messages: seeded(30) })
    const panel = await openConversation(o)
    await untilCount(panel, 30)
    await until("the list at the bottom", async () => (await listScroll(panel)).gap <= 1)

    const pushed = agentMessage(31, { text: "Pushed while at the bottom" })
    await pushUntil(o, pushed, async () => (await articles(panel).count()) === 31)
    await until("the list still at the bottom", async () => (await listScroll(panel)).gap <= 1)
    o.mock.pushMessage(pushed)
    await until("the push to settle", async () => (await texts(panel)).at(-1) === pushed.text)
    expect((await texts(panel)).filter((text) => text === pushed.text)).toHaveLength(1)
  }, 30_000)

  test("a pushed message leaves a scrolled-up view where it is", async () => {
    const o = await open({ messages: seeded(30) })
    const panel = await openConversation(o)
    await untilCount(panel, 30)
    await until("the list at the bottom", async () => (await listScroll(panel)).gap <= 1)
    await log(panel).evaluate(
      (el) =>
        new Promise<void>((resolve) => {
          el.addEventListener("scroll", () => resolve(), { once: true })
          el.scrollTop = 40
        }),
    )
    const anchor = articles(panel).nth(2)
    const before = await settledTop(anchor)
    const topBefore = (await listScroll(panel)).top

    await pushUntil(o, agentMessage(31), async () => (await articles(panel).count()) === 31)
    expect(Math.abs((await settledTop(anchor)) - before)).toBeLessThanOrEqual(1)
    expect((await listScroll(panel)).top).toBe(topBefore)
    expect((await listScroll(panel)).gap).toBeGreaterThan(24)
  }, 30_000)

  test("a message that lands in the same task as a scroll up, before its scroll event, is not followed", async () => {
    const o = await open({ messages: seeded(30) })
    const panel = await openConversation(o)
    await untilCount(panel, 30)
    await o.page.evaluate(() => {
      const state = window as unknown as { held: (() => void)[] | null; wrapped: number }
      state.held = null
      state.wrapped = 0
      const own = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage")
      Object.defineProperty(WebSocket.prototype, "onmessage", {
        ...own,
        set(this: WebSocket, handle: ((event: MessageEvent) => void) | null) {
          state.wrapped++
          own?.set?.call(this, (event: MessageEvent) => {
            if (state.held && JSON.parse(event.data).type === "message")
              state.held.push(() => handle?.call(this, event))
            else handle?.call(this, event)
          })
        },
      })
    })
    o.mock.dropSockets()
    await until(
      "the socket to reconnect",
      () => o.page.evaluate(() => (window as unknown as { wrapped: number }).wrapped > 0),
      10_000,
    )
    await untilCount(panel, 30)
    await until("the list at the bottom", async () => (await listScroll(panel)).gap <= 1)
    await settledTop(articles(panel).last())

    await o.page.evaluate(() => {
      ;(window as unknown as { held: (() => void)[] }).held = []
    })
    o.mock.pushMessage(agentMessage(31))
    await until("the push to be held", () =>
      o.page.evaluate(() => (window as unknown as { held: unknown[] }).held.length === 1),
    )
    const jumped = await log(panel).evaluate((el) => {
      el.scrollTop = 40
      const edge = el.getBoundingClientRect().top
      const rows = [...el.querySelectorAll("article")]
      const index = rows.findIndex((row) => row.getBoundingClientRect().bottom > edge)
      const top = rows[index]?.getBoundingClientRect().top as number
      for (const deliver of (window as unknown as { held: (() => void)[] }).held) deliver()
      return { index, top }
    })
    await untilCount(panel, 31)
    expect(
      Math.abs((await settledTop(articles(panel).nth(jumped.index))) - jumped.top),
    ).toBeLessThanOrEqual(2)
    expect((await listScroll(panel)).gap).toBeGreaterThan(24)
  }, 30_000)

  test("a row that grows in the same task as a push still lets the list follow to the bottom", async () => {
    const o = await open({ messages: seeded(30) })
    const panel = await openConversation(o)
    await untilCount(panel, 30)
    await o.page.evaluate(() => {
      const state = window as unknown as { held: (() => void)[] | null; wrapped: number }
      state.held = null
      state.wrapped = 0
      const own = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage")
      Object.defineProperty(WebSocket.prototype, "onmessage", {
        ...own,
        set(this: WebSocket, handle: ((event: MessageEvent) => void) | null) {
          state.wrapped++
          own?.set?.call(this, (event: MessageEvent) => {
            if (state.held && JSON.parse(event.data).type === "message")
              state.held.push(() => handle?.call(this, event))
            else handle?.call(this, event)
          })
        },
      })
    })
    o.mock.dropSockets()
    await until(
      "the socket to reconnect",
      () => o.page.evaluate(() => (window as unknown as { wrapped: number }).wrapped > 0),
      10_000,
    )
    await untilCount(panel, 30)
    await until("the list at the bottom", async () => (await listScroll(panel)).gap <= 1)
    await settledTop(articles(panel).last())

    await o.page.evaluate(() => {
      ;(window as unknown as { held: (() => void)[] }).held = []
    })
    o.mock.pushMessage(agentMessage(31))
    await until("the push to be held", () =>
      o.page.evaluate(() => (window as unknown as { held: unknown[] }).held.length === 1),
    )
    const grown = await log(panel).evaluate((el) => {
      const last = [...el.querySelectorAll("article")].at(-1) as HTMLElement
      last.style.paddingBottom = "300px"
      for (const deliver of (window as unknown as { held: (() => void)[] }).held) deliver()
      return el.scrollHeight - el.scrollTop - el.clientHeight
    })
    expect(grown).toBeGreaterThan(24)
    await untilCount(panel, 31)
    await until("the list at the bottom", async () => (await listScroll(panel)).gap <= 1)
  }, 30_000)

  test("a pushed message is followed from 24 px above the bottom but not from 25", async () => {
    const o = await open({ messages: seeded(29) })
    const panel = await openConversation(o)
    await untilCount(panel, 29)
    await pushUntil(o, agentMessage(30), async () => (await articles(panel).count()) === 30)
    await sizeEveryRow(panel)
    await until("the list at the bottom", async () => (await listScroll(panel)).gap <= 1)

    // One push each: a repeated push re-renders the list between a scroll and its scroll event.
    await scrollListTo(panel, 24)
    expect((await listScroll(panel)).gap).toBe(24)
    o.mock.pushMessage(agentMessage(31))
    await untilCount(panel, 31)
    await until("the list back at the bottom", async () => (await listScroll(panel)).gap <= 1)
    await sizeEveryRow(panel)

    await scrollListTo(panel, 25)
    const at25 = await listScroll(panel)
    expect(at25.gap).toBe(25)
    o.mock.pushMessage(agentMessage(32))
    await untilCount(panel, 32)
    await settledTop(articles(panel).last())
    const after = await listScroll(panel)
    expect(after.top).toBe(at25.top)
    expect(after.gap).toBeGreaterThan(25)
  }, 30_000)

  test("a message stored and a chat change made while the socket was down both show after it reconnects", async () => {
    const o = await open({ messages: seeded(3) })
    const panel = await openConversation(o)
    await untilCount(panel, 3)
    await until("the input", () => input(panel).isVisible())
    o.mock.dropSockets()
    o.mock.pushMessage(agentMessage(4, { text: "Stored while disconnected" }))
    o.mock.setChat({ enabled: true, defaultEnabled: true, reachable: false })
    await until(
      "the stored message",
      async () => (await texts(panel)).includes("Stored while disconnected"),
      10_000,
    )
    await until("the unreachable explanation", () =>
      panel.getByText(`${NAME} can't take page messages right now`).isVisible(),
    )
    expect(await input(panel).count()).toBe(0)
  }, 30_000)
})

describe("conversation: sending from the page", () => {
  test("a sent message shows as sending, then waiting, then taken, exactly once", async () => {
    const o = await open({ messages: [agentMessage(1)] })
    const panel = await openConversation(o)
    await untilCount(panel, 1)
    const release = o.mock.holdPosts()
    let held = true
    try {
      await input(panel).fill("Make the header sticky")
      await input(panel).press("Enter")
      await until("the sending row", async () => (await articles(panel).count()) === 2)
      const row = articles(panel).last()
      expect(await row.textContent()).toContain("Sending…")
      expect(await row.textContent()).toContain("You, from this page")
      expect(await input(panel).inputValue()).toBe("")
      expect(pageMessages(o)).toHaveLength(0)
      release()
      held = false
    } finally {
      if (held) release()
    }
    await until("the waiting line", async () =>
      ((await articles(panel).last().textContent()) ?? "").includes(
        `Waiting for ${NAME} to take it`,
      ),
    )
    expect((await texts(panel)).filter((t) => t === "Make the header sticky")).toHaveLength(1)
    expect(await panel.getByText("Sending…").count()).toBe(0)

    const stored = pageMessages(o)[0]
    expect(stored?.text).toBe("Make the header sticky")
    o.mock.markDelivered(MessageId.parse(stored?.id))
    await until("the taken line", async () =>
      ((await articles(panel).last().textContent()) ?? "").includes(`Taken by ${NAME}`),
    )
    expect(await deliveryLines(articles(panel).last())).toEqual([`Taken by ${NAME}`])
    expect(await articles(panel).last().textContent()).not.toContain("Waiting for")
    expect(await panel.getByText(`Waiting for ${NAME} to take it`).count()).toBe(0)
    expect(await articles(panel).count()).toBe(2)
  }, 30_000)

  test("one row carries a sent message from sending through waiting to taken, and shows the change", async () => {
    const o = await open({ messages: [agentMessage(1)] })
    const panel = await openConversation(o)
    await untilCount(panel, 1)
    const release = o.mock.holdPosts()
    let held = true
    try {
      await input(panel).fill("Make the header sticky")
      await input(panel).press("Enter")
      await until("the sending row", async () => (await articles(panel).count()) === 2)
      const handle = await articles(panel).last().elementHandle()
      if (!handle) throw new Error("no row to follow")
      const state = () =>
        handle.evaluate((el) =>
          ["sending", "queued", "delivered", "failed"].find((name) => el.classList.contains(name)),
        )
      expect(await state()).toBe("sending")
      expect(await handle.evaluate((el) => el.classList.contains("fresh"))).toBe(false)
      release()
      held = false
      await until("waiting", async () => (await state()) === "queued")
      const stored = pageMessages(o)[0]
      o.mock.markDelivered(MessageId.parse(stored?.id))
      await until("taken", async () => (await state()) === "delivered")
      expect(await handle.evaluate((el) => el.isConnected)).toBe(true)
      expect(await handle.evaluate((el) => el.classList.contains("fresh"))).toBe(true)
      expect(await articles(panel).count()).toBe(2)
    } finally {
      if (held) release()
    }
  }, 30_000)

  test("Send message posts too; Shift+Enter makes a new line and blank text sends nothing", async () => {
    const o = await open()
    const panel = await openConversation(o)
    await until("the input", () => input(panel).isVisible())
    await input(panel).fill("   ")
    await input(panel).press("Enter")
    await input(panel).press("Shift+Enter")
    await panel.getByRole("button", { name: "Send message" }).click()
    expect(posts(o)).toHaveLength(0)
    expect(await articles(panel).count()).toBe(0)

    await input(panel).fill("first line")
    await input(panel).press("Shift+Enter")
    await input(panel).pressSequentially("second line")
    expect(await input(panel).inputValue()).toBe("first line\nsecond line")
    expect(posts(o)).toHaveLength(0)
    await panel.getByRole("button", { name: "Send message" }).click()
    await until("the stored message", () => pageMessages(o).length === 1)
    expect(pageMessages(o)[0]?.text).toBe("first line\nsecond line")
    await until("the message row", async () =>
      (await texts(panel)).includes("first line\nsecond line"),
    )
  }, 30_000)

  test("text over the limit says by how much and cannot be sent; text at the limit can", async () => {
    const o = await open()
    const panel = await openConversation(o)
    await until("the input", () => input(panel).isVisible())
    const send = panel.getByRole("button", { name: "Send message" })

    await input(panel).fill("x".repeat(MESSAGE_MAX_CHARS + 1))
    await until("the over-limit line", () =>
      panel.getByText("1 character over the limit").isVisible(),
    )
    expect(await send.isDisabled()).toBe(true)
    await input(panel).press("Enter")
    expect(posts(o)).toHaveLength(0)

    await input(panel).fill(`  ${"x".repeat(MESSAGE_MAX_CHARS + 2)}  `)
    await until("two over", () => panel.getByText("2 characters over the limit").isVisible())

    await input(panel).fill(`  ${"x".repeat(MESSAGE_MAX_CHARS)}  `)
    await until(
      "the line to go",
      async () => (await panel.getByText(/over the limit/).count()) === 0,
    )
    expect(await send.isDisabled()).toBe(false)
    await send.click()
    await until("the stored message", () => pageMessages(o).length === 1)
    expect(pageMessages(o)[0]?.text).toHaveLength(MESSAGE_MAX_CHARS)
  }, 30_000)

  test("a refused message stays visible with the reason; Retry reuses its key and stores one message", async () => {
    const o = await open()
    const panel = await openConversation(o)
    await until("the input", () => input(panel).isVisible())
    o.mock.failNextPost({ outcome: "refused", reason: "session-gone" })
    await input(panel).fill("Retry me")
    await input(panel).press("Enter")
    const row = articles(panel).filter({ hasText: "Retry me" })
    await until("the not-sent row", async () =>
      ((await row.textContent().catch(() => "")) ?? "").includes(`Not sent — ${NAME} ended`),
    )
    expect(pageMessages(o)).toHaveLength(0)

    await row.getByRole("button", { name: "Retry" }).click()
    await until("the stored message", () => pageMessages(o).length === 1)
    await until("the waiting line", async () =>
      ((await row.textContent()) ?? "").includes(`Waiting for ${NAME} to take it`),
    )
    const keys = posts(o).map(
      (request) => (request.body as { idempotencyKey: string }).idempotencyKey,
    )
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1] as string)
    expect(pageMessages(o)).toHaveLength(1)
    expect(await row.count()).toBe(1)
  }, 30_000)

  test("a message the service never got shows why; Discard removes it", async () => {
    const o = await open()
    const panel = await openConversation(o)
    await until("the input", () => input(panel).isVisible())
    await o.page.route(messagesRoute, (route) =>
      route.request().method() === "POST" ? route.abort() : route.fallback(),
    )
    await input(panel).fill("Lost in transit")
    await input(panel).press("Enter")
    const row = articles(panel).filter({ hasText: "Lost in transit" })
    await until("the not-sent row", async () =>
      ((await row.textContent().catch(() => "")) ?? "").includes(
        "Not sent — iter8 isn't reachable",
      ),
    )
    expect(await row.getByRole("button", { name: "Retry" }).isVisible()).toBe(true)
    await row.getByRole("button", { name: "Discard" }).click()
    await until("the row to go", async () => (await row.count()) === 0)
    expect(pageMessages(o)).toHaveLength(0)
  }, 30_000)

  test("unsent text survives closing and reopening the sheet", async () => {
    const o = await open()
    const panel = await openConversation(o)
    await until("the input", () => input(panel).isVisible())
    await input(panel).pressSequentially("half a thought")
    await o.overlay.getByRole("button", { name: "Close round sheet" }).click()
    await until("the sheet to close", async () => (await panel.count()) === 0)
    await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
    await o.overlay.getByRole("tab", { name: "Conversation" }).click()
    await until("the input again", () => input(panel).isVisible())
    expect(await input(panel).inputValue()).toBe("half a thought")
  }, 30_000)

  test("c, r and p typed into the input stay in the input", async () => {
    const o = await open()
    const panel = await openConversation(o)
    await until("the input", () => input(panel).isVisible())
    const pinsBefore = o.mock.prefs().pinsVisible
    await input(panel).focus()
    await o.page.keyboard.type("crp")
    expect(await input(panel).inputValue()).toBe("crp")
    expect(await panel.isVisible()).toBe(true)
    expect(
      await o.overlay.getByRole("button", { name: "Pick element" }).getAttribute("aria-pressed"),
    ).not.toBe("true")
    expect(o.mock.prefs().pinsVisible).toBe(pinsBefore)
    expect(await o.overlay.getByText(/^Pins (hidden|shown)$/).count()).toBe(0)
  }, 30_000)

  test("opening the tab puts the cursor in the input", async () => {
    const o = await open()
    const panel = await openConversation(o)
    await until("the input focused", () => isFocused(input(panel)))
  }, 30_000)

  test("an input that a push brings back does not take the focus", async () => {
    const o = await open({ chat: { enabled: true, defaultEnabled: true, reachable: false } })
    const panel = await openConversation(o)
    await until("the unreachable explanation", () =>
      panel.getByText(`${NAME} can't take page messages right now`).isVisible(),
    )
    o.mock.setChat({ enabled: true, defaultEnabled: true, reachable: true })
    await until("the input", () => input(panel).isVisible())
    expect(await isFocused(input(panel))).toBe(false)
  }, 30_000)

  test("an input that a push brings back after a turn-on came back unreachable does not take the focus", async () => {
    const o = await open({ chat: { enabled: false, defaultEnabled: false, reachable: false } })
    const panel = await openConversation(o)
    await panel.getByRole("button", { name: "Turn on chat for this page" }).click()
    await until("the unreachable explanation", () =>
      panel.getByText(`${NAME} can't take page messages right now`).isVisible(),
    )
    o.mock.setChat({ enabled: true, defaultEnabled: false, reachable: true })
    await until("the input", () => input(panel).isVisible())
    expect(await isFocused(input(panel))).toBe(false)
  }, 30_000)

  test("Enter while an input method is composing does not send", async () => {
    const o = await open()
    const panel = await openConversation(o)
    await until("the input", () => input(panel).isVisible())
    await input(panel).fill("ni hao")
    const enter = (isComposing: boolean) =>
      input(panel).evaluate((el, composing) => {
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            isComposing: composing,
            bubbles: true,
            cancelable: true,
          }),
        )
      }, isComposing)
    await enter(true)
    expect(await input(panel).inputValue()).toBe("ni hao")
    expect(await articles(panel).count()).toBe(0)
    expect(posts(o)).toHaveLength(0)

    await enter(false)
    await until("the message row", async () => (await texts(panel)).includes("ni hao"))
    expect(await input(panel).inputValue()).toBe("")
  }, 30_000)

  test("two messages sent together each show as sending and settle on their own reply, in reverse order", async () => {
    const o = await open()
    const panel = await openConversation(o)
    await until("the input", () => input(panel).isVisible())
    const held: Route[] = []
    await o.page.route(messagesRoute, (route) => {
      if (route.request().method() === "POST") held.push(route)
      else void route.fallback()
    })
    await input(panel).fill("First of two")
    await input(panel).press("Enter")
    await input(panel).fill("Second of two")
    await input(panel).press("Enter")
    await until("both posts held", () => held.length === 2)

    const first = articles(panel).filter({ hasText: "First of two" })
    const second = articles(panel).filter({ hasText: "Second of two" })
    const rowText = async (row: Locator) => (await row.textContent()) ?? ""
    for (const row of [first, second]) {
      expect(await rowText(row)).toContain("You, from this page")
      expect(await rowText(row)).toContain("Sending…")
    }

    await held[1]?.continue()
    await until("the second waiting", async () =>
      (await rowText(second)).includes(`Waiting for ${NAME} to take it`),
    )
    expect(await rowText(first)).toContain("Sending…")

    await held[0]?.continue()
    await until("the first waiting", async () =>
      (await rowText(first)).includes(`Waiting for ${NAME} to take it`),
    )
    expect(await rowText(second)).toContain(`Waiting for ${NAME} to take it`)
    expect((await texts(panel)).toSorted()).toEqual(["First of two", "Second of two"])
    expect(
      pageMessages(o)
        .map((m) => m.text)
        .toSorted(),
    ).toEqual(["First of two", "Second of two"])
  }, 30_000)

  test("each refusal reason reads as its own words, with Retry and Discard", async () => {
    const o = await open()
    const panel = await openConversation(o)
    await until("the input", () => input(panel).isVisible())
    const reasons = [
      ["no-pairing", "Not sent — this page isn't attached to a session"],
      ["stale-generation", "Not sent — this page is now attached to another session"],
      ["chat-off", "Not sent — chat is off for this page"],
      ["unreachable", `Not sent — ${NAME} can't take page messages right now`],
    ] as const
    for (const [reason, words] of reasons) {
      o.mock.failNextPost({ outcome: "refused", reason })
      await until("the input", () => input(panel).isVisible())
      await input(panel).fill(`Refused for ${reason}`)
      await input(panel).press("Enter")
      const row = articles(panel).filter({ hasText: `Refused for ${reason}` })
      await until(`the ${reason} row`, async () =>
        ((await row.textContent().catch(() => "")) ?? "").includes(words),
      )
      expect(await row.getByRole("button", { name: "Retry" }).count()).toBe(1)
      expect(await row.getByRole("button", { name: "Discard" }).count()).toBe(1)
    }
    expect(pageMessages(o)).toHaveLength(0)
  }, 30_000)
})

describe("conversation: runs and following the latest", () => {
  test("messages from one speaker within five minutes share one head and keep every row's label", async () => {
    const o = await open({
      messages: [agentMessage(1), agentMessage(2), agentMessage(3), agentMessage(20)],
    })
    const panel = await openConversation(o)
    await untilCount(panel, 4)
    const rows = await articles(panel).evaluateAll(
      (els, author) =>
        els.map((el) => ({
          head: el.classList.contains("head"),
          last: el.classList.contains("last"),
          meta: el.querySelectorAll(".cv-meta").length,
          label: el.getAttribute("aria-label")?.startsWith(`Claude · ${author}`) ?? false,
          who: el.querySelector(".cv-who")?.textContent ?? null,
          session: el.querySelector(".cv-sess")?.textContent ?? null,
        })),
      NAME,
    )
    expect(rows.map((row) => [row.head, row.last, row.meta])).toEqual([
      [true, false, 1],
      [false, false, 0],
      [false, true, 0],
      [true, true, 1],
    ])
    expect(rows.every((row) => row.label)).toBe(true)
    expect(rows.map((row) => [row.who, row.session])).toEqual([
      ["Claude", NAME],
      [null, null],
      [null, null],
      ["Claude", NAME],
    ])
  }, 30_000)

  test("a history with rows far taller than their first estimate still opens pinned to the bottom", async () => {
    const tall = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of a long report.`).join(
      "\n\n",
    )
    const o = await open({
      messages: [
        agentMessage(1),
        agentMessage(2, { text: tall }),
        agentMessage(3, { text: tall }),
        userMessage(4),
        agentMessage(5),
      ],
    })
    const panel = await openConversation(o)
    await untilCount(panel, 5)
    await until("the list at the bottom", async () => (await listScroll(panel)).gap <= 1)
    expect(await articles(panel).last().isVisible()).toBe(true)
    expect(await panel.getByRole("button", { name: /jump to latest/i }).count()).toBe(0)
  }, 30_000)

  test("scrolled up, new agent messages raise a count and a New line, and the pill takes you back to the bottom", async () => {
    const o = await open({ messages: seeded(29) })
    const panel = await openConversation(o)
    await untilCount(panel, 29)
    await pushUntil(o, agentMessage(30), async () => (await articles(panel).count()) === 30)
    await sizeEveryRow(panel)
    await until("the list at the bottom", async () => (await listScroll(panel)).gap <= 1)
    expect(await panel.getByRole("button", { name: /jump to latest/i }).count()).toBe(0)

    await scrollListTo(panel, 300)
    const pill = panel.getByRole("button", { name: "Jump to latest" })
    await until("the plain pill", () => pill.isVisible())
    o.mock.pushMessage(agentMessage(31))
    await untilCount(panel, 31)
    await until("one unread", () =>
      panel.getByRole("button", { name: "1 new message, jump to latest" }).isVisible(),
    )
    o.mock.pushMessage(agentMessage(32))
    await untilCount(panel, 32)
    const counted = panel.getByRole("button", { name: "2 new messages, jump to latest" })
    await until("two unread", () => counted.isVisible())
    expect(await counted.textContent()).toBe("2new messages")

    const marker = log(panel).getByRole("separator")
    expect(await marker.count()).toBe(1)
    expect(await marker.textContent()).toBe("New")
    expect(
      await marker.evaluate((el) => el.nextElementSibling?.querySelector(".cv-text")?.textContent),
    ).toBe("Agent message 31")

    await counted.click()
    await until(
      "the list back at the bottom",
      async () => (await listScroll(panel)).gap <= 24,
      10_000,
    )
    await until("the pill and the line to go", async () => {
      const left = await panel.getByRole("button", { name: /jump to latest/i }).count()
      return left + (await marker.count()) === 0
    })
  }, 30_000)

  test("a message sent from the page never counts as unread", async () => {
    const o = await open({ messages: seeded(29) })
    const panel = await openConversation(o)
    await untilCount(panel, 29)
    await pushUntil(o, agentMessage(30), async () => (await articles(panel).count()) === 30)
    await sizeEveryRow(panel)
    await until("the list at the bottom", async () => (await listScroll(panel)).gap <= 1)
    await scrollListTo(panel, 300)
    await until("the pill", () => panel.getByRole("button", { name: "Jump to latest" }).isVisible())
    await input(panel).fill("Make the header sticky")
    await input(panel).press("Enter")
    await until("the sent row", async () => (await articles(panel).count()) === 31)
    expect(await panel.getByRole("button", { name: /new message/i }).count()).toBe(0)
    expect(await log(panel).getByRole("separator").count()).toBe(0)
  }, 30_000)
})

describe("conversation: what the panel shows", () => {
  test("the panel says Loading… and Checking chat… while its first requests are out, with no input", async () => {
    const o = await open({ messages: seeded(3) })
    const heldPages: Route[] = []
    const heldChecks: Route[] = []
    await o.page.route(firstPage, (route) => {
      if (route.request().method() === "GET") heldPages.push(route)
      else void route.fallback()
    })
    await o.page.route(chatRoute, (route) => {
      if (route.request().method() === "GET") heldChecks.push(route)
      else void route.fallback()
    })
    const panel = await openConversation(o)
    await until("both requests held", () => heldPages.length === 1 && heldChecks.length === 1)
    await until("the loading line", () => panel.getByText("Loading…").isVisible())
    expect(await panel.getByText("Checking chat…").isVisible()).toBe(true)
    expect(await input(panel).count()).toBe(0)
    expect(await articles(panel).count()).toBe(0)

    await heldPages[0]?.continue()
    await untilCount(panel, 3)
    expect(await panel.getByText("Loading…").count()).toBe(0)
    expect(await input(panel).count()).toBe(0)

    await heldChecks[0]?.continue()
    await until("the input", () => input(panel).isVisible())
    expect(await panel.getByText("Checking chat…").count()).toBe(0)
  }, 30_000)

  test("typing in the input never re-renders the message list", async () => {
    const o = await open({ messages: seeded(5) })
    const panel = await openConversation(o)
    await untilCount(panel, 5)
    await until("the input", () => input(panel).isVisible())
    // A MutationObserver alone misses a re-render that changes nothing; Preact replaces the stored
    // inline onScroll handler on every render of the list, so its identity is the render probe.
    type Probed = HTMLElement & { __e?: { onScroll?: unknown }; __was?: unknown; __muts?: number }
    const watch = () =>
      log(panel).evaluate((node) => {
        const el = node as Probed
        el.__was = el.__e?.onScroll
        el.__muts = 0
        new MutationObserver((records) => {
          el.__muts = (el.__muts ?? 0) + records.length
        }).observe(el, { subtree: true, childList: true, attributes: true, characterData: true })
        return typeof el.__was === "function"
      })
    const rendered = () =>
      log(panel).evaluate((node) => {
        const el = node as Probed
        return { again: el.__e?.onScroll !== el.__was, mutations: el.__muts ?? 0 }
      })
    if (!(await watch())) {
      throw new Error(
        "the render probe cannot see the list's onScroll handler: the Preact internal __e moved, update the probe",
      )
    }

    await input(panel).pressSequentially("typing should leave the list alone", { delay: 10 })
    await input(panel).press("Shift+Enter")
    await input(panel).fill("x".repeat(MESSAGE_MAX_CHARS + 5))
    await until("the over-limit line", () =>
      panel.getByText("5 characters over the limit").isVisible(),
    )
    expect(await rendered()).toEqual({ again: false, mutations: 0 })

    await pushUntil(o, agentMessage(6), async () => (await articles(panel).count()) === 6)
    expect((await rendered()).again).toBe(true)
  }, 60_000)

  test("while the session is busy a placeholder in Claude's lane ends the list, and it goes when a message lands or the session goes idle", async () => {
    const busy = { ...LIVE, state: { status: "busy" } } as const
    const o = await open({ pairing: busy, messages: [agentMessage(1)] })
    const panel = await openConversation(o)
    await untilCount(panel, 1)
    const work = log(panel).locator(".cv-work")
    await until("the placeholder", () => work.isVisible())
    expect(await panel.getByText("each message appears here when it finishes").count()).toBe(0)
    expect(await panel.locator(".busyline, .meter").count()).toBe(0)
    expect(await articles(panel).count()).toBe(1)

    expect(await work.evaluate((el) => el === el.parentElement?.lastElementChild)).toBe(true)
    expect(await work.locator(".cv-who").textContent()).toBe("Claude")
    expect(await work.locator(".cv-sess").textContent()).toBe("writing")
    expect(await work.locator("time").count()).toBe(0)
    const bars = await work.locator(".cv-bars").evaluate((el) => {
      const lane = el.getBoundingClientRect().width
      return Array.from(el.children, (bar) => bar.getBoundingClientRect().width / lane)
    })
    expect(bars).toHaveLength(3)
    const [first, second, third] = bars as [number, number, number]
    expect(first).toBeCloseTo(0.94, 1)
    expect(second).toBeCloseTo(0.8, 1)
    expect(third).toBeCloseTo(0.52, 1)
    const lanes = await log(panel).evaluate((el) => {
      const left = (selector: string) =>
        (el.querySelector(selector) as HTMLElement).getBoundingClientRect().left
      return { prose: left(".cv-prose"), bars: left(".cv-bars") }
    })
    expect(Math.abs(lanes.prose - lanes.bars)).toBeLessThanOrEqual(1)

    const fills = await work.locator(".cv-bars i").evaluateAll((bars) =>
      bars.map((bar) => {
        const fill = getComputedStyle(bar, "::after")
        return {
          animation: fill.animationName,
          delay: fill.animationDelay,
          origin: fill.transformOrigin.split(" ")[0],
        }
      }),
    )
    expect(fills.map((fill) => fill.animation)).toEqual(["cv-fill", "cv-fill", "cv-fill"])
    expect(fills.map((fill) => fill.delay)).toEqual(["0s", "0.35s", "0.7s"])
    expect(fills.map((fill) => fill.origin)).toEqual(["0px", "0px", "0px"])

    const live = panel.getByRole("status").filter({ hasText: `${NAME} is working` })
    expect(await live.count()).toBe(1)

    await pushUntil(o, agentMessage(2), async () => (await articles(panel).count()) === 2)
    await until("the placeholder to go with the message", async () => (await work.count()) === 0)

    await waitFor(
      "the idle pairing",
      async () => {
        o.mock.push({ type: "pairing", pairing: LIVE })
        return (await live.count()) === 0 ? true : null
      },
      { timeoutMs: 5000, everyMs: 150 },
    )
    expect(await work.count()).toBe(0)
  }, 30_000)

  test("the placeholder returns when a session turns busy again, and shows nothing for an idle one", async () => {
    const o = await open({ messages: [agentMessage(1)] })
    const panel = await openConversation(o)
    await untilCount(panel, 1)
    const work = log(panel).locator(".cv-work")
    expect(await work.count()).toBe(0)
    const busy = { ...LIVE, state: { status: "busy" } } as const
    await waitFor(
      "the busy pairing",
      async () => {
        o.mock.push({ type: "pairing", pairing: busy })
        return (await work.count()) === 1 ? true : null
      },
      { timeoutMs: 5000, everyMs: 150 },
    )
    expect(await work.isVisible()).toBe(true)
  }, 30_000)

  test("with reduced motion the placeholder bars stand still", async () => {
    const o = await open({ pairing: { ...LIVE, state: { status: "busy" } }, messages: [] })
    await o.page.emulateMedia({ reducedMotion: "reduce" })
    const panel = await openConversation(o)
    const work = log(panel).locator(".cv-work")
    await until("the placeholder", () => work.isVisible())
    expect(
      await work.evaluate(
        (el) =>
          el
            .getAnimations({ subtree: true })
            .filter((a) => a instanceof CSSAnimation && a.animationName === "cv-fill").length,
      ),
    ).toBe(0)
  }, 30_000)

  test("message text keeps its whitespace and wraps anywhere; rows skip offscreen work; the input grows to a cap", async () => {
    const spaced = "two  spaces\n    indented line"
    const unbroken = "x".repeat(600)
    const o = await open({
      messages: [agentMessage(1, { text: spaced }), agentMessage(2, { text: unbroken })],
    })
    const panel = await openConversation(o)
    await untilCount(panel, 2)
    const looks = await articles(panel).evaluateAll((rows) =>
      rows.map((row) => {
        const text = row.querySelector(".cv-text") as HTMLElement
        const rowStyle = getComputedStyle(row)
        return {
          contentVisibility: rowStyle.contentVisibility,
          intrinsicHeight: rowStyle.containIntrinsicHeight,
          lineHeight: Number.parseFloat(getComputedStyle(text).lineHeight),
          height: text.getBoundingClientRect().height,
          overflows: text.scrollWidth > text.clientWidth,
          inRow: text.getBoundingClientRect().right <= row.getBoundingClientRect().right,
          firstLine: text.innerText.split("\n")[0],
        }
      }),
    )
    const [spacedRow, unbrokenRow] = looks as [(typeof looks)[0], (typeof looks)[0]]
    for (const row of looks) {
      expect(row.contentVisibility).toBe("auto")
      expect(row.intrinsicHeight).toBe("auto 76px")
    }
    expect(spacedRow.firstLine).toBe("two  spaces")
    expect(spacedRow.height).toBeGreaterThanOrEqual(2 * spacedRow.lineHeight - 1)
    expect(unbrokenRow.overflows).toBe(false)
    expect(unbrokenRow.inRow).toBe(true)
    expect(unbrokenRow.height).toBeGreaterThan(2 * unbrokenRow.lineHeight)

    const field = input(panel)
    await until("the input", () => field.isVisible())
    const height = () => field.evaluate((el) => el.getBoundingClientRect().height)
    const empty = await height()
    await field.fill("one\ntwo\nthree")
    const three = await height()
    expect(three).toBeGreaterThan(empty)
    await field.fill(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"))
    const cap = await field.evaluate((el) => Number.parseFloat(getComputedStyle(el).maxHeight))
    expect(Number.isFinite(cap)).toBe(true)
    expect(await height()).toBeCloseTo(cap, 0)
    expect(await field.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  }, 30_000)
})

describe("conversation: when chat cannot be used", () => {
  test("chat off explains why and turns on for this page; chat on by default shows no such line", async () => {
    const o = await open({ chat: { enabled: false, defaultEnabled: false, reachable: true } })
    const panel = await openConversation(o)
    const turnOn = panel.getByRole("button", { name: "Turn on chat for this page" })
    await until("the turn-on button", () => turnOn.isVisible())
    expect(
      await panel
        .getByText(
          `Chat is off for this page. Pages that aren't local could send text to ${NAME} as if you typed it.`,
        )
        .isVisible(),
    ).toBe(true)
    expect(await input(panel).count()).toBe(0)

    await turnOn.click()
    await until("the input", () => input(panel).isVisible())
    const toggles = o.mock
      .requests()
      .filter((request) => request.method === "PUT" && request.path === CHAT_PATH)
    expect(toggles.map((request) => request.body)).toEqual([{ enabled: true }])
    expect(await panel.getByText("Chat is on for this page").isVisible()).toBe(true)

    await panel.getByRole("button", { name: "Turn off" }).click()
    await until("the turn-on button again", () => turnOn.isVisible())
    expect(await input(panel).count()).toBe(0)
    expect(o.mock.chat().enabled).toBe(false)
    await o.close()
    opened = null

    const on = await open({ chat: { enabled: true, defaultEnabled: true, reachable: true } })
    const onPanel = await openConversation(on)
    await until("the input", () => input(onPanel).isVisible())
    expect(await onPanel.getByText("Chat is on for this page").count()).toBe(0)
  }, 30_000)

  test("a failed turn-on says so and leaves chat off", async () => {
    const o = await open({ chat: { enabled: false, defaultEnabled: false, reachable: true } })
    const panel = await openConversation(o)
    const turnOn = panel.getByRole("button", { name: "Turn on chat for this page" })
    await until("the turn-on button", () => turnOn.isVisible())
    await o.page.route(chatRoute, (route) =>
      route.request().method() === "PUT" ? route.fulfill({ status: 500 }) : route.fallback(),
    )
    await turnOn.click()
    await until("a failure toast", () =>
      o.overlay.getByText("Couldn't turn on chat — try again").isVisible(),
    )
    expect(await turnOn.isVisible()).toBe(true)
    expect(await input(panel).count()).toBe(0)
  }, 30_000)

  test("a failed turn-off says so and keeps chat on", async () => {
    const o = await open({ chat: { enabled: true, defaultEnabled: false, reachable: true } })
    const panel = await openConversation(o)
    const turnOff = panel.getByRole("button", { name: "Turn off" })
    await until("the turn-off button", () => turnOff.isVisible())
    await o.page.route(chatRoute, (route) =>
      route.request().method() === "PUT" ? route.fulfill({ status: 500 }) : route.fallback(),
    )
    await turnOff.click()
    await until("a failure toast", () =>
      o.overlay.getByText("Couldn't turn off chat — try again").isVisible(),
    )
    expect(await panel.getByText("Chat is on for this page").isVisible()).toBe(true)
    expect(await input(panel).isVisible()).toBe(true)
    expect(o.mock.chat().enabled).toBe(true)
  }, 30_000)

  test("a failed chat check says so and Retry checks again", async () => {
    const o = await open()
    await o.page.route(chatRoute, (route) => route.fulfill({ status: 500 }))
    const panel = await openConversation(o)
    await until("the check failure", () =>
      panel.getByText("Couldn't check chat for this page").isVisible(),
    )
    expect(await input(panel).count()).toBe(0)
    await o.page.unroute(chatRoute)
    await panel.getByRole("button", { name: "Retry" }).click()
    await until("the input", () => input(panel).isVisible())
  }, 30_000)

  test("a session that cannot take page messages says so instead of an input, until it can", async () => {
    const o = await open({ chat: { enabled: true, defaultEnabled: true, reachable: false } })
    const panel = await openConversation(o)
    const why = panel.getByText(
      `${NAME} can't take page messages right now. Chat reaches a session only through the iter8 mod in Claude Code's terminal or desktop app; notes still work.`,
    )
    await until("the unreachable explanation", () => why.isVisible())
    expect(await input(panel).count()).toBe(0)
    await waitFor(
      "the input to appear",
      async () => {
        o.mock.setChat({ enabled: true, defaultEnabled: true, reachable: true })
        return (await input(panel).isVisible()) ? true : null
      },
      { timeoutMs: 5000, everyMs: 150 },
    )
    expect(await why.count()).toBe(0)
  }, 30_000)

  test("a page with no session says so and offers attach, with no input", async () => {
    const o = await open({ pairing: null, liveSessions: [OTHER] })
    const panel = await openConversation(o)
    await until("the attach offer", () =>
      panel.getByRole("button", { name: `Attach to ${NAME}` }).isVisible(),
    )
    expect(await panel.getByText("Not attached").isVisible()).toBe(true)
    expect(await input(panel).count()).toBe(0)
  }, 30_000)

  test("a page whose session ended says so and offers attach, with no input", async () => {
    const o = await open({ pairing: GONE, liveSessions: [GONE_SESSION, OTHER] })
    const panel = await openConversation(o)
    await until("the attach offer", () =>
      panel.getByRole("button", { name: `Attach to ${NAME}` }).isVisible(),
    )
    expect(await panel.getByText("Session ended").isVisible()).toBe(true)
    expect(await input(panel).count()).toBe(0)
  }, 30_000)

  test("a session that ends while the tab is open takes the input away", async () => {
    const o = await open({ liveSessions: [OTHER] })
    const panel = await openConversation(o)
    await until("the input", () => input(panel).isVisible())
    await waitFor(
      "the ended session",
      async () => {
        o.mock.push({ type: "pairing", pairing: GONE })
        return (await panel.getByText("Session ended").isVisible()) ? true : null
      },
      { timeoutMs: 5000, everyMs: 150 },
    )
    expect(await input(panel).count()).toBe(0)
  }, 30_000)
})

describe("conversation: how messages look", () => {
  const SESSION_ID = "da7e6daa-e3c9-4de2-ba84-17c5af642da4"

  test("a header names the session the way the dock does, never its id", async () => {
    const message = ConversationMessage.parse({
      ...agentMessage(1),
      author: { ...agentJson.author, name: SESSION_ID },
    })
    const o = await open({ messages: [message] })
    const panel = await openConversation(o)
    await untilCount(panel, 1)
    const head = log(panel).locator(".cv-meta")
    expect(await head.locator(".cv-who").textContent()).toBe("Claude")
    expect(await head.locator(".cv-sess").textContent()).toBe(NAME)
    expect(await head.locator(".cv-sess").textContent()).toBe(
      await o.overlay.locator(".dock .proj").textContent(),
    )
    expect(await log(panel).textContent()).not.toContain(SESSION_ID)
    expect(await articles(panel).first().getAttribute("aria-label")).not.toContain(SESSION_ID)
  }, 30_000)

  test("Claude's messages are unboxed prose under one header with a mark, the name and the time", async () => {
    const o = await open({ messages: [agentMessage(1), agentMessage(2)] })
    const panel = await openConversation(o)
    await untilCount(panel, 2)
    expect(await panel.locator(".cv-card").count()).toBe(0)
    expect(await log(panel).locator(".cv-meta").count()).toBe(1)
    const seen = await log(panel).evaluate((el) => {
      const head = el.querySelector(".cv-meta") as HTMLElement
      const mark = head.querySelector("[role=img]") as HTMLElement
      const markBox = mark.getBoundingClientRect()
      const who = head.querySelector(".cv-who") as HTMLElement
      const time = head.querySelector("time") as HTMLElement
      const article = el.querySelector("article") as HTMLElement
      const prose = Array.from(el.querySelectorAll<HTMLElement>(".cv-prose"), (node) => {
        const style = getComputedStyle(node)
        return {
          background: style.backgroundColor,
          border: style.borderTopWidth,
          shadow: style.boxShadow,
          left: node.getBoundingClientRect().left,
        }
      })
      const articleStyle = getComputedStyle(article)
      return {
        mark: markBox.width,
        markBackground: getComputedStyle(mark).backgroundColor,
        whoLeft: who.getBoundingClientRect().left,
        timeRight: time.getBoundingClientRect().right,
        headRight: head.getBoundingClientRect().right,
        prose,
        articleBorder: articleStyle.borderBottomWidth,
        articleShadow: articleStyle.boxShadow,
      }
    })
    expect(seen.mark).toBe(18)
    expect(seen.markBackground).toBe("rgba(0, 0, 0, 0)")
    expect(seen.timeRight).toBeCloseTo(seen.headRight, 0)
    for (const prose of seen.prose) {
      expect(prose.background).toBe("rgba(0, 0, 0, 0)")
      expect(prose.border).toBe("0px")
      expect(prose.shadow).toBe("none")
      expect(Math.abs(prose.left - seen.whoLeft)).toBeLessThanOrEqual(1)
    }
    expect(seen.prose).toHaveLength(2)
    expect(seen.articleBorder).toBe("0px")
    expect(seen.articleShadow).toBe("none")
  }, 30_000)

  test("your own messages are compact right-aligned bubbles with the time and delivery below", async () => {
    const delivered = ConversationMessage.parse({
      ...pageMessage(2),
      author: {
        kind: "page",
        idempotencyKey: "chat-seed-2",
        delivery: { status: "delivered", at: at(3) },
      },
    })
    const o = await open({ messages: [agentMessage(1), delivered, userMessage(3)] })
    const panel = await openConversation(o)
    await untilCount(panel, 3)
    const rows = await articles(panel).evaluateAll((els) =>
      els.map((el) => {
        const list = el.closest("[role=log]") as HTMLElement
        const bubble = el.querySelector(".cv-bubble") as HTMLElement | null
        const foot = el.querySelector(".cv-foot") as HTMLElement | null
        if (!bubble || !foot) return null
        const box = bubble.getBoundingClientRect()
        const listBox = list.getBoundingClientRect()
        const style = getComputedStyle(bubble)
        return {
          rightGap: listBox.right - box.right,
          leftGap: box.left - listBox.left,
          corners: [
            style.borderTopLeftRadius,
            style.borderTopRightRadius,
            style.borderBottomRightRadius,
            style.borderBottomLeftRadius,
          ],
          fill: style.backgroundColor,
          footBelow: foot.getBoundingClientRect().top >= box.bottom,
          footRight: foot.getBoundingClientRect().right,
          bubbleRight: box.right,
          time: foot.querySelector("time")?.textContent ?? "",
          glyphs: foot.querySelectorAll("svg").length,
          round: Array.from(foot.querySelectorAll("*")).some(
            (node) => getComputedStyle(node).borderRadius === "50%",
          ),
          header: el.querySelector(".cv-meta") !== null,
        }
      }),
    )
    expect(rows[0]).toBeNull()
    for (const row of [rows[1], rows[2]]) {
      if (!row) throw new Error("no bubble")
      expect(row.corners).toEqual(["16px", "16px", "5px", "16px"])
      expect(row.fill).not.toBe("rgba(0, 0, 0, 0)")
      expect(row.rightGap).toBeLessThanOrEqual(14)
      expect(row.leftGap).toBeGreaterThan(40)
      expect(row.footBelow).toBe(true)
      expect(Math.abs(row.footRight - row.bubbleRight)).toBeLessThanOrEqual(4)
      expect(row.time).toBe(await clockTime(o, at(row === rows[1] ? 2 : 3)))
      expect(row.glyphs).toBeGreaterThan(0)
      expect(row.round).toBe(false)
      expect(row.header).toBe(false)
    }
    expect(await deliveryLines(articles(panel).nth(1))).toEqual([`Taken by ${NAME}`])
    expect(await articles(panel).nth(1).locator(".cv-foot .sg-delivered").count()).toBe(1)
  }, 30_000)

  test("a round divider is a hairline either side of a small centred sentence-case label", async () => {
    const round = Round.parse({
      ...roundJson,
      id: "R1",
      pageId: PAGE,
      notes: roundJson.notes.map((note) => ({ ...note, pageId: PAGE })),
    })
    const o = await open({
      pageState: { drafts: [], rounds: [round], agentNotes: [] },
      messages: [agentMessage(1, { roundId: round.id })],
    })
    const panel = await openConversation(o)
    await untilCount(panel, 1)
    const divider = panel.getByRole("button", { name: /^Round 1/ })
    const seen = await divider.evaluate((el) => {
      const label = el.querySelector(".rn") as HTMLElement
      const box = el.getBoundingClientRect()
      const labelBox = label.getBoundingClientRect()
      const before = getComputedStyle(el, "::before")
      const after = getComputedStyle(el, "::after")
      const style = getComputedStyle(label)
      return {
        text: label.textContent,
        centre: labelBox.left + labelBox.width / 2 - (box.left + box.width / 2),
        hairlines: [before.height, after.height],
        fill: style.backgroundColor,
        border: style.borderTopWidth,
        transform: style.textTransform,
        spacing: style.letterSpacing,
        family: style.fontFamily,
        size: Number.parseFloat(style.fontSize),
      }
    })
    expect(seen.text).toBe("Round 1 · done")
    expect(Math.abs(seen.centre)).toBeLessThanOrEqual(1)
    expect(seen.hairlines).toEqual(["1px", "1px"])
    expect(seen.fill).toBe("rgba(0, 0, 0, 0)")
    expect(seen.border).toBe("0px")
    expect(seen.transform).toBe("none")
    expect(seen.spacing).toBe("normal")
    expect(seen.family).not.toContain("JetBrains")
    expect(seen.size).toBeLessThanOrEqual(12)
  }, 30_000)

  test("copy is reachable by hover and by keyboard focus on both sides, and retry stays reachable", async () => {
    const o = await open({ messages: [agentMessage(1), pageMessage(2)] })
    const panel = await openConversation(o)
    await untilCount(panel, 2)
    const opacity = (copy: Locator) =>
      copy.evaluate((el) => getComputedStyle(el.parentElement as Element).opacity)
    for (const row of [articles(panel).nth(0), articles(panel).nth(1)]) {
      const copy = row.getByRole("button", { name: "Copy message" })
      expect(await opacity(copy)).toBe("0")
      await row.hover()
      await until("the copy button", async () => (await opacity(copy)) === "1")
      await o.page.mouse.move(0, 0)
      await until("the copy button to hide", async () => (await opacity(copy)) === "0")
      await copy.focus()
      await until("the copy button on focus", async () => (await opacity(copy)) === "1")
    }

    o.mock.failNextPost({ outcome: "refused", reason: "session-gone" })
    await input(panel).fill("Retry me")
    await input(panel).press("Enter")
    const row = articles(panel).filter({ hasText: "Retry me" })
    await until("the not-sent row", async () =>
      ((await row.textContent().catch(() => "")) ?? "").includes("Not sent"),
    )
    expect(await row.getByRole("button", { name: "Retry" }).isVisible()).toBe(true)
    expect(await row.getByRole("button", { name: "Discard" }).isVisible()).toBe(true)
  }, 30_000)

  test("nothing in the panel renders the old meter or card", async () => {
    const o = await open({
      pairing: { ...LIVE, state: { status: "busy" } },
      messages: seeded(6),
    })
    const panel = await openConversation(o)
    await untilCount(panel, 6)
    expect(await o.overlay.locator(".meter, .cv-card, .busyline, .vu").count()).toBe(0)
  }, 30_000)
})
