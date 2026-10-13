# Stack

One language, one toolchain, one schema. Each pick and its rejected alternatives are recorded in
`docs/design/brainstorm.md`.

| Job | Use | Not |
|---|---|---|
| Runtime, package manager, binary | Bun, pinned in `packageManager`; `bun build --compile` for `linux-x64` and `darwin-arm64` | Node, npm, pnpm |
| Service API (overlay↔service, live socket) | Hono 4.13.x; `zValidator` on routes; `hc` typed client | Elysia, Express, tRPC |
| App proxy and HMR socket bridge | `Bun.serve` + `fetch` + `HTMLRewriter`, written by hand | http-proxy, a framework router in front of app traffic |
| Overlay UI | Preact 11 + `@preact/signals`, rendered into a shadow root | React, Solid, Lit, vanilla DOM building |
| Overlay build | `Bun.build` to one script the service serves | Vite (the overlay is one injected script, not an app) |
| Screenshots | `modern-screenshot` (`domToCanvas`) on a crop capped at two viewports and 300 nodes, after the composer paints | `html2canvas`, `html-to-image`, a whole-page render |
| React element → source | `bippy` 0.7.3 | `element-source` 0.0.5, LocatorJS, click-to-component |
| Markdown in agent messages | `markdown-to-jsx` 9.10.3, `parser` and `RuleType` from `markdown-to-jsx/html` only, `disableParsingRawHTML`, rendered to Preact VNodes by our own renderer in `Markdown.tsx` | marked or markdown-it (string out, so `innerHTML`; marked needs DOMPurify, +30 KB), micromark or unified (72 ms for a 32 KB message at 4×, over the 50 ms task budget), md4x (wasm, so a CSP risk on pages that send `script-src` without `wasm-unsafe-eval`), streamdown (React peers); `dangerouslySetInnerHTML` anywhere |
| Code highlighting in messages | `sugar-high` 2.5.0, `sugar-high/core` plus per-language `sugar-high/lang/*` imports | shiki (+96 KB gzip at best and 138 ms on first use at 1×, one long task), lowlight (+24 KB gzip for better but not needed accuracy); the full `sugar-high` registry import |
| Source-map symbolication (service) | `@jridgewell/trace-mapping` | `source-map`, `source-map-js` |
| HTML parsing with source locations (service) | parse5 8.0.1 | a hand-written tokeniser, HTMLRewriter (no offsets), htmlparser2 (not spec tree-building) |
| Validation, schema | Zod 4 | TypeBox, yup, hand-written guards |
| Store | `bun:sqlite`, one file under the state dir, numbered SQL migrations | JSON files written by hand, an ORM |
| CLI parsing | citty | commander, yargs |
| Logging | pino, JSON lines to the service's log file | `console.log` outside a CLI's own output |
| Lint, format | Biome | ESLint, Prettier |
| Dead code, boundaries | knip, dependency-cruiser | — |
| Tests | `bun test`; fast-check for invariants; Playwright driving Chromium for anything in a browser | Jest, Vitest, a DOM emulator for overlay behaviour |
| Phases that drive Chromium or a fixture dev server | pinned `engine="claude"` in the spec | the Codex sandbox, which cannot reach the Playwright browser path or write a temp dir there |
| Dates | `Intl.*` | dayjs, date-fns |
| Playground styling | Tailwind 4.3.3 through `@tailwindcss/vite`, in `playground/` only | Tailwind in `apps/` or `packages/` (the overlay's CSS lives in its shadow root) |

## Always
- Pin exact versions (no `^` or `~`); commit `bun.lock`.
- Ground library code with `npx ctx7@latest` before writing it (global rule
  `~/.claude/rules/context7.md`); versions in this table are targets to verify, not facts.
- Add a dependency only when the plan names it or a row above says so; an unlisted dependency is
  a proposal to the plan, not an install.

## Never
- Install a second library for a job that already has a row.
- Add a Node-only API or a `node_modules` binary the compiled Bun binary cannot embed.

Why: iter8 ships as one compiled binary on two machines; drift has to be impossible on our side
for "the same version on both ends" to stay true.
