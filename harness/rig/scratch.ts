import { mkdtemp, rm } from "node:fs/promises"
import { WORKER } from "./ports"

// The pid keeps concurrent `bun test` processes apart: each numbers its workers from 1.
export const SCRATCH_ROOT = `/tmp/iter8-w${WORKER}-p${process.pid}-`

export type Scratch = {
  path: string
  /** Removes `path` and nothing else; safe to call more than once. */
  dispose: () => Promise<void>
}

/** Creates a fresh directory named from `prefix`; only its creator can dispose it. */
export async function scratchDir(prefix: string): Promise<Scratch> {
  const path = await mkdtemp(prefix)
  return { path, dispose: () => rm(path, { recursive: true, force: true }) }
}
