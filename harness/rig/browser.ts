import { type Browser, chromium, type Page } from "playwright"

export async function launchChromium({ args = [] }: { args?: string[] } = {}): Promise<Browser> {
  return chromium.launch({ headless: true, args })
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
