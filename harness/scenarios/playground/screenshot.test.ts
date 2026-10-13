import { expect, test } from "bun:test"
import type { Page } from "playwright"
import { visit, withPlayground } from "./support"

/** A pixel counts as different past this summed gap over red, green and blue, out of 765. */
const PIXEL_GAP = 48
/** Antialiasing and subpixel text placement differ between the library's render and the browser's own. */
const MAX_DIFFERING_SHARE = 0.03

type Region = { x: number; y: number; width: number; height: number }

type Likeness = { width: number; height: number; differingShare: number }

async function likeness(page: Page, source: string, truth: Buffer): Promise<Likeness> {
  return page.evaluate(
    async ({ source, truth, gap }) => {
      const shot = await createImageBitmap(await (await fetch(source)).blob())
      const expected = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${truth}`)).blob(),
      )
      const read = (bitmap: ImageBitmap) => {
        const canvas = document.createElement("canvas")
        canvas.width = expected.width
        canvas.height = expected.height
        const pen = canvas.getContext("2d")
        if (!pen) throw new Error("no 2d canvas")
        pen.drawImage(bitmap, 0, 0, expected.width, expected.height)
        return pen.getImageData(0, 0, expected.width, expected.height).data
      }
      const a = read(shot)
      const b = read(expected)
      let differing = 0
      for (let at = 0; at < a.length; at += 4) {
        const delta =
          Math.abs((a[at] ?? 0) - (b[at] ?? 0)) +
          Math.abs((a[at + 1] ?? 0) - (b[at + 1] ?? 0)) +
          Math.abs((a[at + 2] ?? 0) - (b[at + 2] ?? 0))
        if (delta > gap) differing += 1
      }
      return {
        width: shot.width,
        height: shot.height,
        differingShare: differing / (expected.width * expected.height),
      }
    },
    { source, truth: truth.toString("base64"), gap: PIXEL_GAP },
  )
}

/** Captures `region` through the screenshot tool, or the full viewport when it is null, and compares it with the browser's own. */
async function captureAndCompare(page: Page, region: Region | null): Promise<Likeness> {
  const viewport = page.viewportSize()
  if (!viewport) throw new Error("the page has no viewport")
  const clip = region ?? { x: 0, y: 0, ...viewport }
  // A hovered row paints differently, and the capture starts with the pointer over the overlay.
  await page.mouse.move(2, 2)
  const truth = await page.screenshot({ clip, style: "iter8-overlay { display: none !important }" })
  const overlay = page.locator("iter8-overlay")
  await page.keyboard.press("s")
  if (region === null) await page.keyboard.press("Enter")
  else {
    await page.mouse.move(region.x, region.y)
    await page.mouse.down()
    await page.mouse.move(region.x + region.width, region.y + region.height, { steps: 8 })
    await page.mouse.up()
  }
  const dialog = overlay.getByRole("dialog", { name: "Mark up screenshot" })
  const image = dialog.locator("img")
  await image.waitFor({ timeout: 30_000 })
  expect(await dialog.locator(".mk-heavy").count()).toBe(0)
  const src = await image.getAttribute("src")
  if (!src) throw new Error("the capture has no source")
  const result = await likeness(page, src, truth)
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
  return result
}

const CUSTOMERS_DRAGS: Region[] = [
  { x: 300, y: 230, width: 200, height: 150 },
  { x: 320, y: 260, width: 600, height: 400 },
  { x: 290, y: 215, width: 940, height: 480 },
]

test("a drag across the rows of the 200-row customers table is captured, and matches the browser's own screenshot", async () => {
  await withPlayground(async ({ page, open }) => {
    await visit(page, open, "/app/customers")
    for (const region of CUSTOMERS_DRAGS) {
      const shot = await captureAndCompare(page, region)
      expect([shot.width, shot.height]).toEqual([region.width, region.height])
      expect(shot.differingShare).toBeLessThanOrEqual(MAX_DIFFERING_SHARE)
    }
  })
}, 240_000)

test("drags and the full viewport on the home page, a page 1,787 px tall, are captured and match the browser's own screenshot", async () => {
  await withPlayground(async ({ page, open }) => {
    await visit(page, open, "/", 500)
    for (const region of [
      { x: 100, y: 100, width: 700, height: 350 },
      { x: 500, y: 300, width: 300, height: 200 },
      { x: 60, y: 60, width: 1000, height: 600 },
      null,
    ]) {
      const shot = await captureAndCompare(page, region)
      const size = region ?? page.viewportSize()
      expect([shot.width, shot.height]).toEqual([size?.width ?? 0, size?.height ?? 0])
      expect(shot.differingShare).toBeLessThanOrEqual(MAX_DIFFERING_SHARE)
    }
  })
}, 240_000)
