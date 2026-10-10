import { expect, test } from "bun:test"
import { cp } from "node:fs/promises"
import { POINTER_LINE, RoundId, RoundsResult } from "@iter8/protocol"
import { errors, type Locator, type Page } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import { SCRATCH_ROOT, scratchDir } from "../../rig/scratch"
import { openThroughProxy, type RunningService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { pickAndNote, sendRound, showRound, startBuiltService } from "./steps"

const UI_TIMEOUT_MS = 15_000

async function teardown(steps: (() => Promise<unknown> | undefined)[]): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "teardown failed")
}

const wokenEvents = (session: AgentSession) =>
  session.events.flatMap((event) => (event.event === "woken" ? [event] : []))

type Setup = {
  dying: AgentSession
  survivor: AgentSession
  page: Page
  send: Locator
  gone: Locator
  orphanNotice: Locator
  attachSurvivor: (scope: Locator) => Locator
}

async function setUp(
  disposers: (() => Promise<unknown>)[],
  start: () => Promise<RunningService>,
): Promise<Setup> {
  const service = await start()
  disposers.push(() => service.stop())

  const browser = await launchChromium()
  disposers.push(() => browser.close())

  const copy = await scratchDir(`${SCRATCH_ROOT}e2e-dead-session-`)
  disposers.push(copy.dispose)
  await cp(fixtureDir("static"), copy.path, { recursive: true })

  const dying = await startAgentSession(service)
  const survivor = await startAgentSession(service)
  disposers.push(() => survivor.exit())

  const opened = await newPage(browser)
  disposers.push(opened.close)
  await openThroughProxy(service, opened.page, copy.path, { session: dying })

  const { page } = opened
  return {
    dying,
    survivor,
    page,
    send: page.getByRole("button", { name: /^(Send|Queue)$/ }),
    gone: page.getByRole("dialog", { name: "Session ended" }),
    orphanNotice: page.getByRole("status").filter({ hasText: /Round \d+ wasn't delivered/ }),
    attachSurvivor: (scope) =>
      scope.getByRole("button", { name: /^Attach to / }).filter({ hasText: survivor.label }),
  }
}

test("a page whose session died refuses Send and reattaches in one click without losing a note", async () => {
  const disposers: (() => Promise<unknown>)[] = []
  try {
    const { dying, survivor, page, send, gone, orphanNotice, attachSurvivor } = await setUp(
      disposers,
      startBuiltService,
    )
    const planned = [
      "Overview heading is too close to the top edge",
      "Card text should read as a callout",
    ]
    await pickAndNote(page, page.getByRole("heading", { name: "Overview" }), {
      intent: "fix",
      body: planned[0] ?? "",
    })
    await pickAndNote(page, page.getByText("Card in static"), {
      intent: "change",
      body: planned[1] ?? "",
    })

    await dying.crash()
    try {
      await send.click({ timeout: 2_000 })
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error
    }

    const sentToast = page
      .getByRole("status")
      .filter({ hasText: /Round \d+ (delivered to|queued)/ })
    let sawSent = false
    await waitFor(
      "the page to show the session ended with Send disabled and the live session offered",
      async () => {
        if ((await sentToast.count()) > 0) sawSent = true
        if (await send.isEnabled()) return null
        return (await attachSurvivor(gone).count()) > 0 ? true : null
      },
      { timeoutMs: UI_TIMEOUT_MS, everyMs: 50 },
    )
    if (sawSent || (await orphanNotice.count()) > 0) {
      await waitFor(
        "the accepted round to show as not delivered",
        async () => ((await orphanNotice.count()) > 0 ? true : null),
        { timeoutMs: UI_TIMEOUT_MS },
      )
    }

    await attachSurvivor(gone).click()
    await waitFor(
      "the page to report it attached to the live session",
      async () =>
        (await page
          .getByRole("status")
          .filter({ hasText: /Attached to/ })
          .count()) > 0
          ? true
          : null,
      { timeoutMs: UI_TIMEOUT_MS },
    )
    if (await send.isEnabled()) await sendRound(page)

    await waitFor(
      "the live session to be woken",
      async () => (wokenEvents(survivor).length > 0 ? true : null),
      { timeoutMs: UI_TIMEOUT_MS },
    )
    const listed = await waitFor(
      "both notes to reach the live session",
      async () => {
        const rounds = (await survivor.run(["rounds", "--json"])).json(RoundsResult)
        return rounds.rounds.reduce((sum, round) => sum + round.noteCount, 0) >= planned.length
          ? rounds
          : null
      },
      { timeoutMs: UI_TIMEOUT_MS, everyMs: 200 },
    )
    const arrived: string[] = []
    for (const round of listed.rounds) {
      const shown = await showRound(survivor, round.id)
      arrived.push(...shown.notes.map((note) => note.authored.body))
    }
    expect(arrived.sort()).toEqual([...planned].sort())

    const after = (await survivor.run(["rounds", "--json"])).json(RoundsResult)
    expect(after.rounds.reduce((sum, round) => sum + round.noteCount, 0)).toBe(planned.length)
  } finally {
    await teardown(disposers.reverse().map((dispose) => () => dispose()))
  }
}, 60_000)

test("a round queued for a session that died before picking it up shows as not delivered and moves to the reattached session", async () => {
  const disposers: (() => Promise<unknown>)[] = []
  try {
    const { dying, survivor, page, orphanNotice, attachSurvivor } = await setUp(
      disposers,
      startBuiltService,
    )
    await pickAndNote(page, page.getByRole("heading", { name: "Details" }), {
      intent: "question",
      body: "Why does Details repeat the page name?",
    })
    await sendRound(page)

    const woken = await waitFor(
      "the owning session to be woken for the round",
      async () => wokenEvents(dying)[0] ?? null,
      { timeoutMs: UI_TIMEOUT_MS },
    )
    const pointer = POINTER_LINE.exec(woken.lines[0] ?? "")?.groups?.id
    if (pointer === undefined) throw new Error(`not a pointer line: ${woken.lines.join("\n")}`)
    const round = RoundId.parse(pointer)

    await dying.crash()

    const failure = orphanNotice.filter({ hasText: `Round ${round.slice(1)} wasn't delivered` })
    await waitFor(
      "the page to show the round as not delivered",
      async () => ((await attachSurvivor(failure).count()) > 0 ? true : null),
      { timeoutMs: UI_TIMEOUT_MS, everyMs: 50 },
    )
    await attachSurvivor(failure).click()

    const queued = await waitFor(
      "the round to be requeued to the reattached session",
      async () => {
        const rounds = (await survivor.run(["rounds", "--json"])).json(RoundsResult)
        return rounds.rounds.find((candidate) => candidate.id === round) ?? null
      },
      { timeoutMs: UI_TIMEOUT_MS, everyMs: 200 },
    )
    expect(["queued", "announced"]).toContain(queued.stage)

    const requeueWake = await waitFor(
      "the reattached session to be woken for the round",
      async () =>
        wokenEvents(survivor).find((event) =>
          event.lines.some((line) => POINTER_LINE.exec(line)?.groups?.id === round),
        ) ?? null,
      { timeoutMs: UI_TIMEOUT_MS },
    )
    expect(requeueWake.lines.length).toBeGreaterThan(0)
  } finally {
    await teardown(disposers.reverse().map((dispose) => () => dispose()))
  }
}, 60_000)
