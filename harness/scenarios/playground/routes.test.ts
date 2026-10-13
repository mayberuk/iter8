import { expect, test } from "bun:test"
import { join } from "node:path"
import { OpenResult } from "@iter8/protocol"
import type { Page } from "playwright"
import { fixtureDir } from "../../rig/fixtures"
import { waitFor } from "../../rig/wait"
import { type Rig, withPlayground, withRig } from "./support"

const MOUNT_TIMEOUT_MS = 30_000

type Marker = "home" | "pricing" | "dashboard" | "customers" | "settings" | "heavy"

const ROUTES: [string, Marker][] = [
  ["/", "home"],
  ["/pricing", "pricing"],
  ["/app", "dashboard"],
  ["/app/customers", "customers"],
  ["/app/settings", "settings"],
  ["/heavy", "heavy"],
]

const markersOf = (page: Page): Promise<Record<Marker, boolean>> =>
  page.evaluate(() => {
    const count = (selector: string) => document.querySelectorAll(selector).length
    const headings = [...document.querySelectorAll("h2")].map((h) => h.id)
    const labelled = (text: string) =>
      [...document.querySelectorAll("label")].some((label) => label.textContent === text)
    const activity = document.querySelector('ul[aria-label="Recent activity"]')
    const header = document.querySelector("thead th")
    return {
      home:
        (document.querySelector("h1")?.textContent ?? "").includes(
          "release notes that write themselves",
        ) && count("pg-rating") === 1,
      pricing: ["tier-Starter", "tier-Team", "tier-Scale"].every((id) => headings.includes(id)),
      dashboard:
        count('svg[aria-label="Drafts generated per month"] path[d^="M"]') >= 1 &&
        activity !== null &&
        activity.children.length === 40 &&
        getComputedStyle(activity).overflowY === "auto" &&
        activity.scrollHeight > activity.clientHeight,
      customers:
        count("tbody tr") === 200 &&
        header !== null &&
        getComputedStyle(header).position === "sticky",
      settings:
        ["Full name", "Work email", "Company"].every(labelled) &&
        [...document.querySelectorAll("button")].some((b) => b.textContent === "Delete workspace"),
      heavy:
        count("tbody tr") === 6000 &&
        [...document.querySelectorAll("tbody td")].some((td) =>
          /tick \d+/.test(td.textContent ?? ""),
        ),
    }
  })

const overlayMounted = (page: Page, label: string) =>
  waitFor(
    label,
    () => page.evaluate(() => (document.querySelector("iter8-overlay")?.shadowRoot ? true : null)),
    { timeoutMs: MOUNT_TIMEOUT_MS, everyMs: 100 },
  )

const pathOf = (page: Page) => new URL(page.url()).pathname

test("every playground route mounts the overlay with no page errors, and client-side navigation keeps it", async () => {
  await withPlayground(async ({ page, errors, open }) => {
    for (const [route, own] of ROUTES) {
      const response = await page.goto(new URL(route, open.url).href)
      expect(response?.status()).toBe(200)
      await overlayMounted(page, `the overlay to mount on ${route}`)
      expect(pathOf(page)).toBe(route)
      expect(await page.getByRole("heading", { level: 1 }).count()).toBeGreaterThan(0)
      await waitFor(
        `the ${own} page content to render on ${route}`,
        async () => ((await markersOf(page))[own] ? true : null),
        { timeoutMs: MOUNT_TIMEOUT_MS, everyMs: 100 },
      )
      const found = await markersOf(page)
      expect(found).toEqual({
        home: false,
        pricing: false,
        dashboard: false,
        customers: false,
        settings: false,
        heavy: false,
        [own]: true,
      })
    }

    await page.goto(new URL("/", open.url).href)
    await overlayMounted(page, "the overlay to mount before client navigation")
    await page.evaluate(() => {
      document.documentElement.dataset.noReload = "true"
    })

    const main = page.getByRole("navigation", { name: "Main", exact: true })
    const app = page.getByRole("navigation", { name: "App", exact: true })
    const arrivedAt = async (path: string, own: Marker) => {
      await waitFor(
        `the client router to reach ${path}`,
        async () => (pathOf(page) === path ? true : null),
        { timeoutMs: 10_000 },
      )
      await waitFor(
        `the ${own} page content to render on ${path}`,
        async () => ((await markersOf(page))[own] ? true : null),
        { timeoutMs: MOUNT_TIMEOUT_MS, everyMs: 100 },
      )
      expect(await markersOf(page)).toEqual({
        home: false,
        pricing: false,
        dashboard: false,
        customers: false,
        settings: false,
        heavy: false,
        [own]: true,
      })
      expect(await page.evaluate(() => document.documentElement.dataset.noReload)).toBe("true")
      expect(await page.locator("iter8-overlay").count()).toBe(1)
      await overlayMounted(page, `the overlay to stay mounted on ${path}`)
    }

    const steps: [() => Promise<void>, string, Marker][] = [
      [() => main.getByRole("link", { name: "Pricing" }).click(), "/pricing", "pricing"],
      [() => main.getByRole("link", { name: "Heavy mode" }).click(), "/heavy", "heavy"],
      [() => page.getByRole("link", { name: "Open app" }).click(), "/app", "dashboard"],
      [() => app.getByRole("link", { name: "Customers" }).click(), "/app/customers", "customers"],
      [() => app.getByRole("link", { name: "Settings" }).click(), "/app/settings", "settings"],
      [() => app.getByRole("link", { name: "Dashboard" }).click(), "/app", "dashboard"],
    ]
    for (const [click, path, own] of steps) {
      await click()
      await arrivedAt(path, own)
    }

    await page.goBack()
    await arrivedAt("/app/settings", "settings")

    await page.getByRole("link", { name: "Back to site" }).click()
    await arrivedAt("/", "home")
    expect(errors).toEqual([])
  })
}, 240_000)

const TRIGGER = "Delete workspace"
const CONFIRMATION = "lumen-labs"

const dismissTour = async (page: Page) => {
  const tour = page.getByRole("dialog", { name: "Getting started" })
  await tour.waitFor({ timeout: MOUNT_TIMEOUT_MS })
  await page.keyboard.press("Escape")
  await tour.waitFor({ state: "hidden" })
}

const focusedControl = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement
    return active?.getAttribute("aria-label") ?? active?.textContent ?? null
  })

const dialogState = (page: Page) =>
  page.evaluate(() => {
    const root = document.getElementById("root")
    const panel = document.querySelector('[role="dialog"][aria-modal="true"]')
    let outermost: Element | null = panel
    while (outermost && outermost.parentElement !== document.body)
      outermost = outermost.parentElement
    return {
      rootInert: root?.inert ?? null,
      panelInRoot: root?.contains(panel) === true,
      outermostIsBodyChild: outermost !== null && outermost !== root,
      focusInside: panel?.contains(document.activeElement) === true,
    }
  })

async function exerciseDialog(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: TRIGGER, exact: true })
  await trigger.click()
  const dialog = page.getByRole("dialog", { name: TRIGGER })
  await dialog.waitFor()
  expect(await dialogState(page)).toEqual({
    rootInert: true,
    panelInRoot: false,
    outermostIsBodyChild: true,
    focusInside: true,
  })

  const confirm = page.getByRole("textbox", { name: "Workspace name" })
  const forever = page.getByRole("button", { name: "Delete forever" })
  expect(await focusedControl(page)).toBe("Workspace name")
  expect(await forever.isEnabled()).toBe(false)

  await page.keyboard.press("Shift+Tab")
  expect(await focusedControl(page)).toBe("Cancel")
  await page.keyboard.press("Tab")
  expect(await focusedControl(page)).toBe("Workspace name")

  await confirm.fill(CONFIRMATION)
  expect(await forever.isEnabled()).toBe(true)

  await page.keyboard.press("Shift+Tab")
  expect(await focusedControl(page)).toBe("Delete forever")
  await page.keyboard.press("Tab")
  expect(await focusedControl(page)).toBe("Workspace name")
  await page.keyboard.press("Tab")
  expect(await focusedControl(page)).toBe("Cancel")
  await page.keyboard.press("Tab")
  expect(await focusedControl(page)).toBe("Delete forever")
  await page.keyboard.press("Tab")
  expect(await focusedControl(page)).toBe("Workspace name")
  expect((await dialogState(page)).focusInside).toBe(true)

  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "detached" })
  expect((await dialogState(page)).rootInert).toBe(false)
  expect(await focusedControl(page)).toBe(TRIGGER)
}

test("the settings dialog traps focus, makes the page inert, and returns focus to its trigger on Escape, every time it opens", async () => {
  await withPlayground(async ({ page, errors, open }) => {
    await page.goto(new URL("/app/settings", open.url).href)
    await overlayMounted(page, "the overlay to mount on settings")
    await dismissTour(page)

    await exerciseDialog(page)
    await exerciseDialog(page)
    expect(errors).toEqual([])
  })
}, 240_000)

test("with the first-run tour still showing, the overlay takes the first Escape and the site dialog closes on the second", async () => {
  await withPlayground(async ({ page, errors, open }) => {
    await page.goto(new URL("/app/settings", open.url).href)
    await overlayMounted(page, "the overlay to mount on settings")
    const tour = page.getByRole("dialog", { name: "Getting started" })
    await tour.waitFor({ timeout: MOUNT_TIMEOUT_MS })

    const trigger = page.getByRole("button", { name: TRIGGER, exact: true })
    await trigger.click()
    const dialog = page.getByRole("dialog", { name: TRIGGER })
    await dialog.waitFor()

    // The overlay ignores keys typed into the page's own text fields, so focus a button first.
    await page.keyboard.press("Shift+Tab")
    expect(await focusedControl(page)).toBe("Cancel")

    await page.keyboard.press("Escape")
    await tour.waitFor({ state: "hidden" })
    expect(await dialog.count()).toBe(1)
    expect(await dialogState(page)).toMatchObject({ rootInert: true, focusInside: true })

    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "detached" })
    expect((await dialogState(page)).rootInert).toBe(false)
    expect(await focusedControl(page)).toBe(TRIGGER)
    expect(errors).toEqual([])
  })
}, 240_000)

test("the settings form shows inline errors for a bad email and a toast once it is valid", async () => {
  await withPlayground(async ({ page, errors, open }) => {
    await page.goto(new URL("/app/settings", open.url).href)
    await overlayMounted(page, "the overlay to mount on settings")

    const email = page.getByRole("textbox", { name: "Work email" })
    await email.fill("not-an-email")
    await page.getByRole("button", { name: "Save changes" }).click()
    expect(await email.getAttribute("aria-invalid")).toBe("true")
    await page.getByText("Enter an email like you@company.com.").waitFor()
    expect(await page.getByRole("status").filter({ hasText: "Settings saved" }).count()).toBe(0)

    await email.fill("maya@lumen.example")
    await page.getByRole("button", { name: "Save changes" }).click()
    await page.getByRole("status").filter({ hasText: "Settings saved" }).waitFor()
    expect(errors).toEqual([])
  })
}, 240_000)

test("playground/mock opens as a folder and the overlay mounts on index.html and pricing.html", async () => {
  await withRig(async ({ page, errors, service, owner }) => {
    const mock = join(fixtureDir("playground"), "mock")
    const open = (await service.cli(["open", mock, "--json", "--owner", owner])).json(OpenResult)
    for (const file of ["index.html", "pricing.html"]) {
      await page.goto(new URL(`/${file}`, open.url).href)
      await overlayMounted(page, `the overlay to mount on ${file}`)
      expect(await page.title()).toContain("Lumen")
    }
    expect(errors).toEqual([])
  })
}, 240_000)

const MOCK_SHA256: [string, string][] = [
  ["index.html", "0bad75c401e2480374da1fb548bf7a5333d5d6347448d6a20d33c490f2601995"],
  ["pricing.html", "78de34748bc9f4b2cbe387d202fcb2031773906682d0d6047bdd851f2f4b6afa"],
  ["styles.css", "181fe6a1f3c9c46cc9770e7115312615745c7271efc2206adaec320fd3ba5be8"],
]

test("playground/mock is a byte-for-byte copy of the Lumen static mock", async () => {
  const mock = join(fixtureDir("playground"), "mock")
  for (const [file, sha256] of MOCK_SHA256) {
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(await Bun.file(join(mock, file)).bytes())
    expect({ file, sha256: hasher.digest("hex") }).toEqual({ file, sha256 })
  }
})

async function onRoute(
  route: string,
  run: (rig: Rig & { open: OpenResult }) => Promise<void>,
): Promise<void> {
  await withPlayground(async (rig) => {
    await rig.page.goto(new URL(route, rig.open.url).href)
    await overlayMounted(rig.page, `the overlay to mount on ${route}`)
    await run(rig)
    expect(rig.errors).toEqual([])
  })
}

test("home: a sticky nav, a dropdown that opens on click and closes on Escape or an outside click, six feature cards in a grid, a footer, and an open-shadow rating", async () => {
  await onRoute("/", async ({ page }) => {
    await dismissTour(page)

    const nav = page.getByRole("banner")
    expect(await nav.evaluate((el) => getComputedStyle(el).position)).toBe("sticky")
    await page.evaluate(() => window.scrollTo(0, 900))
    await waitFor("the page to scroll", async () =>
      (await page.evaluate(() => window.scrollY)) > 0 ? true : null,
    )
    expect(await nav.evaluate((el) => el.getBoundingClientRect().top)).toBe(0)
    await page.evaluate(() => window.scrollTo(0, 0))

    const product = page.getByRole("button", { name: "Product", exact: true })
    const menu = page.getByRole("menu", { name: "Product" })
    expect(await menu.count()).toBe(0)
    await product.click()
    await menu.waitFor()
    expect(await product.getAttribute("aria-expanded")).toBe("true")
    await page.keyboard.press("Escape")
    await menu.waitFor({ state: "detached" })
    expect(await product.getAttribute("aria-expanded")).toBe("false")

    await product.click()
    await menu.waitFor()
    await page.getByRole("heading", { level: 1 }).click()
    await menu.waitFor({ state: "detached" })

    const features = await page.evaluate(() => {
      const heading = document.getElementById("features-heading")
      const grid = heading?.closest("section")?.querySelector("ul") ?? null
      return {
        display: grid ? getComputedStyle(grid).display : null,
        cards: grid ? [...grid.children].map((card) => card.querySelector("h3")?.textContent) : [],
      }
    })
    expect(features.display).toBe("grid")
    expect(features.cards).toEqual([
      "Reads every merge",
      "Writes in your voice",
      "Never ships unread",
      "Groups by impact",
      "Publishes anywhere",
      "Tracks what landed",
    ])

    expect(await page.getByRole("contentinfo").count()).toBe(1)

    const rating = await page.evaluate(() => {
      const el = document.querySelector("pg-rating")
      const stars = el?.shadowRoot ? [...el.shadowRoot.querySelectorAll("button")] : []
      return {
        open: el?.shadowRoot !== null && el?.shadowRoot !== undefined,
        stars: stars.length,
        checked: stars.map((star) => star.getAttribute("aria-checked")),
      }
    })
    expect(rating).toEqual({
      open: true,
      stars: 5,
      checked: ["false", "false", "false", "true", "false"],
    })
  })
}, 240_000)

test("pricing: the FAQ accordion shows an item's answer when it opens and hides it when it closes", async () => {
  await onRoute("/pricing", async ({ page }) => {
    const first = {
      question: "Does Lumen publish anything without my approval?",
      answer:
        "Never. Every draft waits in a review queue until someone on your team presses publish.",
    }
    const second = {
      question: "Which source hosts do you support?",
      answer:
        "GitHub, GitLab and Bitbucket, including self-hosted GitLab behind a firewall through our relay.",
    }
    const question = (item: { question: string }) =>
      page.getByRole("button", { name: item.question })
    const answer = (item: { answer: string }) => page.getByText(item.answer, { exact: true })

    expect(await page.getByRole("heading", { name: "Frequently asked questions" }).count()).toBe(1)
    await answer(second).waitFor({ state: "hidden" })

    await question(second).click()
    await answer(second).waitFor({ state: "visible" })
    expect(await question(second).getAttribute("aria-expanded")).toBe("true")
    await answer(first).waitFor({ state: "hidden" })

    await question(second).click()
    await answer(second).waitFor({ state: "hidden" })
    expect(await question(second).getAttribute("aria-expanded")).toBe("false")
  })
}, 240_000)

const DRAFTS = [22, 31, 28, 44, 52, 49, 61, 70, 66, 84, 91, 108]

function expectedChartPath(values: number[]): string {
  const width = 640
  const height = 240
  const pad = { top: 16, right: 16, bottom: 28, left: 40 }
  const max = Math.ceil(Math.max(...values) / 10) * 10
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  return values
    .map((value, index) => {
      const x = pad.left + (index / (values.length - 1)) * innerW
      const y = pad.top + innerH - (value / max) * innerH
      return `${index === 0 ? "M" : "L"}${x} ${y}`
    })
    .join(" ")
}

test("dashboard: the chart line is drawn from the fixed data and the help button is fixed to the viewport", async () => {
  await onRoute("/app", async ({ page }) => {
    const line = page.locator('svg[aria-label="Drafts generated per month"] path[fill="none"]')
    expect(await line.count()).toBe(1)
    const d = await line.getAttribute("d")
    expect(d).toBe(expectedChartPath(DRAFTS))
    expect(d?.split(" L").length).toBe(DRAFTS.length)
    expect(d?.startsWith("M40 ")).toBe(true)
    expect(d?.includes(" L624 ")).toBe(true)

    const help = page.getByRole("button", { name: "Help", exact: true })
    const fixed = await help.evaluate(
      (el) => getComputedStyle(el.parentElement as Element).position,
    )
    expect(fixed).toBe("fixed")
    const before = await help.boundingBox()
    await page.getByRole("list", { name: "Recent activity" }).evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("main")) el.scrollTop = el.scrollHeight
    })
    expect(await help.boundingBox()).toEqual(before)
  })
}, 240_000)

const FIRST = ["Ada", "Bo", "Cleo", "Dara", "Eli", "Fay", "Gus", "Hana", "Ivo", "Jun"]
const LAST = ["Abara", "Bell", "Cruz", "Dahl", "Evans", "Frost", "Gómez", "Hart", "Ito", "Joshi"]

const CUSTOMERS = Array.from({ length: 200 }, (_, index) => ({
  name: `${FIRST[index % 10]} ${LAST[Math.floor(index / 10) % 10]}`,
  mrr: ([0, 29, 99][(index * 7) % 3] ?? 0) * (1 + (index % 4)),
  joined: new Date(Date.UTC(2023, 0, 1 + ((index * 37) % 900))).toISOString().slice(0, 10),
}))

test("customers: a column header sorts ascending on the first click and descending on the second", async () => {
  await onRoute("/app/customers", async ({ page }) => {
    const column = (index: number) =>
      page.locator(`tbody tr td:nth-child(${index})`).allTextContents()
    const header = (name: string) => page.getByRole("columnheader", { name })
    const sortBy = async (name: string, aria: "ascending" | "descending") => {
      await page.getByRole("button", { name, exact: true }).click()
      await waitFor(
        `${name} to be sorted ${aria}`,
        async () => ((await header(name).getAttribute("aria-sort")) === aria ? true : null),
        { timeoutMs: 5000 },
      )
    }

    const joined = CUSTOMERS.map((customer) => customer.joined).sort()
    await sortBy("Joined", "ascending")
    let cells = await column(5)
    expect([cells[0], cells.at(-1)]).toEqual([joined[0], joined.at(-1)])
    expect(cells).toEqual(joined)
    await sortBy("Joined", "descending")
    cells = await column(5)
    expect([cells[0], cells.at(-1)]).toEqual([joined.at(-1), joined[0]])
    expect(cells).toEqual([...joined].reverse())

    const mrr = CUSTOMERS.map((customer) => customer.mrr).sort((a, b) => a - b)
    await sortBy("MRR", "ascending")
    cells = await column(4)
    expect(cells).toEqual(mrr.map((value) => `$${value}`))
    await sortBy("MRR", "descending")
    cells = await column(4)
    expect(cells).toEqual([...mrr].reverse().map((value) => `$${value}`))

    const names = CUSTOMERS.map((customer) => customer.name).sort((a, b) => a.localeCompare(b))
    await sortBy("Plan", "ascending")
    await sortBy("Customer", "ascending")
    cells = await column(1)
    expect([cells[0], cells.at(-1)]).toEqual([names[0], names.at(-1)])
    await sortBy("Customer", "descending")
    cells = await column(1)
    expect([cells[0], cells.at(-1)]).toEqual([names.at(-1), names[0]])
  })
}, 240_000)

test("settings: an empty or whitespace-only name, email or company shows an inline error and blocks the save toast, and tabs swap the visible panel", async () => {
  await onRoute("/app/settings", async ({ page }) => {
    const saved = page.getByRole("status").filter({ hasText: "Settings saved" })
    const save = page.getByRole("button", { name: "Save changes" })
    const fields: [string, string, string][] = [
      ["Full name", "Maya Okafor", "Enter your full name."],
      ["Work email", "maya@lumen.example", "Enter your work email."],
      ["Company", "Lumen Labs", "Enter your company name."],
    ]
    for (const [label, valid, message] of fields) {
      const field = page.getByRole("textbox", { name: label })
      for (const blank of ["", "   "]) {
        await field.fill(blank)
        await save.click()
        await page.getByText(message, { exact: true }).waitFor()
        expect(await field.getAttribute("aria-invalid")).toBe("true")
        expect(await saved.count()).toBe(0)
        await field.fill(valid)
        await page.getByText(message, { exact: true }).waitFor({ state: "detached" })
        expect(await field.getAttribute("aria-invalid")).toBeNull()
      }
    }
    await save.click()
    await saved.waitFor()

    const profile = page.getByRole("tab", { name: "Profile" })
    const notifications = page.getByRole("tab", { name: "Notifications" })
    const panel = page.getByRole("tabpanel")
    expect(await profile.getAttribute("aria-selected")).toBe("true")
    expect(await panel.count()).toBe(1)
    expect(await panel.getByRole("textbox", { name: "Full name" }).count()).toBe(1)

    await notifications.click()
    await panel.getByText("Weekly digest").waitFor()
    expect(await notifications.getAttribute("aria-selected")).toBe("true")
    expect(await profile.getAttribute("aria-selected")).toBe("false")
    expect(await panel.count()).toBe(1)
    expect(await page.getByRole("textbox", { name: "Full name" }).count()).toBe(0)

    await profile.click()
    await page.getByRole("textbox", { name: "Full name" }).waitFor()
    expect(await page.getByText("Weekly digest").isVisible()).toBe(false)
  })
}, 240_000)

test("heavy: 6,000 rows of 5 cells, and the 300 ticker cells all change within a few ticks", async () => {
  await onRoute("/heavy", async ({ page }) => {
    await waitFor(
      "the ticker cells to render",
      async () =>
        (await page.evaluate(
          () =>
            [...document.querySelectorAll("tbody td")].filter((td) =>
              /tick \d+/.test(td.textContent ?? ""),
            ).length,
        )) === 300
          ? true
          : null,
      { timeoutMs: MOUNT_TIMEOUT_MS, everyMs: 100 },
    )

    const shape = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("tbody tr")]
      return { rows: rows.length, badRows: rows.filter((row) => row.children.length !== 5).length }
    })
    expect(shape).toEqual({ rows: 6000, badRows: 0 })

    const sample = await page.evaluate(async () => {
      const read = () =>
        [...document.querySelectorAll("tbody td")]
          .filter((td) => /tick \d+/.test(td.textContent ?? ""))
          .map((td) => td.textContent ?? "")
      const tickOf = (text: string) => Number(/tick (\d+)/.exec(text)?.[1])
      const before = read()
      const started = performance.now()
      await new Promise((resolve) => setTimeout(resolve, 600))
      const after = read()
      return {
        cells: before.length,
        changed: after.filter((text, index) => text !== before[index]).length,
        ticks: tickOf(after[0] ?? "") - tickOf(before[0] ?? ""),
        elapsedMs: performance.now() - started,
      }
    })
    expect(sample.cells).toBe(300)
    expect(sample.changed).toBeGreaterThanOrEqual(300)
    expect(sample.ticks).toBeGreaterThan(0)
    expect(sample.ticks).toBeLessThan(6)
    expect(sample.elapsedMs).toBeGreaterThanOrEqual(600)
  })
}, 240_000)

test("dark mode: the toggle adds and removes the dark class on <html> on / and on /app", async () => {
  await withPlayground(async ({ page, errors, open }) => {
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"))
    for (const route of ["/", "/app"]) {
      await page.goto(new URL(route, open.url).href)
      await overlayMounted(page, `the overlay to mount on ${route}`)
      const toggle = page.getByRole("button", { name: "Dark mode" })
      expect(await isDark()).toBe(false)
      await toggle.click()
      await waitFor(`${route} to turn dark`, async () => ((await isDark()) ? true : null))
      expect(await toggle.getAttribute("aria-pressed")).toBe("true")
      await toggle.click()
      await waitFor(`${route} to turn light`, async () => ((await isDark()) ? null : true))
      expect(await toggle.getAttribute("aria-pressed")).toBe("false")
    }
    expect(errors).toEqual([])
  })
}, 240_000)
