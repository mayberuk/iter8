import type { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import {
  HookEndReason,
  LiveSession,
  OwnerId,
  PageId,
  Pairing,
  PairingGeneration,
  PairingState,
} from "@iter8/protocol"
import type { Subprocess } from "bun"
import fc from "fast-check"
import { openStore } from "../store/db"
import { createOwners, nextPairingState, type OwnerEvent, type RegisterOwner } from "./owners"
import { readProcessStart } from "./process-identity"

const children: Subprocess[] = []
const stores: Database[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
  for (const db of stores.splice(0)) db.close()
})

function setup() {
  const db = openStore(":memory:")
  stores.push(db)
  const starts = new Map<number, string>()
  const owners = createOwners(db, {
    processStart: (pid) => starts.get(pid) ?? null,
    now: () => new Date("2026-10-09T12:00:00.000Z"),
  })
  return { db, starts, owners }
}

function input(pid: number, overrides: Partial<RegisterOwner> = {}): RegisterOwner {
  return { pid, label: "first", source: "startup", agent: "claude", cwd: "/work/app", ...overrides }
}

function insertPage(db: Database, id: string): PageId {
  db.query(
    `INSERT INTO pages (id, token, project_root, target_kind, target, port, owner_id, generation, created_at)
     VALUES (?, ?, '/work/app', 'server', ?, 3990, NULL, 0, '2026-10-09T12:00:00.000Z')`,
  ).run(id, `token-${id}`, `http://localhost:5173/${id}`)
  return PageId.parse(id)
}

const live: PairingState = { status: "live" }
const busy: PairingState = { status: "busy" }
const unknown: PairingState = { status: "unknown" }
const running: PairingState = { status: "background", agents: 2, tasks: 1 }

describe("nextPairingState", () => {
  test.each<[PairingState, boolean, OwnerEvent, PairingState]>([
    [live, false, { kind: "busy" }, busy],
    [busy, false, { kind: "idle" }, live],
    [unknown, false, { kind: "busy" }, busy],
    [live, false, { kind: "checked", process: "alive" }, live],
    [busy, false, { kind: "checked", process: "alive" }, busy],
    [live, false, { kind: "checked", process: "dead" }, { status: "gone", reason: "crashed" }],
    [busy, true, { kind: "checked", process: "dead" }, { status: "gone", reason: "exited" }],
    [
      live,
      false,
      { kind: "checked", process: "restarted" },
      { status: "gone", reason: "replaced" },
    ],
    [live, true, { kind: "checked", process: "restarted" }, { status: "gone", reason: "replaced" }],
    [live, false, { kind: "checked", process: "unreadable" }, unknown],
    [live, false, { kind: "ended", reason: "clear" }, live],
    [busy, false, { kind: "ended", reason: "resume" }, busy],
    [live, false, { kind: "ended", reason: "logout" }, { status: "gone", reason: "ended" }],
    [
      live,
      false,
      { kind: "ended", reason: "prompt_input_exit" },
      { status: "gone", reason: "ended" },
    ],
    [busy, true, { kind: "ended", reason: "other" }, { status: "gone", reason: "ended" }],
    [live, false, { kind: "relabelled" }, live],
    [busy, false, { kind: "stopped", work: { agents: 2, tasks: 1 } }, running],
    [
      live,
      false,
      { kind: "stopped", work: { agents: 0, tasks: 3 } },
      { status: "background", agents: 0, tasks: 3 },
    ],
    [
      unknown,
      false,
      { kind: "stopped", work: { agents: 1, tasks: 0 } },
      { status: "background", agents: 1, tasks: 0 },
    ],
    [busy, false, { kind: "stopped", work: { agents: 0, tasks: 0 } }, live],
    [running, false, { kind: "stopped", work: { agents: 0, tasks: 0 } }, live],
    [
      running,
      false,
      { kind: "stopped", work: { agents: 1, tasks: 0 } },
      { status: "background", agents: 1, tasks: 0 },
    ],
    [running, false, { kind: "idle" }, running],
    [running, false, { kind: "busy" }, busy],
    [running, false, { kind: "checked", process: "alive" }, running],
    [running, false, { kind: "checked", process: "dead" }, { status: "gone", reason: "crashed" }],
    [running, false, { kind: "checked", process: "unreadable" }, unknown],
    [running, false, { kind: "ended", reason: "resume" }, running],
    [running, false, { kind: "ended", reason: "logout" }, { status: "gone", reason: "ended" }],
  ])("%o with relabel pending %p on %o gives %o", (state, pending, event, expected) => {
    expect(nextPairingState(state, pending, event)).toEqual(expected)
  })
})

const goneState = fc.constantFrom<PairingState>(
  { status: "gone", reason: "exited" },
  { status: "gone", reason: "crashed" },
  { status: "gone", reason: "replaced" },
  { status: "gone", reason: "ended" },
)
const anyEvent = fc.oneof(
  fc.constant<OwnerEvent>({ kind: "relabelled" }),
  fc.constant<OwnerEvent>({ kind: "busy" }),
  fc.constant<OwnerEvent>({ kind: "idle" }),
  fc
    .record({ agents: fc.nat(3), tasks: fc.nat(3) })
    .map((work): OwnerEvent => ({ kind: "stopped", work })),
  fc
    .constantFrom(...HookEndReason.options)
    .map((reason): OwnerEvent => ({ kind: "ended", reason })),
  fc
    .constantFrom(...(["alive", "dead", "restarted", "unreadable"] as const))
    .map((process): OwnerEvent => ({ kind: "checked", process })),
)

describe("background work", () => {
  test("a stop yields background with exactly its counts when any are running, and live otherwise", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<PairingState>(live, busy, unknown, running),
        fc.record({ agents: fc.nat(5), tasks: fc.nat(5) }),
        (state, work) => {
          const next = nextPairingState(state, false, { kind: "stopped", work })
          expect(next).toEqual(
            work.agents + work.tasks > 0 ? { status: "background", ...work } : live,
          )
        },
      ),
    )
  })

  test("a mod's idle report never ends background work, and a new prompt always does", () => {
    fc.assert(
      fc.property(
        fc.record({ agents: fc.nat(5), tasks: fc.nat(5) }).filter((w) => w.agents + w.tasks > 0),
        (work) => {
          const state = nextPairingState(live, false, { kind: "stopped", work })
          expect(nextPairingState(state, false, { kind: "idle" })).toEqual(state)
          expect(nextPairingState(state, false, { kind: "busy" })).toEqual(busy)
        },
      ),
    )
  })

  test("every state any event sequence reaches is a valid pairing state", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ pending: fc.boolean(), event: anyEvent }), { maxLength: 30 }),
        (steps) => {
          let state: PairingState = live
          for (const { pending, event } of steps) {
            state = nextPairingState(state, pending, event)
            expect(PairingState.safeParse(state).success).toBe(true)
          }
        },
      ),
    )
  })
})

describe("gone is never left", () => {
  test("no event sequence moves a gone state anywhere else", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<PairingState>(live, busy, unknown),
        fc.array(fc.record({ pending: fc.boolean(), event: anyEvent }), { maxLength: 30 }),
        (start, steps) => {
          let state = start
          let gone: PairingState | null = null
          for (const { pending, event } of steps) {
            state = nextPairingState(state, pending, event)
            if (gone) expect(state).toEqual(gone)
            else if (state.status === "gone") gone = state
          }
        },
      ),
    )
  })

  test("a gone state is returned unchanged for every event", () => {
    fc.assert(
      fc.property(goneState, fc.boolean(), anyEvent, (state, pending, event) => {
        expect(nextPairingState(state, pending, event)).toEqual(state)
      }),
    )
  })

  test("an owner reported gone keeps that reason through later hooks and process changes", () => {
    const operation = fc.oneof(
      fc.record({ op: fc.constant("busy" as const), busy: fc.boolean() }),
      fc.record({
        op: fc.constant("stop" as const),
        agents: fc.nat(2),
        tasks: fc.nat(2),
      }),
      fc.record({
        op: fc.constant("end" as const),
        reason: fc.constantFrom(...HookEndReason.options),
      }),
      fc.record({ op: fc.constant("start" as const), start: fc.constantFrom("s1", "s2", null) }),
    )
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 25 }), (operations) => {
        const { starts, owners } = setup()
        starts.set(100, "s1")
        const ownerId = owners.register(input(100)).owner
        let gone: PairingState | null = null
        for (const step of operations) {
          if (step.op === "busy") owners.setBusy(ownerId, step.busy)
          else if (step.op === "stop")
            owners.setStopped(ownerId, { agents: step.agents, tasks: step.tasks })
          else if (step.op === "end") owners.end(100, "first", step.reason)
          else if (step.start === null) starts.delete(100)
          else starts.set(100, step.start)
          const state = owners.state(ownerId)
          if (gone) expect(state).toEqual(gone)
          else if (state.status === "gone") gone = state
        }
      }),
    )
  })
})

describe("register", () => {
  test("a new process gets an o_ owner id and its agent unchanged in the Pairing and live session", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    const pairing = owners.register(input(100, { agent: "claude", label: "fix-header" }))
    expect(Pairing.parse(pairing)).toEqual(pairing)
    expect(pairing.owner).toMatch(/^o_[A-Za-z0-9_-]+$/)
    expect(pairing).toMatchObject({
      agent: "claude",
      process: { pid: 100, startedAt: "s1", label: "fix-header" },
      cwd: "/work/app",
      generation: 0,
      state: live,
      relabelPending: false,
      listener: "none",
    })
    const sessions = owners.liveSessions()
    expect(sessions).toHaveLength(1)
    expect(LiveSession.parse(sessions[0])).toMatchObject({ owner: pairing.owner, agent: "claude" })
  })

  test("the same pid and start time relabels the owner and keeps its pages paired at the same generations", () => {
    const { db, starts, owners } = setup()
    starts.set(100, "s1")
    const first = owners.register(input(100, { label: "before" }))
    const pageA = insertPage(db, "alpha")
    const pageB = insertPage(db, "bravo")
    owners.pairPage(pageA, first.owner)
    owners.pairPage(pageB, first.owner)
    const generationB = owners.pairPage(pageB, first.owner)
    owners.end(100, "before", "clear")

    const again = owners.register(input(100, { label: "after", source: "clear" }))

    expect(again.owner).toBe(first.owner)
    expect(again.process.label).toBe("after")
    expect(again.relabelPending).toBe(false)
    expect(again.generation).toBe(generationB)
    expect(owners.pagesOf(first.owner)).toEqual([pageA, pageB])
    expect(owners.checkGeneration(pageA, PairingGeneration.parse(1))).toBe(true)
    expect(owners.checkGeneration(pageB, generationB)).toBe(true)
    expect(db.query("SELECT COUNT(*) AS n FROM owners").get()).toEqual({ n: 1 })
  })

  test("registering the same process again after it was persisted as gone brings the same owner back live", () => {
    const { db, starts, owners } = setup()
    starts.set(100, "s1")
    const first = owners.register(input(100, { label: "before" }))
    const pageA = insertPage(db, "alpha")
    const pageB = insertPage(db, "bravo")
    owners.pairPage(pageA, first.owner)
    owners.pairPage(pageB, first.owner)
    const generationB = owners.pairPage(pageB, first.owner)
    owners.end(100, "before", "logout")
    expect(owners.state(first.owner)).toEqual({ status: "gone", reason: "ended" })
    expect(db.query("SELECT gone_reason FROM owners WHERE id = ?").get(first.owner)).toEqual({
      gone_reason: "ended",
    })

    const again = owners.register(input(100, { label: "after", source: "resume" }))

    expect(again.owner).toBe(first.owner)
    expect(again.state).toEqual(live)
    expect(again.process.label).toBe("after")
    expect(again.generation).toBe(generationB)
    expect(db.query("SELECT gone_reason FROM owners WHERE id = ?").get(first.owner)).toEqual({
      gone_reason: null,
    })
    expect(owners.state(first.owner)).toEqual(live)
    expect(owners.liveSessions().map((session) => session.owner)).toEqual([first.owner])
    expect(owners.pagesOf(first.owner)).toEqual([pageA, pageB])
    expect(owners.checkGeneration(pageA, PairingGeneration.parse(1))).toBe(true)
    expect(owners.checkGeneration(pageB, generationB)).toBe(true)
    expect(db.query("SELECT COUNT(*) AS n FROM owners").get()).toEqual({ n: 1 })
  })

  test.each(["claude", "codex", "gemini-cli"])(
    "the agent %s is stored verbatim in the Pairing and the live session",
    (agent) => {
      const { starts, owners } = setup()
      starts.set(100, "s1")
      const pairing = owners.register(input(100, { agent }))
      expect(pairing.agent).toBe(agent)
      expect(owners.liveSessions().map((session) => session.agent)).toEqual([agent])
      expect(owners.pairing(pairing.owner, PairingGeneration.parse(0), "none").agent).toBe(agent)
    },
  )

  test("registering again while the start time stays unreadable relabels the one unknown owner", () => {
    const { db, owners } = setup()
    const first = owners.register(input(100, { label: "before" }))
    const page = insertPage(db, "alpha")
    owners.pairPage(page, first.owner)
    const generation = owners.pairPage(page, first.owner)
    owners.end(100, "before", "clear")

    const again = owners.register(input(100, { label: "after", source: "clear" }))

    expect(again.owner).toBe(first.owner)
    expect(again.state).toEqual(unknown)
    expect(again.process.label).toBe("after")
    expect(again.relabelPending).toBe(false)
    expect(again.generation).toBe(generation)
    expect(owners.pagesOf(first.owner)).toEqual([page])
    expect(owners.checkGeneration(page, generation)).toBe(true)
    expect(db.query("SELECT COUNT(*) AS n FROM owners").get()).toEqual({ n: 1 })
  })

  test("an unreadable-start registration never revives a gone owner: it creates a new one with no pages", () => {
    const { db, owners } = setup()
    const gone = owners.register(input(100, { label: "before" }))
    const page = insertPage(db, "alpha")
    const generation = owners.pairPage(page, gone.owner)
    owners.end(100, "before", "logout")
    const before = db.query("SELECT * FROM owners WHERE id = ?").get(gone.owner)
    expect(owners.state(gone.owner)).toEqual({ status: "gone", reason: "ended" })

    const fresh = owners.register(input(100, { label: "recycled", agent: "codex" }))

    expect(fresh.owner).not.toBe(gone.owner)
    expect(fresh.state).toEqual(unknown)
    expect(fresh.generation).toBe(PairingGeneration.parse(0))
    expect(owners.pagesOf(fresh.owner)).toEqual([])
    expect(db.query("SELECT * FROM owners WHERE id = ?").get(gone.owner)).toEqual(before)
    expect(owners.pagesOf(gone.owner)).toEqual([page])
    expect(owners.checkGeneration(page, generation)).toBe(true)
    expect(db.query("SELECT COUNT(*) AS n FROM owners").get()).toEqual({ n: 2 })
    expect(owners.liveSessions().map((session) => session.owner)).toEqual([fresh.owner])

    const again = owners.register(input(100, { label: "after-clear", source: "clear" }))
    expect(again.owner).toBe(fresh.owner)
    expect(db.query("SELECT COUNT(*) AS n FROM owners").get()).toEqual({ n: 2 })

    owners.end(100, "after-clear", "other")
    const third = owners.register(input(100))
    expect(new Set([gone.owner, fresh.owner, third.owner]).size).toBe(3)
    expect(owners.byPid(100)).toBe(third.owner)
  })

  test("a null start never matches a gone owner with a readable start, nor the reverse", () => {
    const { db, starts, owners } = setup()
    starts.set(100, "s1")
    const readableGone = owners.register(input(100, { label: "one" })).owner
    owners.end(100, "one", "logout")
    starts.delete(100)
    const unreadable = owners.register(input(100, { label: "two" })).owner
    expect(unreadable).not.toBe(readableGone)

    starts.set(100, "s2")
    const next = owners.register(input(100, { label: "three" })).owner
    expect(new Set([readableGone, unreadable, next]).size).toBe(3)
    expect(db.query("SELECT COUNT(*) AS n FROM owners").get()).toEqual({ n: 3 })
    expect(owners.state(readableGone)).toEqual({ status: "gone", reason: "ended" })
  })

  test("a recycled pid with a new start time becomes a different owner", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    const first = owners.register(input(100))
    starts.set(100, "s2")
    const second = owners.register(input(100))
    expect(second.owner).not.toBe(first.owner)
    expect(owners.state(first.owner)).toEqual({ status: "gone", reason: "replaced" })
  })

  test("an unreadable start time still registers, with state unknown", () => {
    const { owners } = setup()
    const pairing = owners.register(input(100))
    expect(pairing.state).toEqual(unknown)
    expect(owners.liveSessions().map((session) => session.state)).toEqual([unknown])
  })

  test("the owner-level generation is the latest among the owner's pages, else 0", () => {
    const { db, starts, owners } = setup()
    starts.set(100, "s1")
    starts.set(200, "t1")
    const owner = owners.register(input(100)).owner
    const other = owners.register(input(200)).owner
    const page = insertPage(db, "alpha")
    owners.pairPage(page, other)
    owners.pairPage(page, other)
    expect(owners.register(input(100)).generation).toBe(PairingGeneration.parse(0))
    owners.pairPage(insertPage(db, "bravo"), owner)
    owners.pairPage(page, owner)
    expect(owners.register(input(100)).generation).toBe(PairingGeneration.parse(3))
    expect(owners.register(input(200)).generation).toBe(PairingGeneration.parse(0))
  })
})

describe("liveness", () => {
  test("a process that died without hook end is gone with reason crashed", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    const ownerId = owners.register(input(100)).owner
    starts.delete(100)
    expect(owners.state(ownerId)).toEqual({ status: "gone", reason: "crashed" })
  })

  test("a process that died while relabel was pending is gone with reason exited", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    const ownerId = owners.register(input(100)).owner
    owners.end(100, "first", "clear")
    starts.delete(100)
    expect(owners.state(ownerId)).toEqual({ status: "gone", reason: "exited" })
  })

  test("a pid alive with a different start time is gone with reason replaced", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    const ownerId = owners.register(input(100)).owner
    starts.set(100, "s2")
    expect(owners.state(ownerId)).toEqual({ status: "gone", reason: "replaced" })
  })

  test("busy and idle toggle the state between busy and live", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    const ownerId = owners.register(input(100)).owner
    owners.setBusy(ownerId, true)
    expect(owners.state(ownerId)).toEqual(busy)
    owners.setBusy(ownerId, false)
    expect(owners.state(ownerId)).toEqual(live)
  })

  test("a stop with running work shows background, a later idle report keeps it, and a stop with none clears it", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    const ownerId = owners.register(input(100)).owner
    owners.setBusy(ownerId, true)
    owners.setStopped(ownerId, { agents: 1, tasks: 2 })
    expect(owners.state(ownerId)).toEqual({ status: "background", agents: 1, tasks: 2 })
    expect(owners.liveSessions()[0]?.state).toEqual({ status: "background", agents: 1, tasks: 2 })
    owners.setBusy(ownerId, false)
    expect(owners.state(ownerId)).toEqual({ status: "background", agents: 1, tasks: 2 })
    owners.setBusy(ownerId, true)
    expect(owners.state(ownerId)).toEqual(busy)
    owners.setStopped(ownerId, { agents: 0, tasks: 1 })
    owners.setStopped(ownerId, { agents: 0, tasks: 0 })
    expect(owners.state(ownerId)).toEqual(live)
  })

  test("background work ends with the session and is not carried into a later registration", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    const ownerId = owners.register(input(100)).owner
    owners.setStopped(ownerId, { agents: 1, tasks: 0 })
    owners.end(100, "first", "logout")
    expect(owners.state(ownerId)).toEqual({ status: "gone", reason: "ended" })
    owners.register(input(100, { label: "second" }))
    expect(owners.state(ownerId)).toEqual(live)
  })

  test("a change in background counts is reported once by the sweep", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    const a = owners.register(input(100)).owner
    owners.sweep()
    owners.setStopped(a, { agents: 1, tasks: 0 })
    expect(owners.sweep()).toEqual([
      { ownerId: a, state: { status: "background", agents: 1, tasks: 0 } },
    ])
    expect(owners.sweep()).toEqual([])
    owners.setStopped(a, { agents: 2, tasks: 0 })
    expect(owners.sweep()).toEqual([
      { ownerId: a, state: { status: "background", agents: 2, tasks: 0 } },
    ])
  })

  test("a real child process is live while running and crashed once killed", async () => {
    const db = openStore(":memory:")
    stores.push(db)
    const owners = createOwners(db, { processStart: readProcessStart, now: () => new Date() })
    const child = Bun.spawn(["sleep", "30"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    children.push(child)
    const ownerId = owners.register(input(child.pid)).owner
    expect(owners.state(ownerId)).toEqual(live)
    expect(owners.byPid(child.pid)).toBe(ownerId)

    child.kill()
    await child.exited

    expect(owners.state(ownerId)).toEqual({ status: "gone", reason: "crashed" })
    expect(owners.liveSessions()).toEqual([])
  })
})

describe("end", () => {
  test.each(["clear", "resume"] as const)(
    "reason %s sets relabel pending and keeps the owner not gone",
    (reason) => {
      const { starts, owners } = setup()
      starts.set(100, "s1")
      const ownerId = owners.register(input(100)).owner
      const pairing = owners.end(100, "first", reason)
      expect(pairing).toMatchObject({ owner: ownerId, relabelPending: true, state: live })
      expect(owners.liveSessions().map((session) => session.owner)).toEqual([ownerId])
    },
  )

  test.each(["logout", "prompt_input_exit", "other"] as const)(
    "reason %s reports the owner gone with reason ended",
    (reason) => {
      const { starts, owners } = setup()
      starts.set(100, "s1")
      const ownerId = owners.register(input(100)).owner
      expect(owners.end(100, "first", reason)?.state).toEqual({ status: "gone", reason: "ended" })
      expect(owners.state(ownerId)).toEqual({ status: "gone", reason: "ended" })
      expect(owners.liveSessions()).toEqual([])
    },
  )

  test("an unregistered pid gives null", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    expect(owners.end(100, "first", "other")).toBeNull()
  })

  test("an end naming a superseded label changes nothing", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    owners.register(input(100, { label: "old" }))
    owners.register(input(100, { label: "new", source: "clear" }))
    const pairing = owners.end(100, "old", "clear")
    expect(pairing).toMatchObject({ relabelPending: false, state: live })
    expect(owners.end(100, "old", "logout")?.state).toEqual(live)
  })
})

describe("resolve", () => {
  test("ancestry without an explicit owner resolves the nearest registered ancestor", () => {
    const { starts, owners } = setup()
    starts.set(300, "agent-start")
    starts.set(200, "shell-start")
    const agent = owners.register(input(300)).owner
    const shell = owners.register(input(200)).owner
    const ancestry = [
      { pid: 400, startedAt: "cli-start" },
      { pid: 200, startedAt: "shell-start" },
      { pid: 300, startedAt: "agent-start" },
    ]
    expect(owners.resolve(ancestry, null)).toBe(shell)
    expect(owners.resolve(ancestry.slice(2), null)).toBe(agent)
  })

  test("an ancestor with a matching pid but another start time is not an owner", () => {
    const { starts, owners } = setup()
    starts.set(200, "s1")
    owners.register(input(200))
    expect(owners.resolve([{ pid: 200, startedAt: "s2" }], null)).toBeNull()
  })

  test("an explicit owner overrides ancestry and must exist", () => {
    const { starts, owners } = setup()
    starts.set(200, "s1")
    starts.set(300, "s1")
    const near = owners.register(input(200)).owner
    const far = owners.register(input(300)).owner
    expect(owners.resolve([{ pid: 200, startedAt: "s1" }], far)).toBe(far)
    expect(owners.resolve([{ pid: 200, startedAt: "s1" }], OwnerId.parse("o_missing"))).toBeNull()
    expect(owners.resolve([], null)).toBeNull()
    expect(near).not.toBe(far)
  })
})

describe("byPid", () => {
  test("finds the owner registered for the pid's current start time", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    const first = owners.register(input(100)).owner
    expect(owners.byPid(100)).toBe(first)
    starts.set(100, "s2")
    expect(owners.byPid(100)).toBeNull()
    expect(owners.byPid(999)).toBeNull()
  })
})

describe("page generations", () => {
  test("every re-pair returns a generation greater than every earlier one", () => {
    const { db, starts, owners } = setup()
    starts.set(100, "s1")
    starts.set(200, "t1")
    const a = owners.register(input(100)).owner
    const b = owners.register(input(200)).owner
    const page = insertPage(db, "alpha")
    const seen = [owners.pairPage(page, a), owners.pairPage(page, b), owners.pairPage(page, a)]
    expect(seen).toEqual([1, 2, 3].map((n) => PairingGeneration.parse(n)))
    expect(owners.pagesOf(a)).toEqual([page])
    expect(owners.pagesOf(b)).toEqual([])
  })

  test("checkGeneration refuses an unknown page", () => {
    const { owners } = setup()
    expect(owners.checkGeneration(PageId.parse("nowhere"), PairingGeneration.parse(0))).toBe(false)
  })

  test("an unpaired page is at generation 0, and only 0 is current", () => {
    const { db, owners } = setup()
    const page = insertPage(db, "alpha")
    expect(owners.checkGeneration(page, PairingGeneration.parse(0))).toBe(true)
    for (const other of [1, 2, 1000]) {
      expect(owners.checkGeneration(page, PairingGeneration.parse(other))).toBe(false)
    }
  })

  test("a large stored generation is current, and its neighbours and any other value are refused", () => {
    const { db, owners } = setup()
    const page = insertPage(db, "alpha")
    for (const stored of [255, 65_536, 2 ** 31, 2 ** 32 + 1, Number.MAX_SAFE_INTEGER - 1]) {
      db.query("UPDATE pages SET generation = ? WHERE id = ?").run(stored, page)
      expect(owners.checkGeneration(page, PairingGeneration.parse(stored))).toBe(true)
      for (const other of [0, 1, stored - 1, stored + 1, stored * 2, stored % 2 ** 32]) {
        if (other === stored || !Number.isSafeInteger(other)) continue
        expect(owners.checkGeneration(page, PairingGeneration.parse(other))).toBe(false)
      }
    }
  })

  test("pairing to an owner that does not exist throws and leaves the page's owner and generation as they were", () => {
    const { db, starts, owners } = setup()
    starts.set(100, "s1")
    const owner = owners.register(input(100)).owner
    const page = insertPage(db, "alpha")
    const generation = owners.pairPage(page, owner)

    expect(() => owners.pairPage(page, OwnerId.parse("o_missing"))).toThrow()

    expect(owners.pagesOf(owner)).toEqual([page])
    expect(owners.checkGeneration(page, generation)).toBe(true)
    expect(db.query("SELECT owner_id, generation FROM pages WHERE id = ?").get(page)).toEqual({
      owner_id: owner,
      generation,
    })
  })

  test("a stale pairing generation is always refused", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 2 }), { minLength: 1, maxLength: 12 }),
        fc.nat({ max: 20 }),
        (ownerPicks, probe) => {
          const { db, starts, owners } = setup()
          const ownerIds = [100, 200, 300].map((pid) => {
            starts.set(pid, `s${pid}`)
            return owners.register(input(pid)).owner
          })
          const page = insertPage(db, "alpha")
          let last = PairingGeneration.parse(0)
          for (const pick of ownerPicks) {
            const ownerId = ownerIds[pick]
            if (!ownerId) throw new Error("owner pick out of range")
            const next = owners.pairPage(page, ownerId)
            expect(next).toBeGreaterThan(last)
            last = next
          }
          const generation = PairingGeneration.parse(probe)
          expect(owners.checkGeneration(page, generation)).toBe(generation === last)
          expect(owners.checkGeneration(page, last)).toBe(true)
        },
      ),
    )
  })
})

describe("sweep", () => {
  test("returns only owners whose state changed since the previous sweep", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    starts.set(200, "t1")
    const a = owners.register(input(100)).owner
    const b = owners.register(input(200)).owner

    expect(owners.sweep()).toEqual([
      { ownerId: a, state: live },
      { ownerId: b, state: live },
    ])
    expect(owners.sweep()).toEqual([])

    owners.setBusy(b, true)
    expect(owners.sweep()).toEqual([{ ownerId: b, state: busy }])

    starts.delete(100)
    expect(owners.sweep()).toEqual([{ ownerId: a, state: { status: "gone", reason: "crashed" } }])
    expect(owners.sweep()).toEqual([])
  })

  test("reports an owner that went gone before any sweep, and one gone through another read", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    starts.set(200, "t1")
    const a = owners.register(input(100)).owner
    const b = owners.register(input(200)).owner
    owners.end(100, "first", "logout")
    expect(owners.sweep()).toEqual([
      { ownerId: a, state: { status: "gone", reason: "ended" } },
      { ownerId: b, state: live },
    ])

    starts.delete(200)
    expect(owners.liveSessions()).toEqual([])
    expect(owners.sweep()).toEqual([{ ownerId: b, state: { status: "gone", reason: "crashed" } }])
  })

  test("busy, then live again, then unchanged: each change is reported once", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    const a = owners.register(input(100)).owner
    expect(owners.sweep()).toEqual([{ ownerId: a, state: live }])
    owners.setBusy(a, true)
    expect(owners.sweep()).toEqual([{ ownerId: a, state: busy }])
    expect(owners.sweep()).toEqual([])
    owners.setBusy(a, false)
    expect(owners.sweep()).toEqual([{ ownerId: a, state: live }])
    expect(owners.sweep()).toEqual([])
  })

  test("an unknown state is reported once and then suppressed", () => {
    const { owners } = setup()
    const a = owners.register(input(100)).owner
    expect(owners.sweep()).toEqual([{ ownerId: a, state: unknown }])
    expect(owners.sweep()).toEqual([])
    expect(owners.sweep()).toEqual([])
  })

  test("a label change, a pending relabel and a busy-then-idle blip between sweeps report nothing", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    owners.register(input(100, { label: "one" }))
    owners.sweep()

    owners.end(100, "one", "clear")
    expect(owners.sweep()).toEqual([])
    owners.register(input(100, { label: "two", source: "clear" }))
    expect(owners.sweep()).toEqual([])

    const a = owners.byPid(100)
    if (!a) throw new Error("owner missing")
    owners.setBusy(a, true)
    owners.setBusy(a, false)
    expect(owners.sweep()).toEqual([])
  })

  test("an owner swept as gone and then registered again is reported live, once", () => {
    const { starts, owners } = setup()
    starts.set(100, "s1")
    const a = owners.register(input(100, { label: "one" })).owner
    owners.sweep()
    owners.end(100, "one", "logout")
    expect(owners.sweep()).toEqual([{ ownerId: a, state: { status: "gone", reason: "ended" } }])
    expect(owners.sweep()).toEqual([])

    owners.register(input(100, { label: "two", source: "resume" }))
    expect(owners.sweep()).toEqual([{ ownerId: a, state: live }])
    expect(owners.sweep()).toEqual([])
  })

  test("owners already gone when the store opens are not reported again", () => {
    const { db, starts, owners } = setup()
    starts.set(100, "s1")
    owners.register(input(100))
    owners.end(100, "first", "other")
    const reopened = createOwners(db, {
      processStart: (pid) => starts.get(pid) ?? null,
      now: () => new Date(),
    })
    expect(reopened.sweep()).toEqual([])
  })
})
