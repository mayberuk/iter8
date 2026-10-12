import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { ConversationMessage, Pairing } from "@iter8/protocol"
import type { Browser, Locator } from "playwright"
import agentJson from "../../../packages/protocol/fixtures/ConversationMessage.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const LIVE = Pairing.parse(pairingJson)
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const TRACKER = "https://tracker.test/pixel.png?d=secret"
const CODE = 'const answer: number = 42 // the answer\nconsole.log("done")'

const SOURCE = `# Round 3: the pricing card

Both notes are fixed. See the [pricing docs](https://example.test/docs) and [a script](javascript:alert(1)),
or write to [the team](mailto:team@example.test). Inline \`PricingCard.tsx\` and **bold** and ~~gone~~.

> [!WARNING]
> The old class is still referenced in two places.

- [x] price stays on one line
- [ ] check the footer link
  - nested point

| Component | Where it is used | Owner | Status | Last run | Duration | Notes about the run |
|:--|--:|:--|:--|:--|:--|:--|
| PricingCardWithAnExtremelyLongNameThatNeverBreaksAnywhere | the pricing page and the checkout summary | design systems | passing | 2026-10-09 | 12.4 s | needs a second look at the narrow breakpoint |
| ToggleHeight | the plan switcher in the header | web platform | failing | 2026-10-08 | 31.0 s | the toggle is 36px but the CTA is 40px |

\`\`\`ts
${CODE}
\`\`\`

![tracking pixel](${TRACKER})

![local pixel](${PIXEL})

A claim that needs a source[^1].

[^1]: The measurement is in the design review.
`

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

async function open() {
  const message = ConversationMessage.parse({
    ...agentJson,
    id: "M1",
    pageId: "mockpage",
    roundId: null,
    author: { ...agentJson.author, name: "larkspur" },
    text: SOURCE,
    at: "2026-10-09T10:00:00.000Z",
  })
  const o = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: STATIC,
    mock: { pairing: LIVE, messages: [message] },
    browser,
  })
  opened = o
  const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
  await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
  await waitFor("the round sheet", async () => ((await sheet.isVisible()) ? true : null))
  await sheet.getByRole("tab", { name: "Conversation" }).click()
  const panel = sheet.getByRole("tabpanel", { name: "Conversation" })
  const body = panel.getByRole("log").getByRole("article").locator(".md")
  await waitFor("the markdown message", async () => ((await body.isVisible()) ? true : null))
  return { o, sheet, panel, body }
}

const horizontalOverflow = (el: Locator) =>
  el.evaluate((node) => node.scrollWidth - node.clientWidth)

test("a wide table scrolls inside its own box and nothing around it does", async () => {
  const { o, sheet, panel, body } = await open()
  const table = body.getByRole("region", { name: "Table, scrolls sideways" })
  expect(await horizontalOverflow(table)).toBeGreaterThan(100)
  await table.evaluate((node) => node.scrollTo({ left: 80 }))
  expect(await table.evaluate((node) => node.scrollLeft)).toBe(80)

  const log = panel.getByRole("log")
  expect(await horizontalOverflow(log)).toBe(0)
  expect(await horizontalOverflow(sheet)).toBe(0)
  expect(await log.evaluate((node) => node.scrollLeft)).toBe(0)
  expect(
    await o.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0)

  expect(
    await table.evaluate(
      (node) =>
        Array.from(node.querySelectorAll("td:first-child")).filter(
          (cell) => cell.scrollWidth > cell.clientWidth,
        ).length,
    ),
  ).toBe(0)

  const card = await body.evaluate((node) => node.getBoundingClientRect().width)
  const box = await table.evaluate((node) => node.getBoundingClientRect().width)
  expect(box).toBeLessThanOrEqual(card)
})

test("elements render as elements, the page heading is a heading and raw script is absent", async () => {
  const { o, body } = await open()
  expect(await body.getByRole("heading", { level: 1 }).textContent()).toBe(
    "Round 3: the pricing card",
  )
  expect(await body.locator("li:not([data-fn])").count()).toBe(3)
  expect(await body.locator("input[type=checkbox]:checked").count()).toBe(1)
  expect(await body.locator(".md-alert[data-kind=warning]").count()).toBe(1)
  expect(await body.locator("th").count()).toBe(7)
  expect(await body.locator("strong").textContent()).toBe("bold")
  expect(await body.locator("del").textContent()).toBe("gone")
  expect(o.errors).toEqual([])
})

test("code is highlighted after it first shows, and its text is exactly what was written", async () => {
  const { body } = await open()
  const code = body.locator(".md-code")
  await waitFor("highlighted tokens", async () =>
    (await code.locator(".tk-kw").count()) > 0 ? true : null,
  )
  expect(await code.locator(".tk-kw").first().textContent()).toBe("const")
  expect((await code.locator(".tk-str").allTextContents()).join("")).toBe('"done"')
  expect(await code.locator(".tk-cm").first().textContent()).toBe("// the answer")
  const lines = await code.locator(".line").allTextContents()
  expect(lines.join("\n")).toBe(CODE)
  expect(await code.locator(".md-lang").textContent()).toBe("ts")
})

test("the copy button puts the code text on the clipboard", async () => {
  const { o, body } = await open()
  await o.page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          Reflect.set(window, "copied", text)
        },
      },
    })
  })
  const copy = body.locator(".md-copy")
  await copy.click()
  await waitFor("the copy", async () =>
    (await copy.getAttribute("class"))?.includes("done") ? true : null,
  )
  expect(await o.page.evaluate(() => Reflect.get(window, "copied"))).toBe(CODE)
})

test("an image from another origin is a chip that loads only when clicked", async () => {
  const { o, body } = await open()
  const requests: string[] = []
  await o.page.route("https://tracker.test/**", (route) => {
    requests.push(route.request().url())
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(PIXEL.split(",")[1] ?? "", "base64"),
    })
  })
  const chip = body.getByRole("button", { name: /Load image from tracker\.test/ })
  expect(await chip.textContent()).toContain("tracking pixel")
  expect(await chip.textContent()).toContain("tracker.test")
  expect(await body.locator("img").count()).toBe(1)
  expect(await body.locator("img").getAttribute("src")).toBe(PIXEL)
  expect(requests).toEqual([])

  await chip.click()
  const loaded = body.locator('img[alt="tracking pixel"]')
  await waitFor("the image", async () => ((await loaded.count()) === 1 ? true : null))
  expect(await loaded.getAttribute("referrerpolicy")).toBe("no-referrer")
  await waitFor("the request", async () => (requests.length === 1 ? true : null))
  expect(requests).toEqual([TRACKER])
})

test("a link with an unsafe scheme is plain text, and the others open in a new tab without an opener", async () => {
  const { o, body } = await open()
  expect(await body.getByRole("link", { name: "a script" }).count()).toBe(0)
  expect(await body.getByText("a script").count()).toBe(1)
  expect(await body.locator('a[href^="javascript"]').count()).toBe(0)

  for (const [name, href] of [
    ["pricing docs", "https://example.test/docs"],
    ["the team", "mailto:team@example.test"],
  ] as const) {
    const link = body.getByRole("link", { name })
    expect(await link.getAttribute("href")).toBe(href)
    expect(await link.getAttribute("target")).toBe("_blank")
    expect(await link.getAttribute("rel")).toBe("noopener noreferrer")
  }
  expect(o.page.url()).not.toContain("javascript")
})

test("a footnote reference flashes its note and the note jumps back", async () => {
  const { body } = await open()
  const note = body.locator("li[data-fn]")
  expect(await note.count()).toBe(1)
  expect(await note.getAttribute("class")).toBeNull()
  await body.getByRole("button", { name: "Footnote 1" }).click()
  expect(await note.getAttribute("class")).toBe("hit")
  await note.getByRole("button", { name: "Back to the text" }).click()
  expect(await body.getByRole("button", { name: "Footnote 1" }).isVisible()).toBe(true)
})
