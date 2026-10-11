import { expect, test } from "bun:test"
import fc from "fast-check"
import {
  type Attempt,
  type AttemptEnd,
  BACKOFF_CAP_MS,
  BACKOFF_FIRST_MS,
  type Clock,
  HEALTHY_RESET_MS,
  type SupervisorEvent,
  superviseTunnel,
  TICK_MS,
  type TunnelInput,
  type TunnelState,
  transition,
  WAKE_GAP_MS,
} from "./supervisor"

type TimerHandle = ReturnType<typeof setTimeout>

class FakeClock implements Clock {
  private time = 0
  private wallOffset = 0
  private nextHandle = 0
  private timers = new Map<TimerHandle, { at: number; run: () => void }>()

  now(): number {
    return this.time + this.wallOffset
  }

  adjustWall(ms: number): void {
    this.wallOffset += ms
  }

  setTimeout(run: () => void, ms: number): TimerHandle {
    const handle = ++this.nextHandle as unknown as TimerHandle
    this.timers.set(handle, { at: this.time + ms, run })
    return handle
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle)
  }

  get pending(): number {
    return this.timers.size
  }

  async advance(ms: number, asleep = false): Promise<void> {
    const target = this.time + ms
    if (asleep) this.time = target
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      const [handle, timer] = next
      this.time = Math.max(this.time, timer.at)
      this.timers.delete(handle)
      timer.run()
      await Promise.resolve()
    }
    this.time = target
    await Promise.resolve()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class FakeAttempt implements Attempt {
  private readiness = deferred<void>()
  private ending = deferred<AttemptEnd>()
  ready = this.readiness.promise
  ended = this.ending.promise
  live = true
  stops = 0

  stop(): void {
    this.stops += 1
    this.live = false
  }

  async markReady(): Promise<void> {
    this.readiness.resolve()
    await this.ready
  }

  async rejectReady(): Promise<void> {
    this.readiness.reject(new Error("not connected"))
    await Promise.resolve()
  }

  async end(end: AttemptEnd): Promise<void> {
    this.live = false
    this.ending.resolve(end)
    await this.ended
  }
}

function setup() {
  const clock = new FakeClock()
  const attempts: FakeAttempt[] = []
  const starts: number[] = []
  const events: SupervisorEvent[] = []
  const supervisor = superviseTunnel({
    clock,
    attempt() {
      expect(attempts.filter((attempt) => attempt.live)).toHaveLength(0)
      const attempt = new FakeAttempt()
      attempts.push(attempt)
      starts.push(clock.now())
      return attempt
    },
    report: (event) => events.push(event),
  })
  return {
    clock,
    attempts,
    starts,
    events,
    supervisor,
    current() {
      const attempt = attempts.at(-1)
      if (!attempt) throw new Error("no attempt started")
      return attempt
    },
  }
}

const lost: AttemptEnd = { retry: "backoff", reason: "connection lost" }

test("the constants match the reconnect and sleep budgets", () => {
  expect(BACKOFF_FIRST_MS).toBe(1_000)
  expect(BACKOFF_CAP_MS).toBe(30_000)
  expect(HEALTHY_RESET_MS).toBe(60_000)
  expect(TICK_MS).toBe(2_000)
  expect(WAKE_GAP_MS).toBe(10_000)
})

test("failures wait 1, 2, 4, 8, 16, 30, 30 seconds", async () => {
  const rig = setup()
  try {
    expect(rig.events).toEqual([{ kind: "connecting", attempt: 1 }])
    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].entries()) {
      await rig.current().end(lost)
      expect(rig.events.at(-1)).toEqual({
        kind: "down",
        reason: "connection lost",
        retryInMs: delay,
      })
      const endedAt = rig.clock.now()
      await rig.clock.advance(delay - 1)
      expect(rig.attempts).toHaveLength(index + 1)
      await rig.clock.advance(1)
      expect(rig.attempts).toHaveLength(index + 2)
      expect(rig.starts.at(-1)).toBe(endedAt + delay)
      expect(rig.events.at(-1)).toEqual({ kind: "connecting", attempt: index + 2 })
    }
    expect(rig.events.some((event) => event.kind === "woke")).toBe(false)
  } finally {
    await rig.supervisor.stop()
  }
})

test("backoff resets after 60 seconds up, including the exact boundary", async () => {
  for (const [upFor, delay] of [
    [59_999, 4_000],
    [60_000, 1_000],
    [60_001, 1_000],
  ]) {
    if (upFor === undefined || delay === undefined) throw new Error("missing test timing")
    const rig = setup()
    try {
      await rig.current().end(lost)
      await rig.clock.advance(1_000)
      await rig.current().end(lost)
      await rig.clock.advance(2_000)
      await rig.current().markReady()
      expect(rig.events.at(-1)).toEqual({ kind: "up" })
      await rig.clock.advance(upFor)
      await rig.current().end(lost)
      expect(rig.events.at(-1)).toEqual({
        kind: "down",
        reason: "connection lost",
        retryInMs: delay,
      })
    } finally {
      await rig.supervisor.stop()
    }
  }
})

test("after a reset, consecutive failures wait 1, 2 then 4 seconds", async () => {
  const rig = setup()
  try {
    await rig.current().end(lost)
    await rig.clock.advance(1_000)
    await rig.current().end(lost)
    await rig.clock.advance(2_000)
    await rig.current().markReady()
    await rig.clock.advance(HEALTHY_RESET_MS)
    for (const delay of [1_000, 2_000, 4_000]) {
      await rig.current().end(lost)
      expect(rig.events.at(-1)).toEqual({
        kind: "down",
        reason: "connection lost",
        retryInMs: delay,
      })
      await rig.clock.advance(delay)
    }
  } finally {
    await rig.supervisor.stop()
  }
})

test("time spent connecting does not count as healthy uptime", async () => {
  const rig = setup()
  try {
    await rig.current().end(lost)
    await rig.clock.advance(1_000)
    await rig.clock.advance(60_000)
    await rig.current().markReady()
    await rig.clock.advance(59_999)
    await rig.current().end(lost)
    expect(rig.events.at(-1)).toEqual({
      kind: "down",
      reason: "connection lost",
      retryInMs: 2_000,
    })
  } finally {
    await rig.supervisor.stop()
  }
})

test("a never end gives up and resolves finished with that end", async () => {
  const rig = setup()
  const end: AttemptEnd = { retry: "never", reason: "authentication refused" }
  await rig.current().end(end)
  expect(await rig.supervisor.finished).toEqual(end)
  expect(rig.events).toEqual([
    { kind: "connecting", attempt: 1 },
    { kind: "gave-up", reason: "authentication refused" },
  ])
  expect(rig.clock.pending).toBe(0)
  await rig.clock.advance(1_000_000, true)
  await rig.current().markReady()
  expect(rig.attempts).toHaveLength(1)
  await rig.supervisor.stop()
  expect(await rig.supervisor.finished).toEqual(end)
})

test("an after delay is used verbatim, including zero and values beyond the backoff cap", async () => {
  for (const delay of [0, 3_000, 45_123]) {
    const rig = setup()
    try {
      await rig.current().end({ retry: "after", ms: delay, reason: "service not running" })
      expect(rig.events.at(-1)).toEqual({
        kind: "down",
        reason: "service not running",
        retryInMs: delay,
      })
      if (delay > 0) {
        await rig.clock.advance(delay - 1)
        expect(rig.attempts).toHaveLength(1)
        await rig.clock.advance(1)
      } else {
        await rig.clock.advance(0)
      }
      expect(rig.starts).toEqual([0, delay])
      await rig.current().end(lost)
      expect(rig.events.at(-1)).toHaveProperty("retryInMs", 1_000)
    } finally {
      await rig.supervisor.stop()
    }
  }
})

test("ticks while connecting do not start additional attempts", async () => {
  const rig = setup()
  try {
    await rig.clock.advance(60_000)
    expect(rig.attempts).toHaveLength(1)
    expect(rig.events).toEqual([{ kind: "connecting", attempt: 1 }])
  } finally {
    await rig.supervisor.stop()
  }
})

test("a backward wall-clock adjustment cannot discard a fired retry timer", async () => {
  const rig = setup()
  try {
    await rig.current().end(lost)
    rig.clock.adjustWall(-5_000)
    await rig.clock.advance(1_000)
    expect(rig.starts).toEqual([0, -4_000])
    expect(rig.events.at(-1)).toEqual({ kind: "connecting", attempt: 2 })
    await rig.clock.advance(2_000)
    expect(rig.attempts).toHaveLength(2)
  } finally {
    await rig.supervisor.stop()
  }
})

test("wake detection requires a gap strictly greater than 12 seconds and re-arms its tick", async () => {
  const rig = setup()
  try {
    await rig.clock.advance(12_000, true)
    expect(rig.attempts).toHaveLength(1)
    await rig.clock.advance(12_001, true)
    expect(rig.current().live).toBe(true)
    expect(rig.attempts).toHaveLength(2)
    await rig.clock.advance(12_001, true)
    expect(rig.attempts).toHaveLength(3)
    expect(rig.events.filter((event) => event.kind === "woke")).toHaveLength(2)
  } finally {
    await rig.supervisor.stop()
  }
})

test("a wake cancels a pending retry and ignores callbacks from the old attempt", async () => {
  const rig = setup()
  try {
    const first = rig.current()
    await first.end({ retry: "after", ms: 30_000, reason: "port occupied" })
    expect(rig.clock.pending).toBe(2)
    await rig.clock.advance(12_001, true)
    expect(rig.starts).toEqual([0, 12_001])
    expect(rig.clock.pending).toBe(1)
    await first.markReady()
    expect(rig.events.at(-1)).toEqual({ kind: "connecting", attempt: 2 })
    await rig.clock.advance(30_000)
    expect(rig.attempts).toHaveLength(2)
  } finally {
    await rig.supervisor.stop()
  }
})

test("late ready and never callbacks from a stopped attempt cannot affect its replacement", async () => {
  const rig = setup()
  try {
    const first = rig.current()
    await rig.clock.advance(12_001, true)
    expect(first.stops).toBe(1)
    const events = [...rig.events]
    await first.markReady()
    await first.end({ retry: "never", reason: "stopped child" })
    expect(rig.events).toEqual(events)
    await rig.current().markReady()
    expect(rig.events.at(-1)).toEqual({ kind: "up" })
  } finally {
    await rig.supervisor.stop()
  }
})

test("a rejected ready promise leaves retry handling to ended", async () => {
  const rig = setup()
  try {
    await rig.current().rejectReady()
    await rig.current().end(lost)
    expect(rig.events.at(-1)).toHaveProperty("retryInMs", 1_000)
    await rig.clock.advance(1_000)
    expect(rig.attempts).toHaveLength(2)
  } finally {
    await rig.supervisor.stop()
  }
})

test("stop resolves finished with null, stops the live attempt once, and clears all timers", async () => {
  const rig = setup()
  await rig.current().markReady()
  await Promise.all([rig.supervisor.stop(), rig.supervisor.stop()])
  expect(await rig.supervisor.finished).toBeNull()
  expect(rig.current().stops).toBe(1)
  expect(rig.clock.pending).toBe(0)
  const events = [...rig.events]
  await rig.current().end(lost)
  await rig.clock.advance(1_000_000, true)
  expect(rig.attempts).toHaveLength(1)
  expect(rig.events).toEqual(events)
})

test("stop while waiting clears both the retry timer and the tick", async () => {
  const rig = setup()
  await rig.current().end(lost)
  expect(rig.clock.pending).toBe(2)
  await rig.supervisor.stop()
  expect(await rig.supervisor.finished).toBeNull()
  expect(rig.clock.pending).toBe(0)
  await rig.clock.advance(1_000_000, true)
  expect(rig.attempts).toHaveLength(1)
})

test("transition preserves terminal states and ignores inputs that do not apply", () => {
  const connecting: TunnelState = {
    kind: "connecting",
    attempt: 1,
    failures: 0,
    previousTick: 0,
  }
  const up = transition(connecting, { kind: "ready", now: 100 })
  expect(up).toEqual({ ...connecting, kind: "up", upSince: 100 })
  expect(connecting.kind).toBe("connecting")
  expect(transition(up, { kind: "ready", now: 200 })).toBe(up)
  expect(transition(connecting, { kind: "timer-fired", now: 100 })).toBe(connecting)
  const waiting = transition(up, { kind: "ended", end: lost, now: 200 })
  expect(waiting).toEqual({
    kind: "waiting",
    attempt: 1,
    failures: 1,
    previousTick: 0,
    end: lost,
    retryInMs: 1_000,
  })
  expect(transition(waiting, { kind: "ready", now: 300 })).toBe(waiting)
  expect(transition(waiting, { kind: "ended", end: lost, now: 300 })).toBe(waiting)
  expect(transition(waiting, { kind: "timer-fired", now: 1_200 })).toEqual({
    kind: "connecting",
    attempt: 2,
    failures: 1,
    previousTick: 0,
  })
  const inputs: TunnelInput[] = [
    { kind: "ready", now: 10_000 },
    { kind: "ended", end: lost, now: 10_000 },
    { kind: "tick", now: 100_000 },
    { kind: "timer-fired", now: 100_000 },
    { kind: "stop" },
  ]
  for (const terminal of [
    transition(connecting, { kind: "stop" }),
    transition(up, { kind: "ended", end: { retry: "never", reason: "invalid host" }, now: 200 }),
  ]) {
    for (const input of inputs) expect(transition(terminal, input)).toBe(terminal)
  }
})

test("backoff delays never decrease between consecutive failures and never exceed the cap", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 40 }), async (failures) => {
      const rig = setup()
      let previousDelay = 0
      try {
        for (let index = 0; index < failures; index += 1) {
          await rig.current().end(lost)
          const down = rig.events.at(-1)
          if (down?.kind !== "down") throw new Error("missing retry event")
          expect(down.retryInMs).toBeGreaterThanOrEqual(previousDelay)
          expect(down.retryInMs).toBeLessThanOrEqual(30_000)
          expect(down.retryInMs).toBeGreaterThanOrEqual(1_000)
          previousDelay = down.retryInMs
          await rig.clock.advance(down.retryInMs)
        }
      } finally {
        await rig.supervisor.stop()
      }
    }),
  )
})

test("a wake always starts the next attempt with no delay", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("connecting", "up", "waiting"),
      fc.integer({ min: 12_001, max: 120_000 }),
      async (stage, gap) => {
        const rig = setup()
        try {
          const first = rig.current()
          if (stage === "up") await first.markReady()
          if (stage === "waiting") {
            await first.end({ retry: "after", ms: 300_000, reason: "port occupied" })
          }
          await rig.clock.advance(gap, true)
          expect(rig.starts).toEqual([0, gap])
          expect(rig.events.slice(-2)).toEqual([
            { kind: "woke" },
            { kind: "connecting", attempt: 2 },
          ])
          expect(first.live).toBe(false)
          expect(first.stops).toBe(stage === "waiting" ? 0 : 1)
          expect(rig.clock.pending).toBe(1)
        } finally {
          await rig.supervisor.stop()
        }
      },
    ),
  )
})

const operation = fc.record({
  kind: fc.constantFrom("ready", "backoff", "after", "never", "advance", "wake", "stop"),
  ms: fc.integer({ min: 0, max: 65_000 }),
})

type Operation = { kind: string; ms: number }

async function operate(rig: ReturnType<typeof setup>, action: Operation): Promise<void> {
  switch (action.kind) {
    case "ready":
      await rig.current().markReady()
      break
    case "backoff":
      await rig.current().end(lost)
      break
    case "after":
      await rig.current().end({ retry: "after", ms: action.ms, reason: "service not running" })
      break
    case "never":
      await rig.current().end({ retry: "never", reason: "authentication refused" })
      break
    case "advance":
      await rig.clock.advance(action.ms)
      break
    case "wake":
      await rig.clock.advance(12_001 + action.ms, true)
      break
    case "stop":
      await rig.supervisor.stop()
      break
  }
}

test("at most one attempt is live at any time", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 60 }), async (operations) => {
      const rig = setup()
      try {
        for (const action of operations) {
          await operate(rig, action)
          expect(rig.attempts.filter((attempt) => attempt.live).length).toBeLessThanOrEqual(1)
        }
      } finally {
        await rig.supervisor.stop()
      }
      expect(rig.clock.pending).toBe(0)
    }),
  )
})

test("after stop no attempt is ever started", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(operation, { maxLength: 20 }),
      fc.array(operation, { minLength: 1, maxLength: 60 }),
      async (beforeStop, afterStop) => {
        const rig = setup()
        try {
          for (const action of beforeStop) await operate(rig, action)
          await rig.supervisor.stop()
          const count = rig.attempts.length
          const events = [...rig.events]
          for (const action of afterStop) {
            await operate(rig, action)
            expect(rig.attempts).toHaveLength(count)
            expect(rig.clock.pending).toBe(0)
            expect(rig.events).toEqual(events)
          }
        } finally {
          await rig.supervisor.stop()
        }
      },
    ),
  )
})
