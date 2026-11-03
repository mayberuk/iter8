# Testing

The user is not the QA. Every behaviour a part ships is proven by a test the gate runs, against the
real thing wherever the real thing is cheap enough to start. `.claude/docs/TESTING.md` has the
commands.

## Three layers, each with one job
- **Unit** (`*.test.ts` beside the code, `bun test`): pure functions, schemas, state
  transitions. No I/O.
- **Integration** (`*.test.ts` beside the code): one real boundary in-process — a chained Hono
  router through `app.request`, the proxy against a throwaway `Bun.serve` upstream, `bun:sqlite`
  on a fresh temp file, a real child process.
- **Scenario** (`harness/scenarios/<part>/*.test.ts`, `bun test`): the real service on a
  throwaway state dir and ports, a real fixture app, headless Chromium through Playwright, and the
  stub agent session from `harness/stubs/` standing in for Claude Code. A user-visible behaviour
  is done when a scenario drives it the way the user would and asserts what they would see.

## Always
- Inject the boundary a unit test needs to fake (`fetch`, `spawn`, the clock, the state dir); the
  fake returns canned values, never a real network call or a real model turn.
- Define every Hono router with chained methods on the instance (`app.get().post()...`) — an
  unchained router silently loses `hc`/`testClient` type inference.
- Encode every invariant the design states as a named `fast-check` property: a round only moves
  forward through its states; a stale pairing generation is always refused; a note's authored text
  and its captured page data never mix; a re-anchored pin either resolves to one element or is
  marked moved.
- Take ports, state dirs and browser contexts from the rig (`harness/rig`), which derives them
  from the test worker so scenario files run in parallel without colliding.
- Wait for a condition (`waitFor` in the rig) with a stated timeout; never sleep for time.
- Remove every temp dir and stop every process a test started, in the test or the rig helper that
  created it (`scratchDir` returns a disposer). `file-safety.md`'s "leave scratch in place" is for
  an agent's own shell work, not for test code: one day of leaked test scratch filled a 16 GB `/tmp`.
- Prove the overlay's budgets with the rig's long-task and frame probes, run together: no
  main-thread task over 50 ms at normal speed while hovering, picking and typing on the heavy
  fixture with enrichment running, and the page-relative bounds at the calibrated 4× throttle
  (`.claude/docs/TESTING.md` lists them).
- Start the cheapest fixture that proves the behaviour: the static folder or the Vite + React
  app. Next, SvelteKit, Vue and Astro run only where the framework is the thing under test
  (source lookup, proxy compatibility, the end-to-end matrix).
- State a Testing Strategy in each part's spec naming, per phase, its unit, integration and
  scenario tests and the exact command that proves each.

## Never
- A test that runs a real `claude` turn, touches `~/.iter8`, or binds a fixed port. A real
  `claude` smoke is opt-in, outside the gate.
- A test that passes whether the code is right or wrong: derive the expected value from the
  requirement, not from running the new code.
- An example-only test for something the design states as an invariant.
- Mocking the unit under test, or a DOM emulator standing in for the browser where layout,
  shadow DOM, focus or timing is what the test is about.
