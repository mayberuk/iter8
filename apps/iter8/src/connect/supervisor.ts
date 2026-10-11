export const BACKOFF_FIRST_MS = 1_000 // A brief outage should recover without a long initial wait.
export const BACKOFF_CAP_MS = 30_000 // 30 s matches the SSH ServerAlive budget.
export const HEALTHY_RESET_MS = 60_000 // A full minute up distinguishes recovery from a flapping link.
export const TICK_MS = 2_000 // Check often enough to reconnect promptly after sleep.
export const WAKE_GAP_MS = 10_000 // A 10 s gap is far beyond any timer delay under load.

export type Clock = {
  now(): number
  setTimeout(run: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

export type AttemptEnd =
  | { retry: "backoff"; reason: string }
  | { retry: "after"; ms: number; reason: string }
  | { retry: "never"; reason: string }

export type Attempt = {
  ready: Promise<void>
  ended: Promise<AttemptEnd>
  stop(): void
}

export type SupervisorEvent =
  | { kind: "connecting"; attempt: number }
  | { kind: "up" }
  | { kind: "down"; reason: string; retryInMs: number }
  | { kind: "woke" }
  | { kind: "gave-up"; reason: string }

type ActiveState = { attempt: number; failures: number; previousTick: number }

export type TunnelState =
  | (ActiveState & { kind: "connecting" })
  | (ActiveState & { kind: "up"; upSince: number })
  | (ActiveState & {
      kind: "waiting"
      end: AttemptEnd
      retryInMs: number
    })
  | { kind: "stopped" }
  | { kind: "gave-up"; end: AttemptEnd }

export type TunnelInput =
  | { kind: "ready"; now: number }
  | { kind: "ended"; end: AttemptEnd; now: number }
  | { kind: "tick"; now: number }
  | { kind: "timer-fired"; now: number }
  | { kind: "stop" }

export function transition(state: TunnelState, input: TunnelInput): TunnelState {
  if (state.kind === "stopped" || state.kind === "gave-up") return state
  if (input.kind === "stop") return { kind: "stopped" }
  const { attempt, failures, previousTick } = state
  switch (input.kind) {
    case "ready":
      return state.kind === "connecting" ? { ...state, kind: "up", upSince: input.now } : state
    case "ended": {
      if (state.kind === "waiting") return state
      if (input.end.retry === "never") return { kind: "gave-up", end: input.end }
      const consecutiveFailures =
        state.kind === "up" && input.now - state.upSince >= HEALTHY_RESET_MS ? 0 : failures
      const retryInMs =
        input.end.retry === "after"
          ? input.end.ms
          : Math.min(BACKOFF_FIRST_MS * 2 ** consecutiveFailures, BACKOFF_CAP_MS)
      return {
        kind: "waiting",
        attempt,
        failures: consecutiveFailures + (input.end.retry === "backoff" ? 1 : 0),
        previousTick,
        end: input.end,
        retryInMs,
      }
    }
    case "tick":
      return input.now - previousTick > TICK_MS + WAKE_GAP_MS
        ? { kind: "connecting", attempt: attempt + 1, failures, previousTick: input.now }
        : { ...state, previousTick: input.now }
    case "timer-fired":
      return state.kind === "waiting"
        ? { kind: "connecting", attempt: attempt + 1, failures, previousTick }
        : state
  }
}

export function superviseTunnel(options: {
  attempt: () => Attempt
  clock: Clock
  report: (event: SupervisorEvent) => void
}): { stop(): Promise<void>; finished: Promise<AttemptEnd | null> } {
  const { clock, report } = options
  let state: TunnelState = {
    kind: "connecting",
    attempt: 1,
    failures: 0,
    previousTick: clock.now(),
  }
  let current: Attempt | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let tickTimer: ReturnType<typeof setTimeout> | undefined
  let finish: (end: AttemptEnd | null) => void = () => {}
  const finished = new Promise<AttemptEnd | null>((resolve) => {
    finish = resolve
  })

  function clearRetry(): void {
    if (retryTimer !== undefined) clock.clearTimeout(retryTimer)
    retryTimer = undefined
  }

  function stopCurrent(): void {
    const previous = current
    current = undefined
    previous?.stop()
  }

  function startAttempt(): void {
    if (state.kind !== "connecting") return
    const attempt = options.attempt()
    current = attempt
    report({ kind: "connecting", attempt: state.attempt })
    void attempt.ready.then(
      () => {
        if (current === attempt) apply({ kind: "ready", now: clock.now() })
      },
      () => {},
    )
    void attempt.ended.then((end) => {
      if (current !== attempt) return
      current = undefined
      apply({ kind: "ended", end, now: clock.now() })
    })
  }

  function apply(input: TunnelInput): void {
    const previous = state
    state = transition(state, input)
    if (state === previous) return
    switch (state.kind) {
      case "stopped":
      case "gave-up": {
        clearRetry()
        if (tickTimer !== undefined) clock.clearTimeout(tickTimer)
        tickTimer = undefined
        stopCurrent()
        if (state.kind === "gave-up") {
          report({ kind: "gave-up", reason: state.end.reason })
          finish(state.end)
        } else {
          finish(null)
        }
        break
      }
      case "connecting":
        if (previous.kind === "connecting" && previous.attempt === state.attempt) break
        if (input.kind === "tick") report({ kind: "woke" })
        clearRetry()
        stopCurrent()
        startAttempt()
        break
      case "up":
        if (input.kind === "ready") report({ kind: "up" })
        break
      case "waiting":
        if (input.kind === "ended") {
          const waiting = state
          report({ kind: "down", reason: waiting.end.reason, retryInMs: waiting.retryInMs })
          if (state !== waiting) return
          retryTimer = clock.setTimeout(() => {
            retryTimer = undefined
            apply({ kind: "timer-fired", now: clock.now() })
          }, waiting.retryInMs)
        }
        break
    }
  }

  function armTick(): void {
    if (state.kind === "stopped" || state.kind === "gave-up") return
    tickTimer = clock.setTimeout(() => {
      tickTimer = undefined
      apply({ kind: "tick", now: clock.now() })
      armTick()
    }, TICK_MS)
  }

  startAttempt()
  armTick()

  return {
    async stop() {
      apply({ kind: "stop" })
      await finished
    },
    finished,
  }
}
