import { type Browser, chromium, type Page } from "playwright"

/**
 * Grayscale text on every machine: Ubuntu's fontconfig turns on subpixel text in screenshots,
 * which an image-based capture can never draw, so pixel comparisons would measure the font setup.
 */
const DETERMINISTIC_TEXT = ["--disable-lcd-text"]

export async function launchChromium({ args = [] }: { args?: string[] } = {}): Promise<Browser> {
  return chromium.launch({ headless: true, args: [...DETERMINISTIC_TEXT, ...args] })
}

export async function newPage(
  browser: Browser,
): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const errors: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("pageerror", (error) => errors.push(error.message))
    return { page, errors, close: () => context.close() }
  } catch (error) {
    await context.close()
    throw error
  }
}
