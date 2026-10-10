import { afterAll, beforeAll, expect, test } from "bun:test"
import { DraftBody, Note, OverlayPrefs, Pairing, SendResult } from "@iter8/protocol"
import type { Browser } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { fixtureDir } from "../../rig/fixtures"
import { waitFor } from "../../rig/wait"
import { type MockService, startMockService } from "../../stubs/mock-service"
import { type Iter8Probe, PROBE_GLOBAL } from "../../stubs/probe-overlay"

const sample = (name: string) =>
  Bun.file(new URL(`../../../packages/protocol/fixtures/${name}.json`, import.meta.url)).json()

const pairing = Pairing.parse(await sample("Pairing"))
const draftBody = DraftBody.parse(await sample("DraftBody"))
const prefs = OverlayPrefs.parse({ ...(await sample("OverlayPrefs")), theme: "dark", dock: "tl" })

let browser: Browser
let mock: MockService

beforeAll(async () => {
  const overlayDir = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url)),
  )
  mock = await startMockService({ folder: fixtureDir("static"), overlayDir, pairing, prefs })
  browser = await launchChromium()
})

afterAll(async () => {
  await browser?.close()
  await mock?.stop()
})

test("the probe overlay boots through the mock service on a *.localhost page", async () => {
  const { page, errors, close } = await newPage(browser)
  try {
    const snapshot = () =>
      page.evaluate((global) => {
        const probe = Reflect.get(window, global) as Iter8Probe | undefined
        if (!probe) return null
        const { hello, connected, messages, lastError } = probe
        return { hello, connected, messages, lastError }
      }, PROBE_GLOBAL)
    const read = async <K extends "hello" | "connected" | "messages" | "lastError">(key: K) =>
      (await snapshot())?.[key] ?? null
    const call = (name: "call" | "putDraft" | "send", args: unknown[]) =>
      page.evaluate(
        ([global, name, args]) => {
          const probe = Reflect.get(window, global) as Iter8Probe
          return (probe[name] as (...args: unknown[]) => Promise<unknown>)(...args)
        },
        [PROBE_GLOBAL, name, args] as const,
      ) as Promise<{ status: number; body: unknown }>

    await page.goto(mock.pageUrl("/"))
    expect(new URL(page.url()).hostname).toBe(`${mock.pageId}.localhost`)

    const hello = await waitFor("the probe's hello", () => read("hello"))
    expect(hello).toMatchObject({ outcome: "accepted", state: { prefs, pairing } })
    await waitFor("the live socket", async () => ((await read("connected")) ? true : null))

    expect(await call("call", ["GET", "/__iter8/prefs"])).toEqual({ status: 200, body: prefs })

    const created = await call("putDraft", [draftBody])
    expect(created.status).toBe(201)
    const note = Note.parse(created.body)
    const sent = await call("send", [[note.id], pairing.generation])
    expect(sent.status).toBe(200)
    expect(SendResult.parse(sent.body).outcome).toBe("accepted")
    expect(mock.rounds()).toEqual([
      expect.objectContaining({ notes: [expect.objectContaining({ id: note.id })] }),
    ])

    mock.push({ type: "reload" })
    const messages = await waitFor("the reload message", async () => {
      const received = await read("messages")
      return received && received.length > 0 ? received : null
    })
    expect(messages).toEqual([{ type: "reload" }])
    expect(await read("lastError")).toBeNull()
    expect(errors).toEqual([])
  } finally {
    await close()
  }
}, 30_000)
