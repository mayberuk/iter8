# Engineering canon

Agent-built codebases rot through invented abstraction and hand-authored types, not through
style. These rules keep every module the size of its real job.

## Always
- Treat the project's seams as decided: the overlay↔service protocol (`packages/protocol`), the
  CLI surface, and the agent-adapter boundary (an opaque owner id; the Claude Code layer supplies
  identity, wake and pull). A phase that wants a new seam proposes it to the plan with the second
  concrete consumer named; it does not add one.
- Write the code inline the first time, duplicate it the second, extract it the third.
- Call a dependency directly until the second call site exists.
- Derive types from Zod at every boundary (`z.infer`); parse external data with plain
  `z.object`, which drops unknown keys in Zod 4, so nothing unexpected reaches the interior.
- Derive a variant of a schema — a request body, a socket message, a CLI JSON row — with `.pick`,
  `.omit`, `.partial`, `.extend`, or shape spread from the canonical schema, one level deep. A chain
  of derivations, or a second `z.object` describing the same data, is a new type in disguise.
- Put a type next to the function that creates the data; move it only when a second module
  imports it.
- Use `type` for data and `z.enum` for closed sets. Reserve `interface` for something implemented
  by more than one thing.
- Brand identifiers that cross a process boundary (page id, round id, note id, owner id, pairing
  generation) — the one place a type is authored rather than derived.
- Make illegal states unrepresentable: a round's or a pairing's state is a discriminated union,
  and a transition is one function that takes the old state and returns the new one.
- Enforce mechanically what can be enforced mechanically: `tsc` strict with
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, Biome, knip, dependency-cruiser.
  A prose rule exists only for judgment calls.

## Never
- An interface, base class, or "provider" with one implementation.
- A wrapper module around a library used in one place.
- A custom error hierarchy, `Result` type, event emitter, retry policy, plugin system, or feature
  flag that no recorded decision asked for.
- A `utils/`, `helpers/`, `common/`, `lib/`, or `types.ts` dump.
- `any`, TS `enum`, module-level mutable state, or type-level gymnastics (conditional and mapped
  types) that do not delete real code.
- A hand-written type mirroring a protocol message, a config file, or a schema.
- `z.looseObject` on external data; `.merge`, `.strip`, `.passthrough`, `.strict` (deprecated in
  Zod 4 — use `.extend`, shape spread, `z.object`, `z.strictObject`).
- Configurability nobody asked for: an option, env var or CLI flag earns its place when a recorded
  decision or a test needs a second value.

```ts
// ✅ DO — the schema is the type; the id is branded because it crosses the service boundary
export const RoundId = z.string().min(1).brand<"RoundId">()
export const Round = z.object({ id: RoundId, pageId: PageId, notes: z.array(Note), state: RoundState })
export type Round = z.infer<typeof Round>
const RoundPointer = Round.pick({ id: true, pageId: true })   // a projection, not a twin

// ❌ DON'T — a twin schema, an authored type, an interface for one store
const RoundSummary = z.object({ id: z.string(), pageId: z.string() })
interface RoundStore { save(r: RoundDto): Promise<void> }
class SqliteRoundStore implements RoundStore { /* the only implementation */ }
```

Why: every one of the "never" items is something an agent adds to feel safe, and each one is a
second place the truth can drift from.
