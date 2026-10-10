# Testing — iter8

How tests are written and judged here is `.claude/rules/testing.md`; this file holds the commands,
the harness inventory and the policy dp reads.

## Setup
- Bun 1.4.2 and Node 22.12+ (the fixture apps' dev servers run under Node).
- `bun install --frozen-lockfile`, then `bun run setup:browsers` for the pinned Playwright Chromium.
- `bun run build` before any scenario that needs the built binary (`dist/iter8`) or the bundles
  (`dist/overlay/`).

## Test Commands
- Precheck: `bun run typecheck && bun run lint`
- Unit: `bun run knip && bun run depcruise && bun test packages scripts`
- Gate: `bun run build && bun run check` — the e2e scenarios launch `dist/iter8`, so the gate rebuilds it first
- Scoped: `bun test <path>` — always name the paths; a bare `bun test` is not the gate.

## Harness Inventory
Import each module by path; there are no barrels.
- `harness/rig/ports.ts` — `WORKER`, `portBlock(worker)`: each `bun test` worker owns 100 ports from
  `21000 + 100 × (worker − 1)`. `nextPort()` and `poolRange(size)` wrap inside the block and skip
  bound ports; they throw only when the whole block is busy. Each port is also claimed across
  processes with an exclusive file under `$TMPDIR/iter8-port-claims/` (dead owners' claims are
  reclaimed), so concurrent `bun test` runs do not collide. Rig and test cleanup uses `try`/`finally`,
  never `using`, which dependency-cruiser's parser rejects.
- `harness/rig/wait.ts` — `waitFor(label, read, { timeoutMs, everyMs })`; the only way to wait.
- `harness/rig/scratch.ts` — `scratchDir(prefix)` returns `{ path, dispose }`; every temp dir a test
  makes comes from here and is disposed by its creator.
- `harness/rig/home.ts` — `throwawayHome()`: a `Scratch` under a short `/tmp/iter8-w{worker}-` root,
  because macOS temp paths push a control socket past the 104-byte `sun_path` limit.
- `harness/rig/browser.ts` — `launchChromium({ args })` (headless, no flags of its own), `newPage`.
- `harness/rig/long-task.ts` — `startLongTaskProbe(page)`; `.stop()` reports the longest main-thread
  task after start. The typing budget is ≤ 250 ms. A test asserting any wall-clock budget lives in
  a `*.budget.test.ts` file, which `bun run test` runs alone after the parallel run: a long task is
  wall time, and on CI's 4-core runner three other Chromiums sharing the CPU turned one into 480 ms.
- `harness/rig/cli.ts` — `runCli(env, args)`, `cliCommand(binary?)`: a given binary, else
  `ITER8_TEST_BINARY`, else `bun apps/iter8/src/main.ts`.
- `harness/rig/service.ts` — `startService({ binary })` on a throwaway home and pool;
  `openThroughProxy(service, page, target, { session } | { owner })` returns `{ open, token }`.
- `harness/rig/agent.ts` + `harness/stubs/agent-session.ts` — `startAgentSession(service)`: a real
  long-lived process standing in for Claude Code; prompt, stop, clear, exit, crash, `run(args)`,
  `runHook({ command, input, env, timeoutMs })`, `hookInput(event, extra)`.
- `harness/rig/fixtures.ts` — `startFixture(name)` (waits for readiness, stops the process group),
  `buildFixture(name)`, `HEAVY_PAGE`, `MANIFEST`; `fixtures/manifest.json`.
  Next fixtures get a per-start `distDir` and scratch prefixes (`SCRATCH_ROOT` in `scratch.ts`) carry
  the pid, so concurrent runs don't collide.
- `harness/rig/bundle.ts` — `buildBrowserBundle(entry)`.
- `harness/stubs/mock-service.ts` — `startMockService({ folder, overlayDir, … })`: the overlay API
  over a built folder; controls `setPairing`, `setLiveSessions`, `push`, `draft()`, `rounds()`,
  `prefs()`, `requests()`, `clientMessages()`, `failNextSend`, `stop`.
- `harness/stubs/probe-overlay.ts` — an exported-`mount` overlay exposing `window.__iter8Probe`
  for service scenarios.
- `harness/stubs/fake-cli.ts` — a recording stand-in for the `iter8` CLI.
- Fixture targets carry `data-source-target="<name>"` on the same source line as the element's
  opening tag, with visible text unique on the page and literal on that line.

## `*.localhost` check (2026-10-10)
`harness/scenarios/foundation/localhost-hostnames.test.ts` passed in headless Chromium 156
(Playwright chromium-headless-shell 1248) with no browser flags: `*.localhost` resolved to loopback
with the Host header intact, was a secure context (`crypto.randomUUID`, service workers), carried
WebSockets, and kept cookies, `localStorage` and service workers separate per hostname. Helium on
the laptop is a manual check the suite cannot make.

## Conventions
- Where new integration tests live: beside the code (`*.test.ts`); scenario tests under `harness/scenarios/<part>/`
- Where new shared helpers/fixtures go: `harness/rig/`, `harness/stubs/`, `fixtures/`
- Start the cheapest fixture that proves the behaviour: the static folder or the Vite + React app.
- No fixed ports, no `~/.iter8`, no real `claude` turn; ports, state dirs and browsers come from
  `harness/rig/`.
- A test removes every temp dir and stops every process it started; one day of leaked scratch
  filled a 16 GB `/tmp`.

## Policy
- Integration tests required for behavior changes: yes
- Integration test command: `bun run test`
- Test Adversary check: strict
