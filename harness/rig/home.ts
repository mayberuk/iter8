import { SCRATCH_ROOT, type Scratch, scratchDir } from "./scratch"

export async function throwawayHome(): Promise<Scratch> {
  return scratchDir(`${SCRATCH_ROOT}`)
}
