import { expect, test } from "bun:test"
import { cp } from "node:fs/promises"
import { POINTER_LINE, type RoundId, RoundsResult, ServiceStatus } from "@iter8/protocol"
import type { Page } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import { SCRATCH_ROOT, scratchDir } from "../../rig/scratch"
import { openThroughProxy, type RunningService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { expectPointerOnly, pickAndNote, sendRound, startBuiltService } from "./steps"

const NOTE_BODY = "Tighten the card padding on small screens"

type Paired = { session: AgentSession; page: Page }

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

async function withPairedPage(run: (paired: Paired) => Promise<void>): Promise<void> {
  const disposers: (() => Promise<unknown>)[] = []
  let service: RunningService | undefined
  try {
    service = await startBuiltService()
    const running = service

    const copy = await scratchDir(`${SCRATCH_ROOT}e2e-clear-`)
    disposers.push(copy.dispose)
    await cp(fixtureDir("static"), copy.path, { recursive: true })

    const browser = await launchChromium()
    disposers.push(() => browser.close())

    const session = await startAgentSession(running)
    disposers.push(() => session.exit())

    const opened = await newPage(browser)
    disposers.push(opened.close)
    await openThroughProxy(running, opened.page, copy.path, { session })

    await run({ session, page: opened.page })
  } finally {
    await teardown([...disposers.reverse(), () => service?.stop()])
  }
}

const wokenEvents = (session: AgentSession) =>
  session.events.flatMap((event) => (event.event === "woken" ? [event] : []))

async function sendFromCard(paired: Paired): Promise<RoundId> {
  const wokenBefore = wokenEvents(paired.session).length
  await pickAndNote(paired.page, paired.page.locator('[data-source-target="card"]'), {
    intent: "change",
    body: NOTE_BODY,
  })
  await sendRound(paired.page)
  const woken = await waitFor(
    "the paired session to be woken by the round",
    async () => wokenEvents(paired.session)[wokenBefore] ?? null,
    { timeoutMs: 15_000 },
  )
  expect(woken.lines).toHaveLength(1)
  const id = POINTER_LINE.exec(woken.lines[0] ?? "")?.groups?.id
  if (id === undefined) throw new Error(`not a pointer line: ${woken.lines[0]}`)
  return id as RoundId
}

const ownerOf = async (session: AgentSession) =>
  (await session.run(["status", "--json"])).json(ServiceStatus).owner

test("an unclaimed round survives /clear under the new label and is announced once", async () => {
  await withPairedPage(async (paired) => {
    const { session, page } = paired
    const before = await ownerOf(session)
    if (before === null) throw new Error("the session is not paired before /clear")

    const r1 = await sendFromCard(paired)

    const cleared = await session.clear()
    expect(cleared.endExitCode).toBe(0)
    expect(cleared.exitCode).toBe(0)
    expect(cleared.label).not.toBe(before.process.label)
    expect(session.label).toBe(cleared.label)

    const after = await ownerOf(session)
    expect(after?.owner).toBe(before.owner)
    expect(after?.process.pid).toBe(before.process.pid)
    expect(after?.generation).toBe(before.generation)
    expect(after?.process.label).toBe(cleared.label)

    const grip = page.getByRole("button", { name: /^Session .*, (live|delivered)\./ })
    await waitFor(
      "the dock to stay paired after /clear",
      async () => ((await grip.count()) > 0 ? true : null),
      {
        timeoutMs: 10_000,
      },
    )
    expect(await page.getByRole("dialog", { name: "Session ended" }).count()).toBe(0)
    expect(await page.getByRole("button", { name: /, gone\./ }).count()).toBe(0)

    const listed = (await session.run(["rounds", "--json"])).json(RoundsResult)
    const summary = listed.rounds.find((round) => round.id === r1)
    expect(summary).toBeDefined()
    expect(summary?.stage).not.toBe("claimed")

    const prompted = await session.prompt()
    const announced = [...cleared.lines, ...prompted.lines]
    expect(announced.filter((line) => POINTER_LINE.exec(line)?.groups?.id === r1)).toHaveLength(1)
    expectPointerOnly(announced.join("\n"), r1, [NOTE_BODY])
  })
}, 60_000)

test("a round sent after /clear wakes the same session with a pointer naming it", async () => {
  await withPairedPage(async (paired) => {
    const { session } = paired

    await session.clear()
    await session.stop()

    const r2 = await sendFromCard(paired)

    const woken = wokenEvents(session).at(-1)
    if (woken === undefined) throw new Error("no wake event arrived after /clear")
    expectPointerOnly(woken.lines.join("\n"), r2, [NOTE_BODY])

    const listed = (await session.run(["rounds", "--json"])).json(RoundsResult)
    expect(listed.rounds.map((round) => round.id)).toEqual([r2])
  })
}, 60_000)
