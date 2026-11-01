import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { OVERLAY_ROUTES, TOKEN_HEADER } from "@iter8/protocol"
import type { Browser, Locator, Page } from "playwright"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const TEST_MS = 60_000

/** A pixel counts as different past this summed gap over red, green and blue, out of 765. */
const PIXEL_GAP = 48
/** Antialiasing and subpixel text placement differ between the library's render and the browser's own. */
const MAX_DIFFERING_SHARE = 0.03

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

type Opened = Awaited<ReturnType<typeof openOverlay>>

async function open(): Promise<Opened> {
  opened = await openOverlay({ overlayDir: overlayBuild.path, folder: STATIC, browser })
  return opened
}

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

type Region = { x: number; y: number; width: number; height: number }

async function drag(o: Opened, region: Region) {
  await o.page.mouse.move(region.x, region.y)
  await o.page.mouse.down()
  await o.page.mouse.move(region.x + region.width, region.y + region.height, { steps: 6 })
  await o.page.mouse.up()
}

/** What the browser itself paints in `region`, with the overlay hidden. */
const truthOf = (page: Page, region: Region) =>
  page.screenshot({ clip: region, style: "iter8-overlay { visibility: hidden !important }" })

type Likeness = { width: number; height: number; colours: number; differingShare: number }

/** Compares a PNG fetched in the page with the browser's own screenshot of the same area. */
async function likeness(page: Page, source: string | Uint8Array, truth: Buffer): Promise<Likeness> {
  return page.evaluate(
    async ({ source, truth, gap }) => {
      const png =
        typeof source === "string"
          ? await (await fetch(source)).blob()
          : new Blob([new Uint8Array(source)])
      const shot = await createImageBitmap(png)
      const expected = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${truth}`)).blob(),
      )
      const read = (bitmap: ImageBitmap, width: number, height: number) => {
        const canvas = document.createElement("canvas")
        canvas.width = width
        canvas.height = height
        const pen = canvas.getContext("2d")
        if (!pen) throw new Error("no 2d canvas")
        pen.drawImage(bitmap, 0, 0, width, height)
        return pen.getImageData(0, 0, width, height).data
      }
      const a = read(shot, expected.width, expected.height)
      const b = read(expected, expected.width, expected.height)
      let differing = 0
      const colours = new Set<number>()
      for (let at = 0; at < a.length; at += 4) {
        const red = a[at] ?? 0
        const green = a[at + 1] ?? 0
        const blue = a[at + 2] ?? 0
        colours.add((red << 16) | (green << 8) | blue)
        const delta =
          Math.abs(red - (b[at] ?? 0)) +
          Math.abs(green - (b[at + 1] ?? 0)) +
          Math.abs(blue - (b[at + 2] ?? 0))
        if (delta > gap) differing += 1
      }
      return {
        width: shot.width,
        height: shot.height,
        colours: colours.size,
        differingShare: differing / (expected.width * expected.height),
      }
    },
    { source, truth: truth.toString("base64"), gap: PIXEL_GAP },
  )
}

const uploads = (o: Opened) =>
  o.mock
    .requests()
    .filter((r) => r.method === "POST" && r.path === OVERLAY_ROUTES.uploadScreenshot.path)

async function uploadedPng(o: Opened): Promise<Uint8Array> {
  const ref = o.mock.draft()[0]?.capture?.screenshot?.ref
  if (!ref) throw new Error("the saved draft has no screenshot")
  const bytes = await o.page.evaluate(
    async ({ path, header, token }) => {
      const response = await fetch(path, { headers: { [header]: token } })
      return Array.from(new Uint8Array(await response.arrayBuffer()))
    },
    {
      path: OVERLAY_ROUTES.getScreenshot.path.replace(":ref", ref),
      header: TOKEN_HEADER,
      token: o.mock.token,
    },
  )
  return new Uint8Array(bytes)
}

const composer = (o: Opened) => o.overlay.getByRole("dialog", { name: "New note" })
const thumbnail = (o: Opened) => composer(o).getByRole("img", { name: "Screenshot attached" })
const attachSwitch = (o: Opened) => composer(o).getByRole("switch")

async function drawRegion(o: Opened, region: Region) {
  await o.overlay.getByRole("button", { name: "Draw region" }).click()
  await drag(o, region)
  await composer(o).waitFor({ timeout: 10_000 })
}

async function saveNote(o: Opened, body: string) {
  await o.overlay.getByRole("textbox", { name: "Note" }).fill(body)
  await o.overlay.getByRole("button", { name: "Save note" }).click()
  await until("the saved draft", () => o.mock.draft().length === 1)
}

async function boxOf(locator: Locator): Promise<Region> {
  await locator.evaluate((el) => el.scrollIntoView({ block: "center" }))
  const box = await locator.boundingBox()
  if (!box) throw new Error("the element has no box")
  return box
}

async function addPage(page: Page, html: string) {
  await page.evaluate((html) => {
    document.body.insertAdjacentHTML("beforeend", `${html}<div style="height:900px"></div>`)
  }, html)
}

const rows = (count: number) =>
  `<div id="rows" style="margin:0 0 0 0">${Array.from(
    { length: count },
    (_, i) =>
      `<div style="height:24px;display:flex;gap:8px;border-bottom:1px solid #ddd"><span>row ${i}</span><span style="color:#07c">alpha</span><span style="color:#c30">beta</span></div>`,
  ).join("")}</div>`

describe("a region note's screenshot", () => {
  test(
    "is taken of the drawn box, shown as a thumbnail and uploaded once the note is saved",
    async () => {
      const o = await open()
      const region = { x: 60, y: 120, width: 320, height: 160 }
      const truth = await truthOf(o.page, region)

      await drawRegion(o, region)
      await thumbnail(o).waitFor({ timeout: 15_000 })
      expect(await attachSwitch(o).getAttribute("aria-checked")).toBe("true")
      await saveNote(o, "Check this area")
      await until(
        "the screenshot on the draft",
        () => o.mock.draft()[0]?.capture?.screenshot !== undefined,
      )

      expect(uploads(o)).toHaveLength(1)
      expect(o.mock.draft()[0]?.capture?.omittedParts).toEqual([])
      const png = await uploadedPng(o)
      const shot = await likeness(o.page, png, truth)
      expect([shot.width, shot.height]).toEqual([region.width, region.height])
      expect(shot.colours).toBeGreaterThan(1)
    },
    TEST_MS,
  )

  test(
    "of an area too heavy to capture is recorded as omitted, with the switch off and no thumbnail",
    async () => {
      const o = await open()
      await addPage(o.page, rows(1500))
      const rowBox = await boxOf(o.page.locator("#rows > div").nth(1100))
      const region = { x: 60, y: rowBox.y, width: 400, height: 120 }

      await drawRegion(o, region)
      await until(
        "the switch to settle off",
        async () => (await attachSwitch(o).isDisabled()) === true,
      )

      expect(await attachSwitch(o).getAttribute("aria-checked")).toBe("false")
      expect(await thumbnail(o).count()).toBe(0)
      expect(await composer(o).innerText()).toContain(
        "This part of the page is too heavy to capture",
      )
      await saveNote(o, "Too heavy to capture")
      expect(o.mock.draft()[0]?.capture?.omittedParts).toContain("screenshot")
      expect(o.mock.draft()[0]?.capture?.screenshot).toBeUndefined()
      expect(uploads(o)).toHaveLength(0)
    },
    TEST_MS,
  )
})

describe("a picked element inside an inline SVG chart", () => {
  test(
    "attaches a screenshot of the whole chart, styled as the browser paints it",
    async () => {
      const o = await open()
      await addPage(
        o.page,
        `<style>.chart-area{fill:#dc2626}.chart-grid{stroke:#1d4ed8;stroke-width:2}</style>
        <div id="chart" style="width:640px;background:#fff"><svg viewBox="0 0 640 240" width="640" height="240" style="display:block">
          <line class="chart-grid" x1="40" x2="624" y1="120" y2="120"></line>
          <path id="area" class="chart-area" d="M40 60 L200 30 L400 80 L624 20 L624 212 L40 212 Z"></path>
        </svg></div>`,
      )
      const chart = await boxOf(o.page.locator("#chart"))
      const truth = await truthOf(o.page, chart)

      await o.page.keyboard.press("c")
      await o.page.locator("#area").click()
      await composer(o).waitFor({ timeout: 10_000 })
      await thumbnail(o).waitFor({ timeout: 15_000 })
      await saveNote(o, "The chart's fill")
      await until(
        "the screenshot on the draft",
        () => o.mock.draft()[0]?.capture?.screenshot !== undefined,
      )

      const shot = await likeness(o.page, await uploadedPng(o), truth)
      expect([shot.width, shot.height]).toEqual([chart.width, chart.height])
      expect(shot.differingShare).toBeLessThanOrEqual(MAX_DIFFERING_SHARE)
    },
    TEST_MS,
  )
})

describe("the screenshot tool on a heavy page", () => {
  test(
    "captures a drag across many rows of a 6,000-element list, matching what the browser paints",
    async () => {
      const o = await open()
      await addPage(o.page, rows(1500))
      const first = await boxOf(o.page.locator("#rows > div").nth(5))
      const region = { x: 200, y: Math.max(20, first.y), width: 480, height: 240 }
      const truth = await truthOf(o.page, region)

      await o.page.keyboard.press("s")
      await drag(o, region)
      const dialog = o.overlay.getByRole("dialog", { name: "Mark up screenshot" })
      const image = dialog.locator("img")
      await image.waitFor({ timeout: 20_000 })
      expect(await dialog.locator(".mk-heavy").count()).toBe(0)

      const src = await image.getAttribute("src")
      if (!src) throw new Error("the capture has no source")
      const shot = await likeness(o.page, src, truth)
      expect([shot.width, shot.height]).toEqual([region.width, region.height])
      expect(shot.colours).toBeGreaterThan(2)
      expect(shot.differingShare).toBeLessThanOrEqual(MAX_DIFFERING_SHARE)
    },
    TEST_MS,
  )
})

describe("a capture rooted at an element with a margin", () => {
  test.each([
    {
      name: "a heading with a top margin",
      html: '<div style="background:#fc0;width:420px"><h1 id="m" style="margin:48px 0 24px;font-size:40px;line-height:1;color:#000">Margin</h1></div>',
    },
    {
      name: "a list with a top margin",
      html: '<div style="background:#cde;width:420px"><ul id="m" style="margin:56px 0 24px;padding:0 0 0 40px;font-size:40px;line-height:1.1"><li>One</li><li>Two</li><li>Three</li><li>Four</li></ul></div>',
    },
  ])(
    "is not shifted down by the margin for $name",
    async ({ html }) => {
      const o = await open()
      await addPage(o.page, html)
      const region = await boxOf(o.page.locator("#m"))
      const truth = await truthOf(o.page, region)

      await drawRegion(o, region)
      await thumbnail(o).waitFor({ timeout: 15_000 })
      await saveNote(o, "Margin check")
      await until(
        "the screenshot on the draft",
        () => o.mock.draft()[0]?.capture?.screenshot !== undefined,
      )

      const shot = await likeness(o.page, await uploadedPng(o), truth)
      expect(shot.differingShare).toBeLessThanOrEqual(MAX_DIFFERING_SHARE)
    },
    TEST_MS,
  )
})

const MAX_SHOT_BYTES = 2 * 1024 * 1024

async function addNoise(page: Page, width: number, height: number) {
  await addPage(
    page,
    `<canvas id="noise" width="${width}" height="${height}" style="display:block"></canvas>`,
  )
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#noise")
    const pen = canvas?.getContext("2d")
    if (!canvas || !pen) throw new Error("no noise canvas")
    const image = pen.createImageData(canvas.width, canvas.height)
    for (let i = 0; i < image.data.length; i += 65_536) {
      crypto.getRandomValues(image.data.subarray(i, Math.min(i + 65_536, image.data.length)))
    }
    for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255
    pen.putImageData(image, 0, 0)
  })
}

describe("a capture whose full-resolution PNG is over 2 MiB", () => {
  test(
    "is kept at a lower resolution by the screenshot tool instead of being refused",
    async () => {
      const o = await open()
      await addNoise(o.page, 1180, 640)
      const region = { ...(await boxOf(o.page.locator("#noise"))), width: 1180, height: 640 }

      await o.page.keyboard.press("s")
      await drag(o, region)
      const dialog = o.overlay.getByRole("dialog", { name: "Mark up screenshot" })
      const image = dialog.locator("img")
      await image.waitFor({ timeout: 30_000 })
      expect(await dialog.locator(".mk-heavy").count()).toBe(0)

      const natural = await image.evaluate((img: HTMLImageElement) => [
        img.naturalWidth,
        img.naturalHeight,
      ])
      expect(natural[0]).toBeLessThan(region.width)
      const shown = await image.boundingBox()
      expect((shown?.width ?? 0) / (shown?.height ?? 1)).toBeCloseTo(
        region.width / region.height,
        1,
      )
    },
    TEST_MS,
  )

  test(
    "is attached to a region note at a lower resolution, under 2 MiB",
    async () => {
      const o = await open()
      await addNoise(o.page, 1180, 640)
      const region = { ...(await boxOf(o.page.locator("#noise"))), width: 1180, height: 640 }

      await drawRegion(o, region)
      await thumbnail(o).waitFor({ timeout: 30_000 })
      await saveNote(o, "Noisy area")
      await until(
        "the screenshot on the draft",
        () => o.mock.draft()[0]?.capture?.screenshot !== undefined,
        30_000,
      )

      expect(o.mock.draft()[0]?.capture?.omittedParts).toEqual([])
      const png = await uploadedPng(o)
      expect(png.length).toBeLessThanOrEqual(MAX_SHOT_BYTES)
      expect(png.length).toBeGreaterThan(MAX_SHOT_BYTES / 8)
    },
    TEST_MS,
  )
})
