import { afterAll, beforeAll, expect, test } from "bun:test"
import { cp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DraftBody, Note } from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { fixtureDir } from "../../rig/fixtures"
import { SCRATCH_ROOT, type Scratch, scratchDir } from "../../rig/scratch"
import { openThroughProxy, type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { type Iter8Probe, PROBE_GLOBAL } from "../../stubs/probe-overlay"

const draftBody = DraftBody.parse(
  await Bun.file(
    new URL("../../../packages/protocol/fixtures/DraftBody.json", import.meta.url),
  ).json(),
)

let browser: Browser
let bundle: Scratch
let service: RunningService
let session: AgentSession

beforeAll(async () => {
  bundle = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url)),
  )
  service = await startService({ overlayDir: bundle.path })
  session = await startAgentSession(service)
  browser = await launchChromium()
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await session?.exit()
  await service?.stop()
  await bundle?.dispose()
})

const snapshot = (page: Page) =>
  page.evaluate((global) => {
    const probe = Reflect.get(window, global) as Iter8Probe | undefined
    if (!probe) return null
    const { hello, connected, messages } = probe
    return { hello, connected, messages }
  }, PROBE_GLOBAL)

const readProbe = async <K extends "hello" | "connected" | "messages">(page: Page, key: K) =>
  (await snapshot(page))?.[key] ?? null

const putDraft = (page: Page, body: DraftBody) =>
  page.evaluate(([global, body]) => (Reflect.get(window, global) as Iter8Probe).putDraft(body), [
    PROBE_GLOBAL,
    body,
  ] as const)

test("an edit to an opened folder reloads the open page and its drafts survive the reload", async () => {
  const folder = await scratchDir(`${SCRATCH_ROOT}folder-`)
  const { page, errors, close } = await newPage(browser)
  try {
    await cp(fixtureDir("static"), folder.path, { recursive: true })
    const { open } = await openThroughProxy(service, page, folder.path, { session })

    await waitFor("the live socket", async () =>
      (await readProbe(page, "connected")) ? true : null,
    )
    const created = await Promise.all([putDraft(page, draftBody), putDraft(page, draftBody)])
    expect(created.map((reply) => reply.status)).toEqual([201, 201])
    const draftIds = created.map((reply) => Note.parse(reply.body).id).sort()
    expect(new Set(draftIds).size).toBe(2)

    const indexPath = join(folder.path, "index.html")
    const edited = (await readFile(indexPath, "utf8")).replace(
      "Card in static",
      "Card edited by the agent",
    )
    expect(edited).toContain("Card edited by the agent")
    await writeFile(indexPath, edited)

    await waitFor("the reload message", async () => {
      const messages = await readProbe(page, "messages")
      return messages?.some((message) => message.type === "reload") ? true : null
    })

    await page.reload()
    expect(await page.locator("[data-source-target=card]").textContent()).toBe(
      "Card edited by the agent",
    )

    const hello = await waitFor("the hello after the reload", () => readProbe(page, "hello"))
    if (hello.outcome !== "accepted") throw new Error(`hello was refused: ${hello.reason}`)
    expect(hello.state.drafts.map((draft) => draft.id).sort()).toEqual(draftIds)
    expect(hello.state.drafts.every((draft) => draft.pageId === open.page.id)).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await close()
    await folder.dispose()
  }
}, 60_000)

test("a request that climbs out of the folder is a 404", async () => {
  const folder = await scratchDir(`${SCRATCH_ROOT}folder-`)
  const { page, close } = await newPage(browser)
  try {
    await cp(fixtureDir("static"), folder.path, { recursive: true })
    await openThroughProxy(service, page, folder.path, { session })

    const status = await page.evaluate(() =>
      fetch("/..%2f..%2fetc/passwd").then((response) => response.status),
    )
    expect(status).toBe(404)
  } finally {
    await close()
    await folder.dispose()
  }
}, 60_000)
