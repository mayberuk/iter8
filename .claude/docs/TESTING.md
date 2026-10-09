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
- Gate: `bun run check`
- Scoped: `bun test <path>` — always name the paths; a bare `bun test` is not the gate.

## Harness Inventory
- _(populated as the foundation part lands `harness/rig/` and `harness/stubs/`)_

## Conventions
- Where new integration tests live: beside the code (`*.test.ts`); scenario tests under `harness/scenarios/<part>/`
- Where new shared helpers/fixtures go: `harness/rig/`, `harness/stubs/`, `fixtures/`
- Start the cheapest fixture that proves the behaviour: the static folder or the Vite + React app.
- No fixed ports, no `~/.iter8`, no real `claude` turn; ports, state dirs and browsers come from
  `harness/rig/`.

## Policy
- Integration tests required for behavior changes: yes
- Integration test command: `bun run test`
- Test Adversary check: strict
