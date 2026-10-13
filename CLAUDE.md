# iter8

Point at a running web page, mark it up, and hand the round of notes to the Claude Code session that owns the page.

The design is settled and recorded in `docs/design/` — read `docs/design/README.md` first. `requirements.md` holds the hard constraints and dealbreakers; `brainstorm.md` holds every decision and the review-forced decisions that bind the build. Do not re-open a recorded decision without saying which one and why.

The Claude Code plugin that drives iter8 lives in `/home/biruk/dev/cc-plugins/plugins/iter8/`, not here.

## Layout
```
apps/iter8/          the one Bun binary `iter8`: the per-machine service, the app proxy, the CLI
apps/overlay/        the Preact overlay, built to one script the service injects into pages
packages/protocol/   Zod schemas every side shares: overlay↔service API, rounds, notes, pairing, CLI JSON
packages/source/     in-page element → source adapters (React via bippy, Svelte, Vue, Astro)
harness/rig/         starts the real service, fixture apps and Chromium for scenario tests
harness/stubs/       stand-ins for what the gate cannot run for real: an agent session, a mock service
harness/scenarios/   scenario tests, one folder per part
fixtures/            the fixture apps: static HTML folder, Vite + React, Next (Turbopack and webpack),
                     SvelteKit, Vue, Astro
playground/          the permanent test site: Vite + React + Tailwind app plus a static mock/
scripts/             the gate and the release build
```
Nothing else becomes a package until a second app imports it. `packages/source` is the one
exception made on purpose: it carries its own per-framework test matrix.

## Rules — `.claude/rules/`
- **Engineering canon** — decided seams, no one-off abstraction, types from Zod. `engineering.md`
- **Stack** — the approved library per job, exact pins, `ctx7` first. `stack.md`
- **Testing** — unit, integration and scenario layers; the rig; no Biruk-as-QA. `testing.md`
- **Protocol** (`packages/protocol/**`) — Zod only, JSON-safe, versioned, fixtures. `protocol.md`
- **Overlay** (`apps/overlay/**`, `packages/source/**`) — the performance and isolation rules. `overlay.md`
- **File safety** — no recursive force delete. `file-safety.md`

Comments, verification, communication and MR conventions are governed by the global rules in
`~/.claude/CLAUDE.md` and `~/.claude/rules/`; nothing here overrides them.

## Constraints that are dealbreakers, not preferences
- A round never silently reports to nothing: a page whose session is gone says so before Send.
- Annotating never lags the page or delays a keystroke.
- Claude Code is reached only through stable surfaces: hooks, skills, commands and mods (on by default since Claude Code 2.1.287; iter8's mod needs 2.1.296+).
- Hooks never inject note content into a session, only a neutral pointer to the round; a page-chat message reaches the session only through the mod, inside the fenced, page-labelled `<page-message>` block.
- Service and proxies bind loopback; every overlay call carries the page's capability token.
