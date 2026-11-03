import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import {
  OVERLAY_PREFIX,
  OVERLAY_SCRIPT_PATH,
  OverlayBoot,
  PROTOCOL_VERSION,
  SOURCE_BUNDLE_PATH,
} from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const MODALS = fixtureDir("modals")
const TEST_MS = 30_000
const ACTION_MS = 6000
const TYPED = "The label is cut off in this modal"

const PAGES = [
  { name: "a native dialog", path: "/native.html" },
  { name: "a focus trap on document focusin (MUI)", path: "/mui-style.html" },
  { name: "a focus trap on document focusin and Tab (Bootstrap)", path: "/bootstrap-style.html" },
  { name: "an outside-press dismissal with focus return (Radix)", path: "/radix-style.html" },
  { name: "inert siblings of the modal", path: "/inert-siblings.html" },
  { name: "inert everything outside the modal, up to html", path: "/inert-ancestors.html" },
] as const

type Opened = Awaited<ReturnType<typeof openOverlay>>
type PageHooks = { __isOpen: () => boolean; __closedBy: string[]; __pageClicks: number }

let browser: Browser
let overlayBuild: Scratch
let opened: Opened | null = null

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

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

async function open(path: string): Promise<Opened> {
  opened = await openOverlay({ overlayDir: overlayBuild.path, folder: MODALS, path, browser })
  opened.page.setDefaultTimeout(ACTION_MS)
  return opened
}

const pageState = (page: Page) =>
  page.evaluate(() => {
    const hooks = window as unknown as PageHooks
    return {
      open: hooks.__isOpen(),
      closedBy: [...hooks.__closedBy],
      clicks: hooks.__pageClicks,
      modalField: document.querySelector<HTMLInputElement>("#modal-input")?.value,
    }
  })

const noteBox = (o: Opened) => o.overlay.getByRole("textbox", { name: "Note" })
const pickTool = (o: Opened) => o.overlay.getByRole("button", { name: "Pick element" })

async function openModal(o: Opened) {
  await o.page.locator("#open").click()
  await until("the modal to open", async () => (await pageState(o.page)).open)
}

async function pickInsideModal(o: Opened) {
  await pickTool(o).click()
  await until("pick mode", async () => (await pickTool(o).getAttribute("aria-pressed")) === "true")
  await o.page.locator("#modal-target").click()
  await until("the note box to take focus", () =>
    noteBox(o).evaluate((box) => box.getRootNode() instanceof ShadowRoot && box.matches(":focus")),
  )
}

describe("leaving a note while the page has a modal open", () => {
  for (const { name, path } of PAGES) {
    test(
      `picks inside, types, saves and leaves the modal and the page working: ${name}`,
      async () => {
        const o = await open(path)
        await openModal(o)

        await pickInsideModal(o)
        await o.page.keyboard.type(TYPED)
        expect(await noteBox(o).inputValue()).toBe(TYPED)

        const question = o.overlay.getByRole("radio", { name: "Question" })
        await question.click()
        await until(
          "the question intent to be chosen",
          async () => (await question.getAttribute("aria-checked")) === "true",
        )
        await o.overlay.getByRole("button", { name: "Save note" }).click()
        await until("the composer to close", async () => !(await noteBox(o).isVisible()))

        const [note, ...others] = o.mock.draft()
        expect(others).toEqual([])
        expect(note?.body).toBe(TYPED)
        expect(note?.intent).toBe("question")
        expect(await pageState(o.page)).toEqual({
          open: true,
          closedBy: [],
          clicks: 0,
          modalField: "",
        })

        await o.page.locator("#close").click()
        await until("the modal to close", async () => !(await pageState(o.page)).open)
        await o.page.locator("#page-button").click()
        expect((await pageState(o.page)).clicks).toBe(1)

        await pickTool(o).click()
        await until(
          "pick mode after the modal closed",
          async () => (await pickTool(o).getAttribute("aria-pressed")) === "true",
        )
        expect(o.errors).toEqual([])
      },
      TEST_MS,
    )
  }
})

describe("the host and a native dialog", () => {
  const hostParent = (page: Page) =>
    page.evaluate(() => document.querySelector("iter8-overlay")?.parentElement?.tagName ?? null)

  const dockHit = (page: Page) =>
    page.evaluate(() => {
      const host = document.querySelector("iter8-overlay")
      const dock = host?.shadowRoot?.querySelector('[role="toolbar"]')
      if (!host || !dock) throw new Error("no dock")
      const { x, y, width, height } = dock.getBoundingClientRect()
      return document.elementFromPoint(x + width / 2, y + height / 2) === host
    })

  test(
    "sits in the dialog while it is open and returns to html when it closes, and again on a second open",
    async () => {
      const o = await open("/native.html")
      expect(await hostParent(o.page)).toBe("HTML")

      await openModal(o)
      await until(
        "the host to move into the dialog",
        async () => (await hostParent(o.page)) === "DIALOG",
      )
      expect(await dockHit(o.page)).toBe(true)

      await o.page.locator("#close").click()
      await until("the host to return to html", async () => (await hostParent(o.page)) === "HTML")
      await o.page.locator("#page-button").click()
      expect((await pageState(o.page)).clicks).toBe(1)

      await openModal(o)
      await until(
        "the host to move into the dialog again",
        async () => (await hostParent(o.page)) === "DIALOG",
      )
      expect(await dockHit(o.page)).toBe(true)
    },
    TEST_MS,
  )

  test(
    "follows the topmost of two nested dialogs and returns to the one below",
    async () => {
      const o = await open("/native.html")
      await openModal(o)
      await o.page.evaluate(() => {
        const inner = document.createElement("dialog")
        inner.id = "inner"
        inner.append("Inner")
        document.body.append(inner)
        inner.showModal()
      })
      await until("the host to move into the inner dialog", () =>
        o.page.evaluate(
          () => document.querySelector("iter8-overlay")?.parentElement?.id === "inner",
        ),
      )
      expect(await dockHit(o.page)).toBe(true)

      await o.page.evaluate(() => document.querySelector<HTMLDialogElement>("#inner")?.close())
      await until("the host to return to the outer dialog", () =>
        o.page.evaluate(
          () => document.querySelector("iter8-overlay")?.parentElement?.id === "modal",
        ),
      )
    },
    TEST_MS,
  )

  test(
    "returns to html, still working, when the dialog is removed while open",
    async () => {
      const o = await open("/native.html")
      await openModal(o)
      await until(
        "the host to move into the dialog",
        async () => (await hostParent(o.page)) === "DIALOG",
      )

      await o.page.evaluate(() => document.querySelector("#modal")?.remove())
      await until("the host to return to html", async () => (await hostParent(o.page)) === "HTML")
      expect(await dockHit(o.page)).toBe(true)
      await pickTool(o).click()
      await until(
        "pick mode",
        async () => (await pickTool(o).getAttribute("aria-pressed")) === "true",
      )
    },
    TEST_MS,
  )

  test(
    "moves in at mount when a dialog is already open",
    async () => {
      const o = await open("/native.html")
      await o.page.evaluate(() => document.querySelector("iter8-overlay")?.remove())
      await until(
        "the host to go",
        async () => (await o.page.locator("iter8-overlay").count()) === 0,
      )
      await o.page.evaluate(() => document.querySelector<HTMLDialogElement>("#modal")?.showModal())

      const boot = OverlayBoot.parse({
        protocolVersion: PROTOCOL_VERSION,
        pageId: o.mock.pageId,
        machineId: o.mock.machineId,
        machineName: "mock-machine",
        token: o.mock.token,
        apiBase: OVERLAY_PREFIX,
        sourceBundleUrl: SOURCE_BUNDLE_PATH,
      })
      await o.page.evaluate(
        async ({ path, boot }) => {
          const { mount } = await import(path)
          mount(boot)
        },
        { path: OVERLAY_SCRIPT_PATH, boot },
      )
      await until(
        "the host to be in the dialog",
        async () => (await hostParent(o.page)) === "DIALOG",
      )
      // A freshly mounted dock is visible while it is still moving in; a slow runner sampled it mid-entrance.
      await until("the dock to take clicks", () => dockHit(o.page))
    },
    TEST_MS,
  )
})
