import { expect, test } from "bun:test"
import type { Page } from "playwright"
import { launchChromium } from "../../rig/browser"
import { startFrameProbe } from "../../rig/frames"
import { startLongTaskProbe } from "../../rig/long-task"
import { calibrateThrottle, throttleCpu } from "../../rig/throttle"
import { visit, withPlayground } from "./support"

const TASK_BUDGET_MS = 50

type Region = { x: number; y: number; width: number; height: number }

/** Drags over the 200-row customers table, from a few rows to most of its visible area; null is the full viewport. */
const DRAGS: (Region | null)[] = [
  { x: 300, y: 230, width: 200, height: 150 },
  { x: 320, y: 260, width: 600, height: 400 },
  { x: 290, y: 215, width: 940, height: 480 },
  null,
]

async function capture(page: Page, region: Region | null): Promise<void> {
  await page.mouse.move(2, 2)
  await page.keyboard.press("s")
  if (region === null) await page.keyboard.press("Enter")
  else {
    await page.mouse.move(region.x, region.y)
    await page.mouse.down()
    await page.mouse.move(region.x + region.width, region.y + region.height, { steps: 8 })
    await page.mouse.up()
  }
  const dialog = page.locator("iter8-overlay").getByRole("dialog", { name: "Mark up screenshot" })
  await dialog.locator("img").waitFor({ timeout: 60_000 })
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })
}

async function longestTaskWhileCapturing(page: Page, regions: (Region | null)[]): Promise<number> {
  const frames = await startFrameProbe(page)
  const tasks = await startLongTaskProbe(page)
  for (const region of regions) await capture(page, region)
  const { longestMs } = await tasks.stop()
  await frames.stop()
  return longestMs
}

test("capturing drags over the customers table keeps every main-thread task within budget at normal speed", async () => {
  await withPlayground(async ({ page, open }) => {
    await visit(page, open, "/app/customers")
    const longestMs = await longestTaskWhileCapturing(page, DRAGS)
    console.info(`normal speed: longest task ${longestMs.toFixed(1)} ms over ${DRAGS.length} drags`)
    expect(longestMs, `longest task ${longestMs.toFixed(1)} ms`).toBeLessThanOrEqual(TASK_BUDGET_MS)
  })
}, 240_000)

const THROTTLED_DRAGS: { route: string; name: string; region: Region | null }[] = [
  { route: "/app/customers", name: "200x150", region: { x: 300, y: 230, width: 200, height: 150 } },
  { route: "/app/customers", name: "500x300", region: { x: 300, y: 230, width: 500, height: 300 } },
  { route: "/app/customers", name: "800x450", region: { x: 300, y: 230, width: 800, height: 450 } },
  { route: "/app/customers", name: "full viewport", region: null },
  { route: "/heavy", name: "800x450", region: { x: 300, y: 230, width: 800, height: 450 } },
  { route: "/heavy", name: "full viewport", region: null },
]

for (const { route, name, region } of THROTTLED_DRAGS) {
  test(`capturing a ${name} drag on ${route} at the calibrated 4x throttle stays within the page-relative bound`, async () => {
    const browser = await launchChromium()
    try {
      const rate = (await calibrateThrottle(browser)).rate
      await withPlayground(async ({ page, open }) => {
        await visit(page, open, route)
        const throttle = await throttleCpu(page, rate)
        try {
          const alone = await startLongTaskProbe(page)
          const idle = await startFrameProbe(page)
          await page.waitForTimeout(2000)
          const aloneMs = (await alone.stop()).longestMs
          await idle.stop()
          const longestMs = await longestTaskWhileCapturing(page, [region])
          const bound = Math.max(TASK_BUDGET_MS, 1.3 * aloneMs)
          console.info(
            `4x throttle, ${route} ${name}: longest task ${longestMs.toFixed(1)} ms; page alone ${aloneMs.toFixed(1)} ms`,
          )
          expect(
            longestMs,
            `longest task ${longestMs.toFixed(1)} ms against ${bound.toFixed(1)} ms; page alone ${aloneMs.toFixed(1)} ms at rate ${rate.toFixed(2)}`,
          ).toBeLessThanOrEqual(bound)
        } finally {
          await throttle.restore()
        }
      })
    } finally {
      await browser.close()
    }
  }, 240_000)
}

test("a drag deep in the 6,000-row heavy page is refused as too heavy without a long task", async () => {
  await withPlayground(async ({ page, open }) => {
    await visit(page, open, "/heavy")
    const row = page.locator("tbody tr").nth(3000)
    await row.evaluate((el) => el.scrollIntoView({ block: "center" }))
    const box = await row.boundingBox()
    if (!box) throw new Error("the row has no box")
    const frames = await startFrameProbe(page)
    const tasks = await startLongTaskProbe(page)
    await page.mouse.move(2, 2)
    await page.keyboard.press("s")
    await page.mouse.move(box.x + 20, box.y)
    await page.mouse.down()
    await page.mouse.move(box.x + 420, box.y + 160, { steps: 8 })
    await page.mouse.up()
    const dialog = page.locator("iter8-overlay").getByRole("dialog", { name: "Mark up screenshot" })
    await dialog.getByText("too heavy to capture").waitFor({ timeout: 30_000 })
    const { longestMs } = await tasks.stop()
    await frames.stop()
    expect(await dialog.locator("img").count()).toBe(0)
    expect(longestMs, `longest task ${longestMs.toFixed(1)} ms`).toBeLessThanOrEqual(TASK_BUDGET_MS)
  })
}, 240_000)
