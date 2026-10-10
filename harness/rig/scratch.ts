import { mkdtemp, rm } from "node:fs/promises"

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
