import { expect, test } from "bun:test"
import { join } from "node:path"
import { OpenResult, type OwnerId, ServiceStatus } from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import { startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { fixtureDir, startFixture } from "../../rig/fixtures"
import type { RunningService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { startBuiltService } from "../e2e/steps"

const MOUNT_TIMEOUT_MS = 30_000
const ROUTES = ["/", "/pricing", "/app", "/app/customers", "/app/settings", "/heavy"]

const overlayMounted = (page: Page, label: string) =>
  waitFor(
    label,
    () => page.evaluate(() => (document.querySelector("iter8-overlay")?.shadowRoot ? true : null)),
    { timeoutMs: MOUNT_TIMEOUT_MS, everyMs: 100 },
  )

const pathOf = (page: Page) => new URL(page.url()).pathname

async function teardown(steps: (() => Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps.reverse()) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "teardown failed")
}

type Rig = { page: Page; errors: string[]; service: RunningService; owner: OwnerId }

async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  const cleanups: (() => Promise<unknown>)[] = []
  try {
    const service = await startBuiltService()
    cleanups.push(() => service.stop())
    const session = await startAgentSession(service)
    // `hook end` against a stopped service starts a fresh detached service, so the session leaves first.
    cleanups.push(() => session.exit())
    const browser: Browser = await launchChromium()
    cleanups.push(() => browser.close())
    const opened = await newPage(browser)
    cleanups.push(opened.close)
    const owner = (await session.run(["status", "--json"])).json(ServiceStatus).owner
    if (owner === null) throw new Error("the stub session is not paired")
    await run({ page: opened.page, errors: opened.errors, service, owner: owner.owner })
  } finally {
    await teardown(cleanups)
  }
}

async function withPlayground(
  run: (rig: Rig & { open: OpenResult }) => Promise<void>,
): Promise<void> {
  const fixture = await startFixture("playground")
  try {
    await withRig(async (rig) => {
      const open = (
        await rig.service.cli(["open", fixture.url(), "--json", "--owner", rig.owner])
      ).json(OpenResult)
      await run({ ...rig, open })
    })
  } finally {
    await fixture.stop()
  }
}

test("every playground route mounts the overlay with no page errors, and client-side navigation keeps it", async () => {
  await withPlayground(async ({ page, errors, open }) => {
    for (const route of ROUTES) {
      await page.goto(new URL(route, open.url).href)
      await overlayMounted(page, `the overlay to mount on ${route}`)
      expect(pathOf(page)).toBe(route)
      expect(await page.getByRole("heading", { level: 1 }).count()).toBeGreaterThan(0)
    }

    await page.goto(new URL("/", open.url).href)
    await overlayMounted(page, "the overlay to mount before client navigation")
    await page.evaluate(() => {
      document.documentElement.dataset.noReload = "true"
    })

    const main = page.getByRole("navigation", { name: "Main", exact: true })
    const app = page.getByRole("navigation", { name: "App", exact: true })
    const steps: [() => Promise<void>, string][] = [
      [() => main.getByRole("link", { name: "Pricing" }).click(), "/pricing"],
      [() => main.getByRole("link", { name: "Heavy mode" }).click(), "/heavy"],
      [() => page.getByRole("link", { name: "Open app" }).click(), "/app"],
      [() => app.getByRole("link", { name: "Customers" }).click(), "/app/customers"],
      [() => app.getByRole("link", { name: "Settings" }).click(), "/app/settings"],
      [() => app.getByRole("link", { name: "Dashboard" }).click(), "/app"],
    ]
    for (const [click, path] of steps) {
      await click()
      await waitFor(
        `the client router to reach ${path}`,
        async () => (pathOf(page) === path ? true : null),
        {
          timeoutMs: 10_000,
        },
      )
      expect(await page.evaluate(() => document.documentElement.dataset.noReload)).toBe("true")
      expect(await page.locator("iter8-overlay").count()).toBe(1)
      await overlayMounted(page, `the overlay to stay mounted on ${path}`)
    }

    await page.goBack()
    await waitFor(
      "popstate to return to the previous route",
      async () => (pathOf(page) === "/app/settings" ? true : null),
      {
        timeoutMs: 10_000,
      },
    )
    expect(await page.evaluate(() => document.documentElement.dataset.noReload)).toBe("true")
    expect(errors).toEqual([])
  })
}, 240_000)

test("the settings dialog traps focus, makes the page inert, and returns focus to its trigger on Escape", async () => {
  await withPlayground(async ({ page, errors, open }) => {
    await page.goto(new URL("/app/settings", open.url).href)
    await overlayMounted(page, "the overlay to mount on settings")

    // The overlay claims Escape while its first-run tour is up, so the tour goes first.
    const tour = page.getByRole("dialog", { name: "Getting started" })
    await tour.waitFor()
    await page.keyboard.press("Escape")
    await tour.waitFor({ state: "hidden" })

    const trigger = page.getByRole("button", { name: "Delete workspace", exact: true })
    await trigger.click()
    const dialog = page.getByRole("dialog", { name: "Delete workspace" })
    await dialog.waitFor()

    const focusInside = () =>
      page.evaluate(() => {
        const panel = document.querySelector('[role="dialog"]')
        return panel?.contains(document.activeElement) === true
      })
    expect(await focusInside()).toBe(true)
    expect(await page.evaluate(() => document.getElementById("root")?.inert)).toBe(true)
    expect(
      await page.evaluate(() => document.getElementById("root")?.parentElement === document.body),
    ).toBe(true)

    for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab"]) {
      await page.keyboard.press(key)
      expect(await focusInside()).toBe(true)
    }
    for (const key of ["Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key)
      expect(await focusInside()).toBe(true)
    }

    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "detached" })
    expect(await page.evaluate(() => document.getElementById("root")?.inert)).toBe(false)
    expect(
      await page.evaluate(
        () =>
          document.activeElement?.textContent === "Delete workspace" &&
          document.activeElement.tagName === "BUTTON",
      ),
    ).toBe(true)
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
