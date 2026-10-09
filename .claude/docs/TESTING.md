# Testing — iter8

How tests are written and judged here is `.claude/rules/testing.md`; this file holds the commands
and the harness inventory.

## Setup
- Bun 1.4.2 and Node 22.12+ (the fixture apps' dev servers run under Node).
- `bun install --frozen-lockfile`, then `bun run setup:browsers` for the pinned Playwright Chromium.
- `bun run build` before any scenario that needs the built binary (`dist/iter8`) or the bundles
  (`dist/overlay/`).

## Test Commands
- Precheck: `bun run typecheck && bun run lint`
- Unit: `bun run knip && bun run depcruise && bun test packages scripts`
- Gate: `bun run check`

Integration test command: `bun run test`
Integration tests required for behavior changes: yes
- Scoped: `bun test <path>` — always name the paths; a bare `bun test` is not the gate.

## Conventions the gate does not enforce
- Start the cheapest fixture that proves the behaviour: the static folder or the Vite + React app.
- Scenario files live under `harness/scenarios/<part>/`.
- No fixed ports, no `~/.iter8`, no real `claude` turn; ports, state dirs and browsers come from
  `harness/rig/`.
