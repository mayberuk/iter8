import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { OVERLAY_ROUTES, Pairing, TOKEN_HEADER } from "@iter8/protocol"
import type { Browser, Locator } from "playwright"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const MOD = process.platform === "darwin" ? "Meta" : "Control"
const REGION = { x: 100, y: 100, width: 300, height: 200 }
const ARROW_LIGHT = [0x2f, 0x5b, 0xff]

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
  opened = await openOverlay({ overlayDir: overlayBuild.path, folder: STATIC, browser })
  return opened
}

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

async function dragRegion(o: Awaited<ReturnType<typeof open>>, region = REGION) {
  await o.page.mouse.move(region.x, region.y)
  await o.page.mouse.down()
  await o.page.mouse.move(region.x + region.width, region.y + region.height, { steps: 6 })
  await o.page.mouse.up()
}

async function enterMarkup(o: Awaited<ReturnType<typeof open>>) {
  await o.page.keyboard.press("s")
  await dragRegion(o)
  const dialog = o.overlay.getByRole("dialog", { name: "Mark up screenshot" })
  await dialog.locator("img").waitFor({ timeout: 10_000 })
  return dialog
}

async function surfaceBox(dialog: Locator) {
  // The dialog springs into place as it opens, so a box read mid-slide misplaces every drag.
  await dialog.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  )
  const box = await dialog.getByRole("img", { name: "Capture to mark up" }).boundingBox()
  if (!box) throw new Error("the drawing surface has no box")
  return box
}

async function drag(
  o: Awaited<ReturnType<typeof open>>,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await o.page.mouse.move(from.x, from.y)
  await o.page.mouse.down()
  await o.page.mouse.move(to.x, to.y, { steps: 6 })
  await o.page.mouse.up()
}

const uploads = (o: Awaited<ReturnType<typeof open>>) =>
  o.mock
    .requests()
    .filter((r) => r.method === "POST" && r.path === OVERLAY_ROUTES.uploadScreenshot.path)

describe("screenshot and markup", () => {
  test("S shows the crosshair hints and a region drag opens Markup with the region's size", async () => {
    const o = await open()
    await o.page.keyboard.press("s")
    for (const hint of ["Drag a region", "full viewport", "Esc cancel"])
      expect(await o.overlay.getByText(hint).isVisible()).toBe(true)

    await dragRegion(o, { x: 100, y: 100, width: 240, height: 160 })
    const dialog = o.overlay.getByRole("dialog", { name: "Mark up screenshot" })
    await dialog.waitFor({ timeout: 10_000 })
    expect(await dialog.innerText()).toContain("240 × 160")
    await dialog.locator("img").waitFor({ timeout: 10_000 })
  }, 30_000)

  test("Enter in shot mode marks up the full viewport", async () => {
    const o = await open()
    await o.page.keyboard.press("s")
    await o.page.keyboard.press("Enter")
    const dialog = o.overlay.getByRole("dialog", { name: "Mark up screenshot" })
    await dialog.waitFor({ timeout: 10_000 })
    const size = o.page.viewportSize()
    expect(await dialog.innerText()).toContain(`${size?.width} × ${size?.height}`)
  }, 30_000)

  test("drawing a box and pressing Enter opens the composer with the screenshot attached", async () => {
    const o = await open()
    const dialog = await enterMarkup(o)
    await o.page.keyboard.press("b")
    const surface = await surfaceBox(dialog)
    await drag(
      o,
      { x: surface.x + 60, y: surface.y + 50 },
      { x: surface.x + 200, y: surface.y + 140 },
    )
    await o.page.keyboard.press("Enter")
    await o.overlay.getByRole("img", { name: "Screenshot attached" }).waitFor({ timeout: 10_000 })
    expect(await o.overlay.getByRole("dialog", { name: "Mark up screenshot" }).count()).toBe(0)
  }, 30_000)

  test("saving uploads one PNG with the drawn box flattened into it", async () => {
    const o = await open()
    const dialog = await enterMarkup(o)
    await o.page.keyboard.press("b")
    const surface = await surfaceBox(dialog)
    const from = { x: surface.x + 60, y: surface.y + 50 }
    const to = { x: surface.x + 200, y: surface.y + 140 }
    await drag(o, from, to)
    await o.page.keyboard.press("Enter")
    await o.overlay.getByRole("img", { name: "Screenshot attached" }).waitFor({ timeout: 10_000 })
    expect(uploads(o)).toHaveLength(0)

    await o.overlay.getByRole("textbox", { name: "Note" }).fill("Check this box")
    await o.overlay.getByRole("button", { name: "Save note" }).click()
    await until("the saved draft", () => o.mock.draft().length === 1)
    await until(
      "the screenshot on the draft",
      () => o.mock.draft()[0]?.capture?.screenshot !== undefined,
    )
    expect(uploads(o)).toHaveLength(1)

    const ref = o.mock.draft()[0]?.capture?.screenshot?.ref
    if (!ref) throw new Error("the saved draft has no screenshot")

    const leftEdge = ((from.x - surface.x) / surface.width) * REGION.width
    const topEdge = ((from.y - surface.y) / surface.height) * REGION.height
    const bottomEdge = ((to.y - surface.y) / surface.height) * REGION.height
    const sample = await o.page.evaluate(
      async ({ path, header, token, leftEdge, middle, inside }) => {
        const response = await fetch(path, { headers: { [header]: token } })
        const bitmap = await createImageBitmap(await response.blob())
        const canvas = document.createElement("canvas")
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const pen = canvas.getContext("2d")
        if (!pen) throw new Error("no 2d canvas")
        pen.drawImage(bitmap, 0, 0)
        const scale = bitmap.width / 300
        const pixel = (x: number, y: number) =>
          Array.from(pen.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data)
        return {
          width: bitmap.width,
          height: bitmap.height,
          edge: pixel(leftEdge, middle),
          inside: pixel(inside.x, inside.y),
        }
      },
      {
        path: OVERLAY_ROUTES.getScreenshot.path.replace(":ref", ref),
        header: TOKEN_HEADER,
        token: o.mock.token,
        leftEdge,
        middle: (topEdge + bottomEdge) / 2,
        inside: { x: leftEdge + 30, y: (topEdge + bottomEdge) / 2 },
      },
    )
    expect(sample.width / REGION.width).toBe(sample.height / REGION.height)
    expect(sample.edge.slice(0, 3)).toEqual(ARROW_LIGHT)
    expect(sample.edge[3]).toBe(255)
    expect(sample.inside.slice(0, 3)).not.toEqual(ARROW_LIGHT)
  }, 60_000)

  test("Mod+Z removes the last shape and a drag under 4 px draws nothing", async () => {
    const o = await open()
    const dialog = await enterMarkup(o)
    const surface = await surfaceBox(dialog)
    const marks = o.overlay.locator(".mark")

    await drag(
      o,
      { x: surface.x + 20, y: surface.y + 20 },
      { x: surface.x + 120, y: surface.y + 90 },
    )
    await o.page.keyboard.press("b")
    await drag(
      o,
      { x: surface.x + 60, y: surface.y + 50 },
      { x: surface.x + 200, y: surface.y + 140 },
    )
    expect(await marks.count()).toBe(2)

    await drag(
      o,
      { x: surface.x + 240, y: surface.y + 200 },
      { x: surface.x + 242, y: surface.y + 201 },
    )
    expect(await marks.count()).toBe(2)

    await o.page.keyboard.press(`${MOD}+z`)
    expect(await marks.count()).toBe(1)
    expect(await dialog.locator("rect.mark-box").count()).toBe(0)
    expect(await dialog.locator("line.mark-arrow").count()).toBe(1)
  }, 30_000)

  test("an area holding more elements than the capture budget says it is too heavy and Retake returns to shot mode", async () => {
    const o = await open()
    await o.page.evaluate(() => {
      const heavy = document.createElement("div")
      heavy.style.cssText =
        "display:flex;flex-wrap:wrap;width:1200px;position:absolute;top:0;left:0"
      for (let i = 0; i < 3000; i++) {
        const cell = document.createElement("span")
        cell.style.cssText = "width:10px;height:10px;background:#c30"
        heavy.append(cell)
      }
      document.body.prepend(heavy)
    })
    await o.page.keyboard.press("s")
    await dragRegion(o)
    const dialog = o.overlay.getByRole("dialog", { name: "Mark up screenshot" })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog
      .getByText("This part of the page is too heavy to capture")
      .waitFor({ timeout: 10_000 })
    expect(await dialog.locator("img").count()).toBe(0)

    await o.page.keyboard.press("Enter")
    expect(await o.overlay.getByRole("img", { name: "Screenshot attached" }).count()).toBe(0)

    await dialog.getByRole("button", { name: "Retake" }).click()
    await o.overlay.getByText("Drag a region").waitFor({ timeout: 5000 })
    expect(await dialog.count()).toBe(0)
    expect(uploads(o)).toHaveLength(0)
  }, 30_000)

  test("Esc leaves shot mode and page clicks work again", async () => {
    const o = await open()
    await o.page.evaluate(() => {
      document.documentElement.dataset.clicks = "0"
      document.addEventListener("click", () => {
        document.documentElement.dataset.clicks = String(
          Number(document.documentElement.dataset.clicks) + 1,
        )
      })
    })
    const clicks = () => o.page.evaluate(() => document.documentElement.dataset.clicks)

    await o.page.keyboard.press("s")
    await o.overlay.getByText("Drag a region").waitFor({ timeout: 5000 })
    await o.page.mouse.click(600, 500)
    expect(await clicks()).toBe("0")

    await o.page.keyboard.press("Escape")
    await until(
      "shot mode to end",
      async () => (await o.overlay.getByText("Drag a region").count()) === 0,
    )
    await o.page.mouse.click(600, 500)
    expect(await clicks()).toBe("1")
  }, 30_000)
})

describe("a marked-up note's screenshot", () => {
  async function composeShot(o: Awaited<ReturnType<typeof open>>) {
    const dialog = await enterMarkup(o)
    await o.page.keyboard.press("b")
    const surface = await surfaceBox(dialog)
    await drag(
      o,
      { x: surface.x + 60, y: surface.y + 50 },
      { x: surface.x + 200, y: surface.y + 140 },
    )
    await o.page.keyboard.press("Enter")
    await o.overlay.getByRole("img", { name: "Screenshot attached" }).waitFor({ timeout: 10_000 })
    await o.overlay.getByRole("textbox", { name: "Note" }).fill("Slow upload")
  }

  async function holdUploads(o: Awaited<ReturnType<typeof open>>) {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    await o.page.route(
      (url) => url.pathname === OVERLAY_ROUTES.uploadScreenshot.path,
      async (route) => {
        held = true
        await gate
        await route.continue()
      },
    )
    return { release, isHeld: () => held }
  }

  for (const how of ["the Save button", "Mod+Enter"] as const) {
    test(`saving with ${how} before the upload lands still gives the note its screenshot`, async () => {
      const o = await open()
      const hold = await holdUploads(o)
      await composeShot(o)
      if (how === "Mod+Enter") await o.page.keyboard.press(`${MOD}+Enter`)
      else await o.overlay.getByRole("button", { name: "Save note" }).click()
      await until("the upload to be under way", () => hold.isHeld())
      await until("the saved draft", () => o.mock.draft().length === 1)
      expect(o.mock.draft()[0]?.capture?.screenshot).toBeUndefined()

      hold.release()
      await until(
        "the screenshot on the draft",
        () => o.mock.draft()[0]?.capture?.screenshot !== undefined,
      )
      expect(uploads(o)).toHaveLength(1)
      expect(o.mock.draft()[0]?.body).toBe("Slow upload")
    }, 60_000)
  }

  test("cancelling the composer uploads nothing", async () => {
    const o = await open()
    await composeShot(o)
    await o.page.keyboard.press("Escape")
    await until(
      "the composer to close",
      async () => (await o.overlay.getByRole("textbox", { name: "Note" }).count()) === 0,
    )
    await enterMarkup(o)
    expect(uploads(o)).toHaveLength(0)
    expect(o.mock.draft()).toHaveLength(0)
  }, 60_000)
})

describe("every tool is flattened into the saved image", () => {
  test("an arrow keeps the arrow colour and a highlight tints what it covers", async () => {
    const o = await open()
    const dialog = await enterMarkup(o)
    const surface = await surfaceBox(dialog)
    await o.page.keyboard.press("h")
    await drag(
      o,
      { x: surface.x + 20, y: surface.y + 20 },
      { x: surface.x + 120, y: surface.y + 90 },
    )
    await o.page.keyboard.press("a")
    await drag(
      o,
      { x: surface.x + 150, y: surface.y + 250 },
      { x: surface.x + 330, y: surface.y + 250 },
    )
    await o.page.keyboard.press("Enter")
    await o.overlay.getByRole("img", { name: "Screenshot attached" }).waitFor({ timeout: 10_000 })
    await o.overlay.getByRole("textbox", { name: "Note" }).fill("Tools")
    await o.overlay.getByRole("button", { name: "Save note" }).click()
    await until(
      "the screenshot on the draft",
      () => o.mock.draft()[0]?.capture?.screenshot !== undefined,
    )
    const ref = o.mock.draft()[0]?.capture?.screenshot?.ref
    if (!ref) throw new Error("the saved draft has no screenshot")

    const fit = surface.width / REGION.width
    const at = (x: number, y: number) => ({ x: Math.floor(x / fit), y: Math.floor(y / fit) })
    const points = {
      arrow: at(240, 250),
      highlighted: at(70, 55),
      plain: at(400, 20),
    }
    const pixels = await o.page.evaluate(
      async ({ path, header, token, points }) => {
        const response = await fetch(path, { headers: { [header]: token } })
        const bitmap = await createImageBitmap(await response.blob())
        const canvas = document.createElement("canvas")
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const pen = canvas.getContext("2d")
        if (!pen) throw new Error("no 2d canvas")
        pen.drawImage(bitmap, 0, 0)
        const scale = bitmap.width / 300
        const pixel = ({ x, y }: { x: number; y: number }) =>
          Array.from(pen.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data)
        return {
          arrow: pixel(points.arrow),
          highlighted: pixel(points.highlighted),
          plain: pixel(points.plain),
        }
      },
      {
        path: OVERLAY_ROUTES.getScreenshot.path.replace(":ref", ref),
        header: TOKEN_HEADER,
        token: o.mock.token,
        points,
      },
    )
    expect(pixels.arrow.slice(0, 3)).toEqual(ARROW_LIGHT)
    const warmth = (pixel: number[]) => (pixel[0] ?? 0) - (pixel[2] ?? 0)
    expect(warmth(pixels.highlighted)).toBeGreaterThan(warmth(pixels.plain) + 30)
  }, 60_000)
})

test("the Add to round button opens the composer the same way Enter does", async () => {
  const o = await open()
  await enterMarkup(o)
  await o.overlay.getByRole("button", { name: /Add to round/ }).click()
  await o.overlay.getByRole("img", { name: "Screenshot attached" }).waitFor({ timeout: 10_000 })
  expect(await o.overlay.getByRole("dialog", { name: "Mark up screenshot" }).count()).toBe(0)
  expect(await o.overlay.getByRole("dialog", { name: "New note" }).innerText()).toContain(
    "Screenshot",
  )
}, 30_000)

test("the getting-started coach hides while Markup is open and returns once it closes", async () => {
  const o = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: STATIC,
    browser,
    mock: { pairing: Pairing.parse(pairingJson) },
  })
  opened = o
  const coach = o.overlay.getByRole("dialog", { name: "Getting started" })
  await until("the coach to show", () => coach.isVisible())
  const dialog = await enterMarkup(o)
  expect(await coach.isVisible()).toBe(false)
  await dialog.getByRole("button", { name: /Add to round/ }).click({ timeout: 5000 })
  await o.overlay.getByRole("img", { name: "Screenshot attached" }).waitFor({ timeout: 10_000 })
  await o.page.keyboard.press("Escape")
  await until("the coach to return", () => coach.isVisible())
}, 30_000)
