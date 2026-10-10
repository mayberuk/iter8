import { expect } from "bun:test"
import { join } from "node:path"
import {
  type ElementAnchor,
  type Intent,
  POINTER_LINE,
  type RoundId,
  ShowResult,
} from "@iter8/protocol"
import type { Locator, Page } from "playwright"
import { BUILD_OUTPUTS } from "../../../scripts/build"
import type { AgentSession } from "../../rig/agent"
import { type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"

const REPO = join(import.meta.dir, "..", "..", "..")
const UI_TIMEOUT_MS = 10_000

export async function startBuiltService(): Promise<RunningService> {
  const override = process.env.ITER8_TEST_BINARY
  const binary =
    override !== undefined && override !== "" ? override : join(REPO, BUILD_OUTPUTS.bin)
  if (!(await Bun.file(binary).exists())) {
    throw new Error(`built binary missing at ${binary} — run bun run build`)
  }
  const service = await startService({ binary })
  if (service.status.overlay !== "present") {
    await service.stop()
    throw new Error(`the built binary at ${binary} reports no embedded overlay — run bun run build`)
  }
  return service
}

export async function pickAndNote(
  page: Page,
  target: Locator,
  note: { intent: Intent; body: string },
): Promise<void> {
  await page.getByRole("button", { name: "Pick element" }).click()
  await target.click()
  const composer = page.getByRole("dialog", { name: "New note" })
  await composer
    .getByRole("radiogroup", { name: "Intent" })
    .getByRole("radio", { name: note.intent })
    .check()
  await composer.getByRole("textbox", { name: "Note" }).fill(note.body)
  await composer.getByRole("button", { name: "Save note" }).click()
  await waitFor(
    "the composer to close after saving",
    async () => ((await composer.count()) === 0 ? true : null),
    { timeoutMs: UI_TIMEOUT_MS },
  )
}

export async function sendRound(page: Page): Promise<void> {
  const send = page.getByRole("button", { name: /^(Send|Queue)$/ })
  await send.click()
  await waitFor(
    "the sent drafts to leave the round",
    async () => ((await send.isDisabled()) ? true : null),
    { timeoutMs: UI_TIMEOUT_MS },
  )
  const toast = page.getByRole("status").filter({ hasText: /Round \d+ (delivered to|queued)/ })
  await waitFor(
    "the overlay to show the round as sent or queued",
    async () => ((await toast.count()) > 0 ? true : null),
    { timeoutMs: UI_TIMEOUT_MS },
  )
}

export async function showRound(session: AgentSession, round: RoundId): Promise<ShowResult> {
  return (await session.run(["show", round, "--json"])).json(ShowResult)
}

export async function expectLocatable(
  page: Page,
  anchor: ElementAnchor,
  picked: Locator,
): Promise<void> {
  const handle = await picked.elementHandle()
  if (handle === null) throw new Error("the picked element is not on the page")
  const resolved = await page.evaluate(
    ([selector, pickedElement]) => {
      const [first, ...hops] = selector
      if (first === undefined) throw new Error("an anchor selector has no entry")
      let matches = Array.from(document.querySelectorAll(first))
      for (const hop of hops) {
        matches = matches.flatMap((el) =>
          el.shadowRoot === null ? [] : Array.from(el.shadowRoot.querySelectorAll(hop)),
        )
      }
      return {
        count: matches.length,
        same: matches[0] === pickedElement,
        text: (pickedElement.textContent ?? "").replace(/\s+/g, " ").trim(),
      }
    },
    [anchor.selector, handle] as const,
  )
  expect(resolved.count).toBe(1)
  expect(resolved.same).toBe(true)

  const described = /^- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(await picked.ariaSnapshot())
  if (anchor.role !== undefined) expect(described?.[1]).toBe(anchor.role)
  if (anchor.name !== undefined) expect(described?.[2]?.replace(/\\(.)/g, "$1")).toBe(anchor.name)
  if (anchor.text !== undefined) expect(resolved.text.startsWith(anchor.text)).toBe(true)
}

export function expectPointerOnly(text: string, round: RoundId, forbidden: string[]): void {
  const lines = text.split("\n").filter((line) => line !== "")
  for (const line of lines) expect(line).toMatch(POINTER_LINE)
  expect(lines.some((line) => POINTER_LINE.exec(line)?.groups?.id === round)).toBe(true)
  for (const fragment of forbidden) expect(text).not.toContain(fragment)
}
