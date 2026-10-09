---
paths:
  - packages/protocol/**
---
# Protocol (`packages/protocol`)

The overlay, the service, the CLI and every agent adapter speak one vocabulary. This package is
that vocabulary; a message that does not parse here does not exist.

## Always
- Define every message, round, note, pairing and CLI JSON shape as a Zod schema; export the
  schema and its `z.infer` type together under one name; define the branded ids here and nowhere
  else.
- Carry a `PROTOCOL_VERSION` constant; the service and the overlay exchange it in their handshake,
  and a change to a field's meaning or requirement bumps it in the same change.
- Keep shapes JSON-safe: what crosses the wire is plain data, so a parsed value round-trips
  through `JSON.stringify` unchanged.
- Mark captured page data (DOM text, console errors, styles, source leads) as its own schema,
  separate from the notes Biruk or an agent wrote, so nothing downstream can mix the two.
- Keep `fixtures/*.json` for every message kind, plus one per degraded state (stale capture,
  unresolved anchor, no source lead); one test parses every fixture with its schema.

## Never
- `z.transform`, `z.date`, `z.map`, `z.set`, `z.custom`, or defaults that change the parsed
  shape — the other side of the wire only ever sees JSON.
- Import from `apps/*` or `packages/source`; the protocol depends on Zod and nothing else.
- A test double, server or client in this package; those live in `harness/`.

```ts
// ✅ DO — schema, type and brand from one definition
export const NoteId = z.string().min(1).brand<"NoteId">()
export const Note = z.object({ id: NoteId, author: NoteAuthor, intent: Intent, body: z.string() })
export type Note = z.infer<typeof Note>

// ❌ DON'T — a transform the wire cannot carry, and a hand-written twin
export const Note = z.object({ at: z.string().transform((s) => new Date(s)) })
export interface NoteDto { id: string; at: Date }
```
